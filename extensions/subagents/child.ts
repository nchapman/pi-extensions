/** The child runner: spawning pi as a subprocess, streaming its JSON event
 * output (text partials + usage accounting), the hard-timeout and idle
 * watchdogs, background adoption into the shared task registry, and the
 * bounded-concurrency driver for batch calls. */

import { spawn as nodeSpawn } from "node:child_process";
import { basename } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  type AdoptedHandle,
  type TaskRegistry,
  capResultText,
  formatSubagentWake,
  NEVER_ADOPT_MS,
} from "../../lib/superbash";
import { extractAssistantText } from "./agents";

/** The standard built-in tool set recognized and filterable by subagents. */
export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** Default idle watchdog: a child waiting on its LLM this long without a
 * single stdout event is a dead request, not a slow one — exported so tests
 * and docs pin the contract. Tool executions are exempt (see runChild). */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The binary child agents run as. Children must match the parent's agent
 * binary: a pi-bolt parent spawning PATH `pi` would run every subagent on
 * stock pi — correct, but slower to start and a different runtime to compare
 * against — so when the parent executable is pi-bolt itself (`pi-bin` beside
 * the macOS launcher, or the `pi-bolt` wrapper), the child command is that
 * same executable. `PI_SUBAGENT_BIN` overrides both (path to any pi-compatible
 * binary). Detection is basename-only on purpose: a substring match would
 * misfire on a node/bun living under a directory named like pi-bolt.
 */
export function resolveChildCommand(env: NodeJS.ProcessEnv, execPath: string): string {
  const override = env.PI_SUBAGENT_BIN?.trim();
  if (override) return override;
  const base = basename(execPath)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (base === "pi-bin" || base === "pi-bolt") return execPath;
  return "pi";
}
const DEFAULT_CONCURRENCY = 4;
const STDERR_TAIL_MAX = 8 * 1024;
const STDOUT_BUF_MAX = 1024 * 1024;

/** In-memory definition of an agent parsed from markdown frontmatter or inline config. */
export interface AgentDef {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model?: string;
  thinking?: string;
}

/** Parse PI_SUBAGENT_TIMEOUT_MS: maximum milliseconds allowed for a child run before killing it. */
export function parseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PI_SUBAGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Idle watchdog for child runs: kill a child that has waited on its LLM
 * this long without a stdout event. Any numerically-zero spelling ("0",
 * "0.0", "00") disables (the sibling-knob convention); anything missing or
 * unparseable keeps the 5-minute default — a silent wait is the dead-request
 * signal, so bad input fails toward detection, not away from it. Milliseconds
 * and unclamped, deliberately matching PI_SUBAGENT_TIMEOUT_MS (the sibling
 * hard-timeout knob); the watchdog ticks at most every 100ms, so a window
 * at or below that kills on the first tick. */
export function parseIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PI_SUBAGENT_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (n === 0) return 0;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Resolve a run's idle window from its options: an explicit value wins
 * (0 = off), an omitted one keeps the on-by-default watchdog. Pure so tests
 * can pin both branches without racing real timers. */
export function resolveIdleTimeoutMs(options: Pick<RunChildOptions, "idleTimeoutMs">): number {
  return options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
}

/** Parse PI_SUBAGENT_CONCURRENCY: maximum parallel child processes executed during batch runs. */
export function parseConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PI_SUBAGENT_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
}

/** Narrow child process interface consumed by runChild, injected in tests. */
export interface ChildLike {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  kill(signal?: string): void;
}

/** Function type for spawning subagent child processes. */
export type SpawnFn = (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

/** Default process spawner using Node's child_process.spawn. */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as ChildLike;

/** Options passed to runChild configuring deadlines, watchers, adoption, and event streaming. */
export interface RunChildOptions {
  timeoutMs?: number;
  /** Kill the child when it has waited on its LLM this long without a stdout
   * event — on by default (DEFAULT_IDLE_TIMEOUT_MS, 5 minutes); 0 disables.
   * Stdout events (stream deltas, tool calls, tool results, retries) are the
   * child's heartbeat, but only while it is *between* tool executions: a
   * tool run in progress suspends the watchdog, because a long build or test
   * emits nothing while it works and is healthy — the hard timeout remains
   * the backstop there. What the window judges is the LLM wait itself: a
   * dead request (dropped connection, wedged provider stream) hangs silently
   * until killed. */
  idleTimeoutMs?: number;
  onUpdate?: (partial: AgentToolResult) => void;
  signal?: AbortSignal;
  /** Thinking level for the child (off…max). Resolved by the caller from
   * call param > agent definition > parent session; kept here rather than a
   * positional so runChild's signature stays stable. */
  thinking?: string;
  /** Soft threshold in ms: hand the still-running child to onAdopted instead of waiting.
   * Undefined (default) blocks to completion — the anti-churn default; only
   * background: true or PI_SUBAGENT_BG_AFTER_MS opts into adoption. */
  adoptAfterMs?: number;
  onAdopted?: OnAdopted;
}

/** What runChild hands to onAdopted when the soft threshold fires: the child's eventual outcome, plus a kill switch. Returns the task id embedded in the adoption marker. */
export type OnAdopted = (handle: AdoptedHandle<ChildRun>) => string;

/** runChild's result: the child's outcome, or a marker carrying the background task id. */
export type ChildOutcome = ChildRun | { adopted: true; id: string };

/** True when the error is an idle-watchdog kill — the transient "request died
 * silently" failure that callers may worth retrying, unlike other errors. */
export function isStalledError(reason: unknown): boolean {
  return reason instanceof Error && (reason as Error & { stalled?: boolean }).stalled === true;
}

/**
 * Children run on the agent definition's model when it pins one, else inherit
 * the parent chat's. Without inheritance a child falls back to pi's global
 * default — a different (and possibly metered) model than the conversation
 * that asked for the work. Deliberately not a per-call param: the caller has
 * no model catalogue in context and would be guessing at provider ids; model
 * choice belongs to the human-authored agent file (or the session), while
 * thinking — a closed, enumerable set — is the dial agents can reason about.
 */
export function resolveChildModel(
  agentModel: string | undefined,
  sessionModel: { provider?: string; id?: string } | null | undefined,
): string | undefined {
  if (agentModel) return agentModel;
  const provider = sessionModel?.provider;
  const id = sessionModel?.id;
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

/** pi's closed set of thinking levels (pi --help). Exported so tests and
 * agent-file authors can pin the contract. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Check whether a given thinking string matches one of the recognized pi thinking levels. */
export function isValidThinkingLevel(level: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(level);
}

/** Default thinking for delegated runs: focused subagent tasks rarely need
 * more than low, and a floor beats both copying a parent that happens to be
 * on high (every child slow) and leaving pi's per-model default (often off).
 * Raise it per call or in the agent file when the work is hard. */
export const DEFAULT_SUBAGENT_THINKING = "low";

/** The call's thinking param first, then the agent definition's level, then
 * the low default. Pi clamps unsupported levels per model, so the resolved
 * level is safe even when the child runs a different model. */
export function resolveChildThinking(param: string | undefined, agentThinking: string | undefined): string {
  return param ?? agentThinking ?? DEFAULT_SUBAGENT_THINKING;
}

/** Construct CLI argv array for launching a pi subprocess in print/json mode with isolated configuration. */
export function buildChildArgs(agent: AgentDef, task: string, model?: string, thinking?: string): string[] {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt",
    agent.instructions,
    "--tools",
    agent.tools.join(","),
  ];
  const effectiveModel = model ?? agent.model;
  if (effectiveModel) args.push("--model", effectiveModel);
  const effectiveThinking = thinking ?? agent.thinking;
  if (effectiveThinking) args.push("--thinking", effectiveThinking);
  args.push("--", task);
  return args;
}

/** What runChild resolves with: the child's final text plus its cumulative usage, when reported. */
export interface ChildRun {
  text: string;
  usage?: ChildUsage;
}

/** Required fields of pi-ai's Usage, as it appears on JSON-mode assistant messages. */
export interface ChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Subset of output, reported by providers that expose a reasoning breakdown. */
  reasoning?: number;
  /** Subset of cacheWrite with 1h retention (Anthropic). */
  cacheWrite1h?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function looksLikeUsage(u: unknown): u is ChildUsage {
  if (typeof u !== "object" || u === null) return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const optNum = (v: unknown) => v === undefined || num(v);
  const { cost } = u as { cost?: unknown };
  if (typeof cost !== "object" || cost === null) return false;
  const c = cost as ChildUsage["cost"];
  return (
    num((u as ChildUsage).input) &&
    num((u as ChildUsage).output) &&
    num((u as ChildUsage).cacheRead) &&
    num((u as ChildUsage).cacheWrite) &&
    num((u as ChildUsage).totalTokens) &&
    optNum((u as ChildUsage).reasoning) &&
    optNum((u as ChildUsage).cacheWrite1h) &&
    num(c.input) &&
    num(c.output) &&
    num(c.cacheRead) &&
    num(c.cacheWrite) &&
    num(c.total)
  );
}

/** Sum two usage records; optional fields carry through when either side reports them. */
function addUsage(a: ChildUsage, b: ChildUsage): ChildUsage {
  const opt = (x: number | undefined, y: number | undefined) => (x === undefined ? y : y === undefined ? x : x + y);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoning: opt(a.reasoning, b.reasoning),
    cacheWrite1h: opt(a.cacheWrite1h, b.cacheWrite1h),
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** Sum per-child run totals so batch results keep session cost accounting accurate; undefined when no child reported any. */
export function sumUsages(list: Array<ChildUsage | undefined>): ChildUsage | undefined {
  const valid = list.filter((u): u is ChildUsage => u !== undefined);
  return valid.length ? valid.reduce(addUsage) : undefined;
}

/** One-line usage for wake headers: "105 tokens (100 in / 5 out), $0.120". */
export function formatUsageLine(u: ChildUsage): string {
  const k = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  return `${k(u.totalTokens)} tokens (${k(u.input)} in / ${k(u.output)} out), $${u.cost.total.toFixed(3)}`;
}

/** The tool result when a child moves to the background: what happened, and
 * how the result is received. Wakes steer in — delivered as the parent's next
 * message at a turn boundary, even mid-run — so the notice says the result
 * arrives on its own and that sleep-polling is pure waste (the wake would
 * land when the sleep returns; the sleep just burns its whole duration). */
export function backgroundedNotice(agentName: string, id: string): string {
  return `Subagent "${agentName}" is still running — moved to the background (${id}). When it completes, its result is delivered to you automatically as your next message — even mid-run. If you have nothing else to do, end your turn: the wake re-engages you, so waiting is never your job. Never sleep or poll to wait, and don't arm a check-in just to wait — the result arrives on its own. Peek with task ${id}; stop it with task_kill ${id} if the result is no longer wanted. The hard timeout still applies.`;
}

/** Adopt a still-running child into the registry and wire its wake. Returns the task id. */
export function adoptSubagentTask(
  registry: TaskRegistry,
  agentName: string,
  handle: AdoptedHandle<ChildRun>,
  sessionDir: string | undefined,
): string {
  const id = registry.adopt({ name: agentName, kind: "subagent", kill: handle.kill });
  // Duration counts from the child's spawn, not its adoption.
  const startedAt = handle.startedAt;
  handle.completion.then(
    (run) => {
      const capped = capResultText(run.text, sessionDir, id);
      registry.complete(id, {
        ok: true,
        status: "completed",
        text: formatSubagentWake(agentName, id, {
          ok: true,
          durationMs: Date.now() - startedAt,
          text: capped.text,
          usageLine: run.usage ? formatUsageLine(run.usage) : undefined,
        }),
      });
    },
    (error: Error & { usage?: ChildUsage }) => {
      registry.complete(id, {
        ok: false,
        status: "failed",
        text: formatSubagentWake(agentName, id, {
          ok: false,
          durationMs: Date.now() - startedAt,
          text: error.message,
          usageLine: error.usage ? formatUsageLine(error.usage) : undefined,
        }),
      });
    },
  );
  return id;
}

/**
 * Execute a subagent task in an isolated pi child process.
 * Streams JSON events, monitors hard and idle deadlines, and optionally adopts into the task registry.
 */
// Two overloads: a literal without onAdopted stays typed as ChildRun; anything
// else — including a prebuilt options variable — gets ChildOutcome and narrows.
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions & { onAdopted?: undefined },
  spawnFn?: SpawnFn,
): Promise<ChildRun>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions,
  spawnFn?: SpawnFn,
): Promise<ChildOutcome>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions,
  spawnFn?: SpawnFn,
): Promise<ChildOutcome>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions = {},
  spawnFn: SpawnFn = defaultSpawn,
): Promise<ChildOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { onUpdate, signal } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // The heartbeat clock: every stdout chunk counts, whether or not it parses
    // into an event. Initialized at spawn so a child that never emits anything
    // is caught too.
    let lastActivityAt = startedAt;
    // Tool executions in flight, keyed by call id. Silence while a tool runs
    // is the tool working (a long build or test emits nothing between start
    // and end), not a dead LLM request — the watchdog stands down while any
    // execution is open. Ids rather than a count so a lost or duplicated end
    // line cannot corrupt the phase: an unmatched end is a no-op, and a
    // missing one is healed at the next assistant message_start (the child
    // only requests again after every tool of the turn has finished) or when
    // the stdout cap discards data — both fail toward detection, never away.
    const openToolRuns = new Set<string>();
    const child = spawnFn(
      resolveChildCommand(process.env, process.execPath),
      buildChildArgs(agent, task, model, options.thinking),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastText = "";
    let lastUsage: ChildUsage | undefined;
    let settled = false;
    // Adoption state: once the soft threshold fires, the outer promise has
    // resolved and every later event settles the completion promise instead.
    let adopted = false;
    let completionSettled = false;
    let completionResolve!: (run: ChildRun) => void;
    let completionReject!: (error: Error & { usage?: ChildUsage }) => void;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Failure paths still burned tokens: attach the spend so callers (the batch
    // sum) can credit it — the rejection alone would silently drop it.
    const rejectWith = (err: Error) => {
      if (lastUsage) Object.assign(err, { usage: lastUsage });
      reject(err);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as {
          type?: string;
          toolCallId?: string;
          message?: { role?: string; usage?: unknown; content?: unknown };
        };
        if (event.type === "tool_execution_start") {
          openToolRuns.add(event.toolCallId ?? "");
        } else if (event.type === "tool_execution_end") {
          openToolRuns.delete(event.toolCallId ?? "");
        } else if (event.type === "message_start" && event.message?.role === "assistant") {
          // A new assistant message means the previous turn's tools all
          // finished — heal any end line the stdout cap ate below.
          openToolRuns.clear();
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          // Each assistant message carries its request's final usage; summing them
          // mirrors pi's own session accounting (message_update resets per request).
          if (looksLikeUsage(event.message.usage)) {
            lastUsage = lastUsage ? addUsage(lastUsage, event.message.usage) : event.message.usage;
          }
          const text = extractAssistantText(event.message.content);
          if (text) {
            lastText = text;
            // Partials have nowhere to go once the tool result returned (adoption).
            if (!adopted) {
              onUpdate?.({
                content: [{ type: "text", text: lastText }],
                details: { agent: agent.name, status: "running" },
              });
            }
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > STDOUT_BUF_MAX) {
        // The discard can lose whole event lines — a >1MiB tool result makes
        // its own tool_execution_end the culprit — so the tool-phase
        // bookkeeping becomes unreliable: re-arm the watchdog.
        openToolRuns.clear();
        const nl = stdoutBuf.lastIndexOf("\n");
        stdoutBuf = nl >= 0 ? stdoutBuf.slice(nl + 1) : "";
      }
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > STDERR_TAIL_MAX) stderrBuf = stderrBuf.slice(-STDERR_TAIL_MAX);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`Subagent "${agent.name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
      // The hard timeout survives adoption: a backgrounded child still can't run forever.
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        if (lastUsage) Object.assign(error, { usage: lastUsage });
        completionReject(error);
      } else settle(() => rejectWith(error));
    }, timeoutMs);
    timeout.unref?.();

    // Idle watchdog: kill a child that has waited on its LLM past the
    // threshold without a single event, instead of burning the rest of the
    // hard timeout on a request that will never return. The clock only judges
    // LLM waits — a tool execution in progress stands it down (silence there
    // is healthy work; `timeoutMs` is the backstop). Survives adoption like
    // the hard timeout does; 0 opts out (the option is on by default).
    const idleMs = resolveIdleTimeoutMs(options);
    const stall = () => {
      child.kill("SIGKILL");
      const silentFor = Math.max(1, Math.round((Date.now() - lastActivityAt) / 1000));
      const error = new Error(
        `Subagent "${agent.name}" stalled: no output for ${silentFor}s (request likely dead)`,
      ) as Error & { stalled: true };
      error.stalled = true;
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        if (lastUsage) Object.assign(error, { usage: lastUsage });
        completionReject(error);
      } else settle(() => rejectWith(error));
    };
    // Check often enough to notice promptly, never more than 5s between ticks;
    // unref'd so a forgotten watchdog can't hold the process open.
    const watchdog =
      idleMs > 0
        ? setInterval(
            () => {
              if (settled && !adopted) return;
              if (openToolRuns.size > 0) return; // a tool is executing — silence is expected
              if (Date.now() - lastActivityAt >= idleMs) stall();
            },
            Math.max(100, Math.min(5_000, Math.floor(idleMs / 4))),
          )
        : undefined;
    watchdog?.unref?.();

    const onAbort = () => {
      child.kill("SIGKILL");
      settle(() => rejectWith(signal?.reason ?? new Error(`Subagent "${agent.name}" aborted`)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A signal aborted before registration never fires the listener — check
    // manually so an already-cancelled turn doesn't leave the child running.
    if (signal?.aborted) onAbort();

    // Soft threshold: hand the still-running child to onAdopted and resolve
    // immediately. The abort listener detaches — a backgrounded child survives
    // turn aborts — while stdout parsing and the hard timeout continue. A
    // throwing onAdopted falls back to the foreground failure contract.
    const adoptAfterMs = options.adoptAfterMs ?? NEVER_ADOPT_MS;
    // Infinity (the default) must never reach setTimeout — Node clamps it to
    // 1ms, which would adopt instantly instead of blocking to completion.
    const adoptTimer =
      options.onAdopted && Number.isFinite(adoptAfterMs)
        ? setTimeout(() => {
            if (settled) return;
            signal?.removeEventListener("abort", onAbort);
            const completion = new Promise<ChildRun>((resolveCompletion, rejectCompletion) => {
              completionResolve = resolveCompletion;
              completionReject = rejectCompletion;
            });
            let id: string;
            try {
              id = options.onAdopted!({ completion, kill: () => child.kill("SIGKILL"), startedAt });
            } catch (error) {
              // Fence later events out of the completion path, kill the child,
              // and fail the call — adoption never happened.
              completionSettled = true;
              child.kill("SIGKILL");
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
              return;
            }
            adopted = true;
            settle(() => resolve({ adopted: true, id }));
          }, adoptAfterMs)
        : undefined;
    adoptTimer?.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      clearTimeout(adoptTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    // Shared exit handling for the outer promise and an adopted child's
    // completion promise: success carries the final text and usage; failure
    // attaches the spend so callers can credit it.
    const finishClose = (
      code: number | null,
      fulfill: (run: ChildRun) => void,
      fail: (error: Error & { usage?: ChildUsage }) => void,
    ) => {
      if (code === 0) fulfill({ text: lastText || "(no output)", usage: lastUsage });
      else {
        const error = new Error(
          `Subagent "${agent.name}" exited with code ${code}: ${stderrBuf.slice(-500) || "no stderr"}`,
        );
        if (lastUsage) Object.assign(error, { usage: lastUsage });
        fail(error);
      }
    };

    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        finishClose(code, completionResolve, completionReject);
        return;
      }
      settle(() => {
        if (signal?.aborted) rejectWith(signal.reason ?? new Error(`Subagent "${agent.name}" aborted`));
        else finishClose(code, resolve, reject);
      });
    });
    child.on("error", (error) => {
      cleanup();
      const wrapped = new Error(`Failed to spawn pi for subagent "${agent.name}": ${error.message}`);
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        completionReject(wrapped);
        return;
      }
      settle(() => reject(wrapped));
    });
  });
}

/** Run jobs with bounded concurrency; results preserve input order. */
export async function runWithLimit<T>(
  jobs: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      try {
        results[i] = { status: "fulfilled", value: await jobs[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Collapse a task to a single display line, capped for tool-call rows. */
export function summarizeTask(task: string, max = 72): string {
  const oneLine = task.trim().replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}
