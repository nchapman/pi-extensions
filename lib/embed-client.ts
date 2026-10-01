/**
 * Embed client — the parent-side handle to the embed worker child.
 *
 * Owns the child's lifecycle and the JSONL protocol. Every request is
 * fail-open: timeouts, child death, and protocol errors resolve `undefined`
 * (never reject, never throw) so recall's search path degrades to lexical
 * instead of erroring — the vector side is a booster, not a dependency. A
 * fatal child (model load failure) disables the client for the rest of the
 * session after `maxStartAttempts` spawn attempts; every disable surfaces as
 * exactly one diagnostic line through `onNotice`.
 *
 * Requests write fire-and-forget: Node streams buffer writes in memory until
 * the pipe drains, so ordering and delivery are guaranteed — backpressure
 * costs parent RAM, never correctness, and batches are bounded by the
 * caller's catch-up budget.
 */

import { spawn } from "node:child_process";
import { EMBED_DIMS } from "./vecstore";

/** The slice of ChildProcess the client touches — injectable for tests. */
export interface WorkerChild {
  stdin: { write(data: string): boolean; end(): void };
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "exit" | "error", cb: (code: number | null) => void): void;
  kill(): void;
}

/** The one embedding model — jina v5-text-nano (retrieval adapter). */
export const EMBED_MODEL = "jinaai/jina-embeddings-v5-text-nano-retrieval";
/** The model card's retrieval prompt format: queries and documents are prefixed differently. */
const QUERY_PREFIX = "Query: ";
const DOC_PREFIX = "Document: ";

export type SpawnFn = (workerPath: string, env: NodeJS.ProcessEnv) => WorkerChild;

const defaultSpawn: SpawnFn = (workerPath, env) => {
  const child = spawn(process.execPath, [workerPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  // Streams emit async errors (EPIPE when the child dies mid-write); an
  // unhandled 'error' would crash the host. The exit handler owns reporting.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event, cb) => {
      child.on(event, cb as never);
      // Async spawn/kill failures (EMFILE, resource exhaustion) surface as an
      // 'error' event instead of 'exit' — route them into the exit path so
      // pending requests settle; a later real 'exit' is a harmless double.
      if (event === "exit") child.on("error", () => (cb as (code: number | null) => void)(null));
    },
    kill: () => child.kill(),
  };
};

interface PendingRequest {
  settle: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Rolling tail of child stderr for diagnostics (bounded). */
const STDERR_TAIL_BYTES = 4096;

export interface EmbedClientOptions {
  workerPath: string;
  dtype: string;
  modelDir: string;
  spawnFn?: SpawnFn;
  onNotice?: (message: string) => void;
  maxStartAttempts?: number;
  queryTimeoutMs?: number;
  embedBaseTimeoutMs?: number;
  embedPerItemMs?: number;
  /** Kill the worker after this long without a request (default 10 min; 0 disables). Bounds the model's residency through idle or hung sessions — respawn is a ~1s warm load. */
  idleTimeoutMs?: number;
}

export class EmbedClient {
  private child: WorkerChild | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startAttempts = 0;
  private givenUp = false;
  private killedByUs = false;
  private stdoutBuffer = "";
  private stderrTail = "";
  private fatalNoticed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly opts: EmbedClientOptions;
  constructor(opts: EmbedClientOptions) {
    this.opts = opts;
  }

  /** True while a child is alive and this client hasn't permanently given up. */
  get available(): boolean {
    return !this.givenUp && this.child !== null;
  }

  /** Spawn the worker if needed. False when permanently disabled. */
  start(): boolean {
    if (this.disposed || this.givenUp) return false;
    if (this.child !== null) return true;
    const max = this.opts.maxStartAttempts ?? 3;
    if (this.startAttempts >= max) {
      this.giveUp("embed worker failed to start; semantic search disabled for this session");
      return false;
    }
    this.startAttempts++;
    let child: WorkerChild;
    try {
      child = (this.opts.spawnFn ?? defaultSpawn)(this.opts.workerPath, {
        ...process.env,
        PI_RECALL_EMBED_DTYPE: this.opts.dtype,
        PI_RECALL_MODEL_DIR: this.opts.modelDir,
      });
    } catch (err) {
      this.notice(`embed worker spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      if (this.startAttempts >= max) {
        this.giveUp("embed worker failed to start; semantic search disabled for this session");
        return false;
      }
      return this.start();
    }
    this.child = child;
    this.killedByUs = false;
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("exit", (code) => this.onExit(code));
    this.armIdleTimer();
    return true;
  }

  /** Re-arm the idle-exit timer; every request and spawn pushes it back. */
  private armIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    const ms = this.opts.idleTimeoutMs ?? 10 * 60 * 1000;
    if (ms <= 0 || this.child === null) return;
    this.idleTimer = setTimeout(() => {
      // Silent by design: idle exit is lifecycle, not failure. The next
      // request lazily respawns (~1s warm model load).
      this.kill();
    }, ms);
    this.idleTimer.unref?.();
  }

  /** Query embedding (short text, query-prefixed per the model preset). Undefined = fail open. */
  async query(text: string): Promise<Float32Array | undefined> {
    const reply = await this.request(
      { op: "query", id: 0, text: QUERY_PREFIX + text },
      this.opts.queryTimeoutMs ?? 5000,
    );
    if (reply === undefined || !Array.isArray(reply.vector)) return undefined;
    if (reply.vector.length !== EMBED_DIMS) {
      // A wrong-width query can only mean the loaded model isn't the one
      // configured — surface it rather than scoring garbage downstream.
      this.notice(
        `embed query returned a ${reply.vector.length}-wide vector but ${EMBED_DIMS} was expected — is the worker running ${EMBED_MODEL}?`,
      );
      return undefined;
    }
    return Float32Array.from(reply.vector as number[]);
  }

  /** Document embeddings for chunk texts. Undefined = fail open (nothing persisted). */
  async embed(
    items: readonly { key: string; text: string }[],
  ): Promise<Array<{ key: string; vector: Float32Array }> | undefined> {
    if (items.length === 0) return [];
    const timeout = (this.opts.embedBaseTimeoutMs ?? 10_000) + items.length * (this.opts.embedPerItemMs ?? 2000);
    const prefixed = items.map((item) => ({ key: item.key, text: DOC_PREFIX + item.text }));
    const reply = await this.request({ op: "embed", id: 0, items: prefixed }, timeout);
    if (reply === undefined || !Array.isArray(reply.items)) return undefined;
    // Malformed items are dropped, never thrown — the never-reject contract
    // holds even against a buggy worker; dims must match the store's format.
    const out: Array<{ key: string; vector: Float32Array }> = [];
    for (const item of reply.items as Array<{ key?: unknown; vector?: unknown }>) {
      if (typeof item?.key !== "string" || !Array.isArray(item.vector) || item.vector.length !== EMBED_DIMS) continue;
      out.push({ key: item.key, vector: Float32Array.from(item.vector as number[]) });
    }
    if (out.length === 0) {
      // Items existed but every one was dropped for width: the configured dims
      // don't match the loaded model. Without this line the misconfiguration is
      // invisible — catch-up would retry the same dead batch forever, silently.
      const replies = reply.items as Array<{ vector?: unknown }>;
      if (replies.length > 0)
        this.notice(
          `embed reply dropped all ${replies.length} items: vectors are ${
            Array.isArray(replies[0]?.vector) ? replies[0].vector.length : "?"
          }-wide but ${EMBED_DIMS} was expected — is the worker running ${EMBED_MODEL}?`,
        );
      return undefined;
    }
    return out;
  }

  /** Kill AND refuse every later request. Unlike kill(), no lazy respawn is possible afterwards — without this, an in-flight catch-up whose request lands after session_shutdown would respawn the worker, and its pipes would hold the host's event loop open forever. */
  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  /** Stop the worker and settle everything in flight. Idempotent. */
  kill(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child === null) return;
    this.killedByUs = true;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // Already-dead children can throw on kill — nothing left to do.
    }
    this.child = null;
    // Spawn attempts are NOT reset here: a session replacement gets a fresh
    // budget when the new worker proves health ("ready"), while crash/fatal
    // loops stay bounded by maxStartAttempts.
  }

  private notice(message: string): void {
    this.opts.onNotice?.(message);
  }

  private giveUp(message: string): void {
    this.givenUp = true;
    this.notice(message);
  }

  /** Send one request and resolve its reply object, or undefined on timeout/death/error. */
  private async request(op: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    // A disposed client never respawns — the host is tearing down.
    if (this.disposed) return undefined;
    if (this.child === null && !this.start()) return undefined;
    const child = this.child;
    if (child === null) return undefined;
    const id = this.nextId++;
    op.id = id;
    return new Promise<Record<string, unknown> | undefined>((resolve) => {
      const settle = (value: Record<string, unknown> | undefined) => {
        clearTimeout(this.pending.get(id)?.timer);
        this.pending.delete(id);
        this.armIdleTimer(); // a request just finished — the worker is earning its keep
        resolve(value);
      };
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      timer.unref?.();
      this.pending.set(id, { settle: settle as (value: unknown) => void, timer });
      child.stdin.write(`${JSON.stringify(op)}\n`);
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line === "") continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-protocol output on stdout — ignore rather than break the stream
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.ev === "fatal") {
      if (!this.fatalNoticed) {
        this.fatalNoticed = true;
        this.notice(`embed worker fatal: ${String(msg.message ?? "unknown")}`);
      }
      this.kill(); // worker exits on its own; kill() clears our handle and settles pending below
      this.onExit(1);
      return;
    }
    // Health evidence: the worker loaded a model, so earlier spawn failures
    // were transient — arm a fresh respawn budget (fatal loops stay bounded).
    if (msg.ev === "ready") this.startAttempts = 0;
    const id = typeof msg.id === "number" ? msg.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    if (msg.ev === "error") {
      this.notice(`embed worker request failed: ${String(msg.message ?? "unknown")}`);
      pending.settle(undefined);
      return;
    }
    pending.settle(msg); // "query" / "embed" replies carry their payload
  }

  private onExit(code: number | null): void {
    this.child = null;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.settle(undefined);
    }
    this.pending.clear();
    if (!this.killedByUs) {
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
      this.notice(`embed worker exited (code ${code ?? "?"})${tail === "" ? "" : `: ${tail}`}`);
    }
  }
}
