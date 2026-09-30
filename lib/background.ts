/**
 * Background task core — the minimal registry behind non-blocking subagents
 * and shell commands.
 *
 * Design (the deliberate cut of a larger plan):
 * - a subagent child that outlives its adoption threshold keeps running while
 *   the parent turn moves on; when it settles, one wake message delivers the
 *   result as a followUp user message — a real transcript entry, so recall can
 *   find it again after compaction (no status tool, no polling)
 * - the registry is in-memory and session-scoped: pi reloads and exits run
 *   session_shutdown, which kills running children — an orphaned child burns
 *   API tokens with nobody consuming the result, so nothing outlives the
 *   session (the existing PI_SUBAGENT_TIMEOUT_MS hard kill still applies while
 *   running in the background)
 * - fire-once completion: a killed task never wakes, a completed task wakes
 *   exactly once (no notification storms)
 * - full replies over the wake cap are stashed beside the session at
 *   <sessionDir>/bg/<id>.txt with a pointer in the wake (the overflow pattern);
 *   with no session dir the text is hard-capped and says so
 * - PI_BG_WAKE=0 disables wake messages; the terminal notification still fires
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

/** Chars of a child's reply that ride inline in the wake message. */
export const WAKE_TEXT_CAP = 4_000;

export interface BgTask {
  id: string;
  name: string;
  kind: "subagent" | "bash";
  state: "running" | "done" | "failed" | "killed";
  startedAt: number;
  endedAt?: number;
}

/** The handle runChild hands over at adoption: the child's eventual outcome, plus a kill switch. */
export interface AdoptedHandle<T = { text: string; usage?: unknown }> {
  completion: Promise<T>;
  kill: () => void;
  /** Child spawn time (ms epoch), so wakes can report total runtime, not just background time. */
  startedAt: number;
}

export interface BackgroundDeps {
  /** Wake channel — receives the followUp user message text. */
  sendUserMessage?: (text: string) => void;
  /** Terminal notification channel (ctx.ui.notify); optional for headless modes. */
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  /** Footer status channel (ctx.ui.setStatus); optional for headless modes. */
  setStatus?: (key: string, text: string | undefined) => void;
  /** PI_BG_WAKE=0 — suppress wake messages, keep notifications. */
  wakeEnabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface BackgroundRegistry {
  /** Register a running task; returns its id (bg-1, bg-2, …). */
  adopt(record: { name: string; kind: "subagent" | "bash"; kill: () => void }): string;
  /** Record the outcome and deliver the wake exactly once; a no-op for unknown or non-running tasks. */
  complete(id: string, wake: { ok: boolean; text: string }): void;
  /** Tasks still running, oldest first. */
  running(): BgTask[];
  /** Kill every running task and mark it killed — no wakes fire for killed tasks. Returns how many were killed. */
  killAll(): number;
}

/** Millis before a subagent child is adopted into the background. */
export const DEFAULT_BG_AFTER_MS = 120_000;

export function parseBgAfterMs(env: Record<string, string | undefined>): number {
  // Trim first: Number("") coerces to 0, which would background every child instantly.
  const raw = env.PI_SUBAGENT_BG_AFTER_MS?.trim();
  return raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : DEFAULT_BG_AFTER_MS;
}

const WAKE_OFF = new Set(["0", "false", "no", "off"]);

/** Wake delivery defaults to on; only an explicit falsy value disables it. */
export function parseWakeEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_BG_WAKE?.trim().toLowerCase();
  return raw === undefined || raw === "" ? true : !WAKE_OFF.has(raw);
}

/** Stash file for an adopted task's full reply, next to the session so it survives resume. */
export function stashPath(sessionDir: string, id: string): string {
  return join(sessionDir, "bg", `${id}.txt`);
}

/** Cap a reply for the wake message; over-cap text is stashed when a session dir is available. */
export function capResultText(
  text: string,
  sessionDir: string | undefined,
  id: string,
  cap: number = WAKE_TEXT_CAP,
): { text: string; resultPath?: string } {
  if (text.length <= cap) return { text };
  if (!sessionDir) {
    return { text: `${text.slice(0, cap)}\n[… truncated — no session dir to stash the full reply …]` };
  }
  const resultPath = stashPath(sessionDir, id);
  try {
    mkdirSync(join(sessionDir, "bg"), { recursive: true });
    writeFileSync(resultPath, text);
  } catch {
    return { text: `${text.slice(0, cap)}\n[… truncated — stashing the full reply failed …]` };
  }
  return { text: `${text.slice(0, cap)}\n[… truncated — full reply: ${resultPath} …]`, resultPath };
}

/** Compact duration for wake headers: 4m12s, 38s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m${s % 60}s`;
}

/** The wake message for a completed subagent task. */
export function formatSubagentWake(
  name: string,
  id: string,
  opts: { ok: boolean; durationMs: number; text: string; usageLine?: string },
): string {
  const header = `[background] subagent "${name}" (${id}, ${formatDuration(opts.durationMs)}) ${
    opts.ok ? "completed" : "failed"
  }${opts.usageLine ? ` — ${opts.usageLine}` : ""}:`;
  const body = opts.text ? `\n${opts.text}` : "";
  return `${header}${body}`;
}

/** Create a session-scoped registry. Pure over its injected channels. */
export function createBackgroundRegistry(deps: BackgroundDeps = {}): BackgroundRegistry {
  const now = deps.now ?? Date.now;
  const tasks = new Map<string, BgTask & { kill: () => void }>();
  let counter = 0;

  const refreshStatus = () => {
    const n = [...tasks.values()].filter((t) => t.state === "running").length;
    deps.setStatus?.("bg", n > 0 ? `${n} running` : undefined);
  };

  return {
    adopt(record) {
      const id = `bg-${++counter}`;
      tasks.set(id, {
        id,
        name: record.name,
        kind: record.kind,
        state: "running",
        startedAt: now(),
        kill: record.kill,
      });
      refreshStatus();
      return id;
    },
    complete(id, wake) {
      const task = tasks.get(id);
      if (!task || task.state !== "running") return; // fire-once; killed tasks never wake
      task.state = wake.ok ? "done" : "failed";
      task.endedAt = now();
      refreshStatus();
      // Channels are external and can throw (a wake landing during session
      // teardown, say); the completion promise observing this call must not
      // reject unhandled and crash the host.
      try {
        if (deps.wakeEnabled !== false) deps.sendUserMessage?.(wake.text);
        deps.notify?.(wake.text.split("\n")[0], wake.ok ? "info" : "error");
      } catch {
        // Delivery failed after the fire-once flip — the wake is lost, but the
        // session survives it.
      }
    },
    running() {
      return [...tasks.values()]
        .filter((t) => t.state === "running")
        .map(({ kill: _kill, ...rest }) => rest)
        .sort((a, b) => a.startedAt - b.startedAt);
    },
    killAll() {
      let killed = 0;
      for (const task of tasks.values()) {
        if (task.state !== "running") continue;
        task.state = "killed"; // set first: the child's close event must find a non-running task
        task.endedAt = now();
        killed++;
        try {
          task.kill();
        } catch {
          // a failed kill on shutdown is reported by the process exit, not here
        }
      }
      refreshStatus();
      return killed;
    },
  };
}

/**
 * The bg tool: a shell command adopted into the same registry as subagents —
 * one footer count, one shutdown kill, the same wake channel. The tool returns
 * a task id immediately; the exit status and output tail arrive in the wake.
 */

/** Rolling per-command output kept in memory so a chatty process can't grow the parent. */
export const BASH_TAIL_CAP = 8_192;

/** The child surface the tool depends on (Node's ChildProcess satisfies this). */
export interface BashChild {
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  stdout: { on(event: "data", cb: (chunk: string | Buffer) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: string | Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): unknown;
}

export type BashSpawnFn = (command: string) => BashChild;

const defaultBashSpawn: BashSpawnFn = (command) =>
  nodeSpawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });

/** One line identifying the command for wake headers and the registry's running list. */
export function bashCommandHead(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The wake message for a finished shell command: status, duration, capped tail. */
export function formatBashWake(opts: {
  command: string;
  id: string;
  status: string;
  durationMs: number;
  output: string;
  sessionDir: string | undefined;
}): string {
  const body = opts.output.trim()
    ? `\n\n${capResultText(opts.output.trim(), opts.sessionDir, opts.id).text}`
    : ""; // quiet commands stay quiet
  return `[background] bash (${opts.id}, ${formatDuration(opts.durationMs)}) ${opts.status} — ${bashCommandHead(
    opts.command,
  )}${body}`;
}

export interface BgToolResult {
  content: { type: "text"; text: string }[];
  details: { kind: "bash"; id?: string };
  isError?: boolean;
}

export function createBgTool(
  registry: BackgroundRegistry,
  opts: { spawnFn?: BashSpawnFn; defaultTimeoutMs?: number; now?: () => number } = {},
) {
  const spawnFn = opts.spawnFn ?? defaultBashSpawn;
  const now = opts.now ?? Date.now;
  return {
    name: "bg",
    label: "Background shell",
    description: `Run a shell command in the background and return immediately with a task id.
When the command exits, one follow-up message delivers its exit status, duration, and the tail of its combined output (stashed beside the session when over the inline cap).
Use for long-running commands whose result you need later — builds, test suites, migrations — not for output you need inline. Killed on session shutdown; a timeout (default 10m) SIGKILLs.`,
    promptSnippet: "Background a long-running shell command",
    promptGuidelines: [
      "Use bg for shell commands whose result you need later but don't need to wait for (builds, test suites); it returns a task id immediately and the result arrives in a follow-up message.",
      "Prefer the regular bash tool when you need the output to proceed — bg never blocks and never returns output inline.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command, passed to bash -c" }),
      timeout_ms: Type.Optional(
        Type.Number({ description: "SIGKILL the command after this many milliseconds (default 10m)" }),
      ),
    }),
    async execute(
      _id: string,
      params: { command: string; timeout_ms?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined, // unused: bg never streams partials; loose type to satisfy bivariant method checks
      ctx: { sessionManager?: { getSessionDir(): string | undefined } } | undefined,
    ): Promise<BgToolResult> {
      const command = params.command?.trim();
      if (!command) {
        return {
          content: [{ type: "text" as const, text: "bg: command is required" }],
          details: { kind: "bash" },
          isError: true,
        };
      }
      let child: BashChild;
      try {
        child = spawnFn(command);
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Failed to spawn: ${error instanceof Error ? error.message : String(error)}` },
          ],
          details: { kind: "bash" },
          isError: true,
        };
      }
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      const startedAt = now();
      let tail = "";
      let timedOut = false;
      const id = registry.adopt({
        name: bashCommandHead(command),
        kind: "bash",
        kill: () => child.kill("SIGKILL"),
      });
      // Combined rolling tail, interleaved as received.
      const append = (chunk: string | Buffer) => {
        tail = (tail + chunk.toString()).slice(-BASH_TAIL_CAP);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const timeoutMs = params.timeout_ms ?? opts.defaultTimeoutMs ?? 10 * 60_000;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
      const finish = (status: string, ok: boolean) => {
        clearTimeout(timer);
        registry.complete(id, {
          ok,
          text: formatBashWake({ command, id, status, durationMs: now() - startedAt, output: tail, sessionDir }),
        });
      };
      child.on("close", (code, signal) => {
        // A task killed by shutdown completes as a no-op — fire-once.
        finish(
          timedOut
            ? `timed out after ${formatDuration(timeoutMs)}`
            : code === null
              ? `killed (${signal ?? "unknown signal"})`
              : `exited ${code}`,
          !timedOut && code === 0,
        );
      });
      child.on("error", (error) => finish(`failed: ${error.message}`, false));
      return {
        content: [
          {
            type: "text" as const,
            text: `Backgrounded (${id}): ${bashCommandHead(command)}\nExit status and output tail arrive in a follow-up message.`,
          },
        ],
        details: { kind: "bash", id },
      };
    },
  };
}
