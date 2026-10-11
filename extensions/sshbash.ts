/**
 * sshbash — `ssh_bash`: the unified bash tool over SSH, with connection reuse.
 *
 * Design (the deliberate cuts):
 * - the transport is the system `ssh` with OpenSSH connection multiplexing
 *   (ControlMaster/ControlPath/ControlPersist): zero npm dependencies, and
 *   everything the machine already knows — ~/.ssh/config aliases, ssh-agent,
 *   ProxyJump, known_hosts — works unchanged. The first call to a destination
 *   pays the handshake; later calls multiplex over the master's socket in
 *   milliseconds with no re-auth. OpenSSH owns the master lifecycle (it
 *   self-expires PI_SSH_IDLE_SECS after the last call), so the extension
 *   holds no connection state to keep alive.
 * - control sockets live under <agentDir>/ssh/, exclusively ours — never the
 *   user's interactive masters. session_shutdown sends `ssh -O exit` per
 *   connection so nothing outlives the session deliberately; a crashed
 *   session's stray master is reaped by its own ControlPersist expiry (and a
 *   stale socket file is replaced by the next ControlMaster=auto call).
 * - auth is non-interactive by design (BatchMode=yes): a key/agent/config
 *   that cannot authenticate fails fast with ssh's stderr instead of hanging
 *   on a prompt no agent can answer. Exit 255 is ssh's own error convention;
 *   it is always reported as a connection failure carrying ssh's stderr (the
 *   ssh man page reserves 255 — a remote command that happens to exit 255 is
 *   indistinguishable and documented as lost to this rule).
 * - remote commands run in the login directory through the remote shell;
 *   there is no remote cwd — the command itself cds, like agents writing raw
 *   ssh today. Kills are local: task_kill/timeout terminate the local ssh
 *   client, which closes the channel and normally ends the remote command —
 *   but a fully detached remote process can survive. No remote tree kill.
 * - connection ids: each distinct destination (user@host:port — exactly what
 *   %C multiplexes on) gets a session-scoped handle ssh-1, ssh-2 …; the tool
 *   result names it, and later calls may pass it as target instead of
 *   repeating the destination. A different identity file against the same
 *   destination reuses the existing master's auth (the key only matters when
 *   creating the master).
 * - the tool reuses superbash's createBashTool wholesale (name/description/
 *   extraParams/prepare): every wait mode, wake, log, and task tool behaves
 *   exactly like bash. The shared task registry is read lazily per call so
 *   extension load order never matters; without it, inline still works and
 *   the background modes fail with an explicit error.
 * - Win32-OpenSSH has no multiplexing: ssh still runs there, but every call
 *   reconnects. Unix (macOS/Linux) is the intended host.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, getSharedTaskRegistry, piAgentDir, type BashToolCallParams } from "../lib/superbash";

export const SSH_TOOL_NAME = "ssh_bash";

/** Seconds a control master stays up after the last call (PI_SSH_IDLE_SECS). */
export const DEFAULT_SSH_IDLE_SECS = 600;
/** Bounded seconds for establishing the connection itself (PI_SSH_CONNECT_TIMEOUT). */
export const DEFAULT_SSH_CONNECT_TIMEOUT_SECS = 20;
/** Cap on the stderr tail carried into connection-failure errors. */
const STDERR_TAIL_CAP = 2_000;

export interface SshTarget {
  user?: string;
  host: string;
  port?: number;
  /** Identity file as passed (~ allowed); expanded at argv build. */
  key?: string;
}

/** Bounded int env knob: invalid or out-of-range values fall back, never throw. */
function parseBoundedInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export function parseSshIdleSecs(env: Record<string, string | undefined>): number {
  return parseBoundedInt(env, "PI_SSH_IDLE_SECS", DEFAULT_SSH_IDLE_SECS, 0, 86_400);
}

export function parseSshConnectTimeoutSecs(env: Record<string, string | undefined>): number {
  return parseBoundedInt(env, "PI_SSH_CONNECT_TIMEOUT", DEFAULT_SSH_CONNECT_TIMEOUT_SECS, 1, 300);
}

const HOST_KEY_MODES = new Set(["yes", "accept-new", "no"]);

/** Host-key policy (PI_SSH_STRICT_HOST_KEY): accept-new (TOFU) by default;
 * "yes" requires a pre-populated known_hosts entry, "no" disables checking. */
export function parseStrictHostKey(env: Record<string, string | undefined>): "yes" | "accept-new" | "no" {
  const raw = env.PI_SSH_STRICT_HOST_KEY?.trim().toLowerCase();
  return raw && HOST_KEY_MODES.has(raw) ? (raw as "yes" | "accept-new" | "no") : "accept-new";
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}

/**
 * Parse and validate a target param triple. Accepts user@host, bare host
 * (including ~/.ssh/config aliases), and ssh://user@host:port URIs; a port
 * param overrides a URI port.
 */
export function parseSshTarget(raw: string, port?: unknown, key?: unknown): { target?: SshTarget; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "target must not be empty" };
  if (/\s/.test(trimmed)) return { error: `target must not contain whitespace: "${trimmed}"` };
  if (port !== undefined && (!isValidPort(port as number) || typeof port !== "number")) {
    return { error: `port must be an integer 1-65535 (got ${String(port)})` };
  }
  if (key !== undefined && (typeof key !== "string" || key.trim() === "")) {
    return { error: "key must be a non-empty path to an identity file" };
  }
  const target: Partial<SshTarget> = {};
  if (key !== undefined) target.key = (key as string).trim();
  if (port !== undefined) target.port = port as number;
  if (trimmed.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { error: `invalid ssh:// URI: "${trimmed}"` };
    }
    if (!url.hostname) return { error: `target URI has no host: "${trimmed}"` };
    target.host = url.hostname.replace(/^\[|\]$/g, ""); // URI IPv6 brackets
    if (url.username) {
      try {
        target.user = decodeURIComponent(url.username);
      } catch {
        return { error: `invalid username in target URI: "${trimmed}"` };
      }
    }
    if (url.port && port === undefined) {
      const uriPort = Number(url.port);
      if (!isValidPort(uriPort)) return { error: `invalid port in URI: "${trimmed}"` };
      target.port = uriPort;
    }
  } else {
    const at = trimmed.lastIndexOf("@");
    if (at === -1) target.host = trimmed;
    else {
      target.user = trimmed.slice(0, at);
      target.host = trimmed.slice(at + 1);
      if (target.user === "" || target.host === "") return { error: `invalid target: "${trimmed}"` };
    }
  }
  if (!/^[a-zA-Z0-9._:[\]-]+$/.test(target.host) || target.host.startsWith("-")) {
    return { error: `invalid host: "${target.host}"` };
  }
  // The user and host become one argv element (`user@host`). OpenSSH's getopt
  // accepts -oVALUE fused options, so a user like `-oProxyCommand=…@host` would
  // be parsed as an ssh OPTION — and ProxyCommand executes locally. The strict
  // charset (no `-` prefix, no `=`/`$`/whitespace anywhere) makes that
  // unconstructible rather than merely filtered.
  if (target.user !== undefined && (!/^[A-Za-z0-9._-]+$/.test(target.user) || target.user.startsWith("-"))) {
    return { error: `invalid user in target: "${target.user}"` };
  }
  return { target: target as SshTarget };
}

/** The `[user@]host` string ssh receives as its destination argument. */
export function destinationArg(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/** Multiplex identity: user@host:port — exactly what ControlPath %C hashes. */
export function canonicalTargetKey(target: SshTarget): string {
  return `${target.user ? `${target.user}@` : ""}${target.host.toLowerCase()}:${target.port ?? 22}`;
}

function expandHome(path: string): string {
  // We spawn ssh directly (no local shell), so ~ never gets shell-expanded.
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export interface SshExecOptions {
  controlDir: string;
  idleSecs: number;
  connectTimeoutSecs: number;
  /** StrictHostKeyChecking value (see parseStrictHostKey). */
  strictHostKeyChecking: "yes" | "accept-new" | "no";
}

/** Full ssh argv for one remote command (argv-spawned: no local quoting). */
export function buildSshCommandArgs(target: SshTarget, command: string, opts: SshExecOptions): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(opts.controlDir, "cm-%C")}`,
    "-o",
    `ControlPersist=${opts.idleSecs}`,
    "-o",
    `ConnectTimeout=${opts.connectTimeoutSecs}`,
    "-o",
    `StrictHostKeyChecking=${opts.strictHostKeyChecking}`,
    "-o",
    "ServerAliveInterval=30",
  ];
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.key) args.push("-i", expandHome(target.key));
  args.push(destinationArg(target), command);
  return args;
}

/** The child-process boundary, as narrow as the operations need it. */
export interface SshProcess {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
export type SshSpawn = (command: string, args: string[]) => SshProcess;

const defaultSpawn: SshSpawn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as SshProcess;

/** Control sockets for this pi agent dir — exclusively ours. */
export function defaultControlDir(): string {
  return join(piAgentDir(), "ssh");
}

/**
 * SSH-backed BashOperations: exec spawns the local ssh client (multiplexed),
 * merges its stdout/stderr into onData like the local bash tool, and maps
 * outcomes onto the contract pi's tooling expects — resolve with the remote
 * exit code, reject Error("aborted") on abort, Error("timeout:<secs>") on
 * timeout, and a connection failure (exit 255, ssh's reserved convention)
 * carrying ssh's stderr tail.
 */
export function createSshBashOperations(
  target: SshTarget,
  opts: {
    spawnFn?: SshSpawn;
    controlDir?: string;
    idleSecs?: number;
    connectTimeoutSecs?: number;
    strictHostKeyChecking?: "yes" | "accept-new" | "no";
  } = {},
): BashOperations {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const controlDir = opts.controlDir ?? defaultControlDir();
  const idleSecs = opts.idleSecs ?? DEFAULT_SSH_IDLE_SECS;
  const connectTimeoutSecs = opts.connectTimeoutSecs ?? DEFAULT_SSH_CONNECT_TIMEOUT_SECS;
  const strictHostKeyChecking = opts.strictHostKeyChecking ?? "accept-new";
  let dirEnsured = false;
  return {
    exec: (command, _cwd, { onData, signal, timeout }) =>
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        // A signal already aborted before exec never fires its listener: the
        // command must not run at all (the superbash background path hands an
        // already-aborted controller straight to operations.exec).
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        // The socket dir is needed only when a master is created (first call
        // to a destination); a failure leaves ssh to error clearly.
        if (!dirEnsured) {
          try {
            mkdirSync(controlDir, { recursive: true });
          } catch {
            // ssh reports the unusable ControlPath itself
          }
          dirEnsured = true;
        }
        const args = buildSshCommandArgs(target, command, {
          controlDir,
          idleSecs,
          connectTimeoutSecs,
          strictHostKeyChecking,
        });
        let child: SshProcess;
        try {
          child = spawnFn("ssh", args);
        } catch (e) {
          reject(new Error(e instanceof Error ? e.message : String(e)));
          return;
        }
        let settled = false;
        let aborted = false;
        let timedOut = false;
        let stderrTail = Buffer.alloc(0);
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          aborted = true;
          killClient();
        };
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort); // a late abort must not arm the escalation timer
          if (killTimer) clearTimeout(killTimer);
          if (escalationTimer) clearTimeout(escalationTimer);
          settle();
        };
        // Local kill only: the client closing ends the channel, which
        // normally ends the remote command. Escalate past a wedged client.
        const killClient = () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone — close will fire
          }
          escalationTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, 2_000);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", (chunk) => {
          stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_CAP);
          onData(chunk);
        });
        child.on("error", (err) => finish(() => reject(new Error(err.message))));
        child.on("close", (code) => {
          if (aborted) return finish(() => reject(new Error("aborted")));
          if (timedOut) return finish(() => reject(new Error(`timeout:${timeout}`)));
          if (code === 255) {
            const detail = stderrTail.toString("utf8").trim() || "connection failed";
            return finish(() => reject(new Error(`ssh: ${detail} (${destinationArg(target)})`)));
          }
          finish(() => resolve({ exitCode: code }));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeout) {
          killTimer = setTimeout(() => {
            timedOut = true;
            killClient();
          }, timeout * 1_000);
        }
      }),
  };
}

export interface SshConnection {
  id: string;
  target: SshTarget;
  canonical: string;
}

/**
 * Session-scoped destination → handle book. resolve() is synchronous, so
 * parallel first-calls to one destination still get one connection; the id
 * and the canonical key are stable for the session's lifetime.
 */
export class SshConnectionBook {
  private byId = new Map<string, SshConnection>();
  private byCanonical = new Map<string, SshConnection>();
  private next = 1;

  resolve(
    rawTarget: unknown,
    port?: unknown,
    key?: unknown,
  ): { conn?: SshConnection; error?: string; reused?: boolean } {
    if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
      return { error: 'target is required: user@host, an ~/.ssh/config alias, or a connection id like "ssh-1"' };
    }
    const trimmed = rawTarget.trim();
    if (/^ssh-\d+$/.test(trimmed)) {
      const conn = this.byId.get(trimmed);
      if (!conn) return { error: `unknown connection ${trimmed}; pass the full destination again` };
      return { conn, reused: true };
    }
    const parsed = parseSshTarget(trimmed, port, key);
    if (parsed.error || !parsed.target) return { error: parsed.error ?? "invalid target" };
    const canonical = canonicalTargetKey(parsed.target);
    const existing = this.byCanonical.get(canonical);
    if (existing) {
      // Fold a newly supplied identity into the stored target: a first call
      // that failed to authenticate (no key) must not poison the retry — ssh
      // needs the key if the master was never created.
      if (parsed.target.key && existing.target.key !== parsed.target.key) {
        existing.target = { ...existing.target, key: parsed.target.key };
      }
      return { conn: existing, reused: true };
    }
    const conn: SshConnection = { id: `ssh-${this.next++}`, target: parsed.target, canonical };
    this.byId.set(conn.id, conn);
    this.byCanonical.set(canonical, conn);
    return { conn };
  }

  list(): SshConnection[] {
    return [...this.byId.values()];
  }
}

/** `root@1.2.3.4:13839 (key ~/.ssh/id_ed25519)` — the human/model-facing name. */
export function describeConnection(conn: SshConnection): string {
  const t = conn.target;
  return `${destinationArg(t)}${t.port !== undefined ? `:${t.port}` : ""}${t.key ? ` (key ${t.key})` : ""}`;
}

export function registerSshBashExtension(
  pi: ExtensionAPI,
  opts: { spawnFn?: SshSpawn; controlDir?: string } = {},
): void {
  const connections = new SshConnectionBook();
  const controlDir = opts.controlDir ?? defaultControlDir();
  const opsFor = (conn: SshConnection) =>
    createSshBashOperations(conn.target, {
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      controlDir,
      idleSecs: parseSshIdleSecs(process.env),
      connectTimeoutSecs: parseSshConnectTimeoutSecs(process.env),
      strictHostKeyChecking: parseStrictHostKey(process.env),
    });

  const tool = createBashTool(() => getSharedTaskRegistry(), {
    name: SSH_TOOL_NAME,
    label: "SSH bash",
    description: `Execute a shell command on a remote machine over SSH and get stdout/stderr. The connection is reused across calls (OpenSSH multiplexing): the first call to a destination pays the full handshake; later calls connect in milliseconds without re-authenticating. The command runs through the remote shell in the login directory — cd yourself as needed. Prefer this over bash with a raw ssh command for any remote machine.
target: user@host, host, an ~/.ssh/config alias, ssh://user@host:port, or a connection id (ssh-N) named in an earlier result; port and key refine it. Auth must be non-interactive (identity file, ssh-agent, or ssh config) — there are no password prompts; a destination that cannot authenticate fails fast with ssh's error.
wait and timeout behave exactly like the bash tool: inline (default) blocks until the command finishes; auto blocks ~2m then moves to the background; background returns a task id immediately and the result (exit status, duration, output tail) arrives as your next message — end your turn instead of sleeping or polling. Killing a task ends the local ssh client and normally the remote command too; a fully detached remote process can survive.`,
    promptSnippet: "Execute commands on a remote machine over SSH",
    promptGuidelines: [
      "Use ssh_bash (not bash + raw ssh) for remote machines: connections are multiplexed so repeated calls are cheap. Later calls can pass target: the connection id (ssh-1) an earlier result named.",
      "For long remote jobs (training runs, tailing logs), use wait: background and let the wake re-engage you — never sleep locally or re-poll in a loop; task_remind schedules a check if you need one.",
    ],
    extraParams: {
      target: Type.String({
        description:
          "Destination: user@host, host, ssh://user@host:port, an ~/.ssh/config alias, or a connection id (ssh-N) from an earlier call",
      }),
      port: Type.Optional(Type.Number({ description: "SSH port (default 22; a port in the target URI also works)" })),
      key: Type.Optional(
        Type.String({
          description: "Path to an identity file (~ allowed). Non-interactive auth only — no password prompts",
        }),
      ),
    },
    prepare: (params: BashToolCallParams) => {
      // The execute wrapper below validates target before the base tool runs,
      // so this resolve only supplies the connection; the head names the task
      // with the connection id so wakes and /tasks say which machine ran it.
      const { conn } = connections.resolve(params.target, params.port, params.key);
      const command = String(params.command ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return { operations: opsFor(conn as SshConnection), head: `[${(conn as SshConnection).id}] ${command}` };
    },
  });

  // Wrap execute: validate the target (fail fast, before any adoption) and
  // append the connection line so the model learns the reusable id.
  const baseExecute = tool.execute.bind(tool);
  tool.execute = async (
    toolCallId: string,
    params: BashToolCallParams,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof baseExecute>[3],
    ctx: Parameters<typeof baseExecute>[4],
  ) => {
    const resolved = connections.resolve(params.target, params.port, params.key);
    if (resolved.error || !resolved.conn) {
      return {
        content: [{ type: "text", text: `Error: ${resolved.error ?? "invalid target"}` }],
        details: { kind: "bash", mode: params.wait ?? "inline" },
        isError: true,
      };
    }
    const result = await baseExecute(toolCallId, params, signal, onUpdate, ctx);
    const conn = resolved.conn;
    // The machine line always lands (it identifies which host ran what); the
    // reuse hint only on a first-sight connection whose call actually worked —
    // advertising an id on a failed connection is noise on an error result.
    const reuse =
      resolved.reused || result.isError
        ? ""
        : ` — later calls can pass target: "${conn.id}" instead of the full destination`;
    const line = `\n\n[${conn.id}] ${describeConnection(conn)}${reuse}`;
    const first = result.content[0] as { text?: string } | undefined;
    if (first && typeof first.text === "string") first.text += line;
    return result;
  };

  pi.registerTool(tool);

  pi.on("session_shutdown", () => {
    // Best-effort, fire-and-forget: close the masters this session created.
    // A master already expired by ControlPersist (or never started) errors
    // into the void; nothing waits on these children.
    for (const conn of connections.list()) {
      const args = [
        "-o",
        `ControlPath=${join(controlDir, "cm-%C")}`,
        "-O",
        "exit",
        ...(conn.target.port !== undefined ? ["-p", String(conn.target.port)] : []),
        destinationArg(conn.target),
      ];
      try {
        const child = (opts.spawnFn ?? defaultSpawn)("ssh", args);
        child.on("error", () => {});
      } catch {
        // best effort — ControlPersist expiry is the backstop
      }
    }
  });
}

export default function (pi: ExtensionAPI): void {
  registerSshBashExtension(pi);
}
