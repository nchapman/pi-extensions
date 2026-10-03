/**
 * superbash — the background-task core: the shared registry behind
 * non-blocking subagents and the unified `bash` tool, plus the task
 * management tools (task, task_kill, task_remind).
 *
 * Design (the deliberate cut of a larger plan):
 * - the registry is in-memory and session-scoped: pi reloads and exits run
 *   session_shutdown, which kills running children — an orphaned child burns
 *   API tokens with nobody consuming the result, so nothing outlives the
 *   session (the existing PI_SUBAGENT_TIMEOUT_MS hard kill still applies while
 *   running in the background)
 * - one tool for every CLI task, named `bash` so it replaces the built-in by
 *   name: wait: "inline" delegates to pi's own bash tool (identical streaming,
 *   truncation, temp-file stashing, structured output); wait: "auto"
 *   (default) blocks for up to a ~2m window and then promotes to the
 *   background exactly like subagents do; wait: "background" returns the task
 *   id immediately. No default timeout — the agent decides; 0 or omitted
 *   means no timeout
 * - a backgrounded task keeps running while the parent turn moves on; when it
 *   settles, one wake message steers in with the result — delivered as the
 *   parent's next message at a turn boundary, even mid-run, so a sleep-polling
 *   model can never starve it (a real transcript entry, so recall can find it
 *   again after compaction). Fire-once: a killed task never wakes, a completed
 *   task wakes exactly once; a task that settles inside the auto window
 *   completes wake-less, because the tool result already carried the output
 * - checking in is pull-based and model-scheduled, never a fixed heartbeat:
 *   `task <id>` reads new output from the task's log since the last check (an
 *   in-memory byte offset; the first check shows the tail), and `task_remind`
 *   arms at most one one-shot timer per task (re-arm replaces; omitting
 *   in_ms cancels) whose fire is dropped when the task already settled — the
 *   completion wake already delivered the result, so a heartbeat could only
 *   burn turns on silence
 * - full replies over the wake cap are stashed beside the session at
 *   <sessionDir>/tasks/<id>.txt with a pointer in the wake (the overflow pattern);
 *   with no session dir the text is hard-capped and says so
 * - backgrounded bash commands run through pi's own local bash operations
 *   (the same createLocalBashOperations the built-in bash tool uses): identical
 *   shell resolution (Unix /bin/bash → PATH → sh; Windows Git Bash), identical
 *   env (pi's bin dir on PATH, this session's PI_* vars), identical
 *   process-tree kill, identical #5303-safe wait on detached descendants, and
 *   the 128+signal exit-code convention. The full command output is streamed
 *   to <sessionDir>/tasks/<id>.log (or a temp file with no session dir) from
 *   byte zero — `task <id>` peeks at it while the command runs and it
 *   survives resume; the log is removed on kill
 * - PI_BG_WAKE=0 disables wake messages (completions and reminders); the
 *   terminal notification still fires
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Budget (chars for replies, bytes for command output) that rides inline in the wake message. */
export const WAKE_TEXT_CAP = 4_000;

export interface BgTask {
  id: string;
  name: string;
  kind: "subagent" | "bash";
  state: "running" | "done" | "failed" | "killed";
  startedAt: number;
  endedAt?: number;
  /** Short terminal status line ("exited 0", "completed", …) recorded on complete. */
  status?: string;
}

/** The handle runChild hands over at adoption: the child's eventual outcome, plus a kill switch. */
export interface AdoptedHandle<T = { text: string; usage?: unknown }> {
  completion: Promise<T>;
  kill: () => void;
  /** Child spawn time (ms epoch), so wakes can report total runtime, not just background time. */
  startedAt: number;
}

export interface TaskDeps {
  /** Wake channel — receives the steered user message text. */
  sendUserMessage?: (text: string) => void;
  /** Terminal notification channel (ctx.ui.notify); optional for headless modes. */
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  /** Footer status channel (ctx.ui.setStatus); optional for headless modes. */
  setStatus?: (key: string, text: string | undefined) => void;
  /** PI_BG_WAKE=0 — suppress wake messages, keep notifications. */
  wakeEnabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable timer for task_remind (tests); defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export interface TaskRegistry {
  /** Register a running task; returns its id (t-<base36 time>, e.g. t-1134z8v). */
  adopt(record: { name: string; kind: "subagent" | "bash"; kill: () => void }): string;
  /**
   * Record the outcome and deliver the wake exactly once; a no-op for unknown
   * or non-running tasks. wake: false records without messaging — the tool
   * result already carried the output (auto mode settling inside its window).
   */
  complete(id: string, outcome: { ok: boolean; text: string; status?: string; wake?: boolean }): void;
  /** Tasks still running, oldest first. */
  running(): BgTask[];
  /** Whether the task exists and has not settled or been killed. */
  isRunning(id: string): boolean;
  /** Full record for any known task, running or settled. */
  get(id: string): BgTask | undefined;
  /** Kill one task by id; true when it existed and was running. Killed tasks never wake. */
  kill(id: string): boolean;
  /** Kill every running task and mark it killed — no wakes fire for killed tasks. Returns how many were killed. */
  killAll(): number;
  /** Arm (or re-arm) a one-shot check-in on a running task; false when the task is unknown or settled. */
  remind(id: string, ms: number, note?: string): boolean;
  /** Cancel the task's pending check-in; true when one was pending. */
  cancelReminder(id: string): boolean;
  /** The task's pending check-in, if any. */
  reminderFor(id: string): { ms: number; note?: string } | undefined;
  /** All pending check-ins, oldest task first. */
  reminders(): { id: string; ms: number; note?: string }[];
}

/** Millis before a subagent child is adopted into the background. */
export const DEFAULT_BG_AFTER_MS = 120_000;

/** Millis bash (wait: auto) blocks before promoting to the background. */
export const DEFAULT_BASH_BG_AFTER_MS = 120_000;

/** Shared PI_*_BG_AFTER_MS parsing: trim first (Number("") is 0, which would
 * background instantly); negative or invalid values fall back to the default. */
function parseAfterMs(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  return raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback;
}

export function parseBgAfterMs(env: Record<string, string | undefined>): number {
  return parseAfterMs(env, "PI_SUBAGENT_BG_AFTER_MS", DEFAULT_BG_AFTER_MS);
}

export function parseBashBgAfterMs(env: Record<string, string | undefined>): number {
  return parseAfterMs(env, "PI_BASH_BG_AFTER_MS", DEFAULT_BASH_BG_AFTER_MS);
}

const WAKE_OFF = new Set(["0", "false", "no", "off"]);

/** Wake delivery defaults to on; only an explicit falsy value disables it. */
export function parseWakeEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_BG_WAKE?.trim().toLowerCase();
  return raw === undefined || raw === "" ? true : !WAKE_OFF.has(raw);
}

/** Stash file for an adopted task's full reply, next to the session so it survives resume. */
export function stashPath(sessionDir: string, id: string): string {
  return join(sessionDir, "tasks", `${id}.txt`);
}

/** Cap a reply for the wake message; over-cap text is stashed when a session dir is available. */
export function capResultText(
  text: string,
  sessionDir: string | undefined,
  id: string,
  cap: number = WAKE_TEXT_CAP,
  noun: "reply" | "output" = "reply",
): { text: string; resultPath?: string } {
  if (text.length <= cap) return { text };
  if (!sessionDir) {
    return { text: `${text.slice(0, cap)}\n[… truncated — no session dir to stash the full ${noun} …]` };
  }
  const resultPath = stashPath(sessionDir, id);
  try {
    mkdirSync(join(sessionDir, "tasks"), { recursive: true });
    writeFileSync(resultPath, text);
  } catch {
    return { text: `${text.slice(0, cap)}\n[… truncated — stashing the full ${noun} failed …]` };
  }
  return { text: `${text.slice(0, cap)}\n[… truncated — full ${noun}: ${resultPath} …]`, resultPath };
}

/** Compact duration for wake headers: 4m12s, 38s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  const mm = m % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h${mm ? `${mm}m` : ""}` : rem ? `${m}m${rem}s` : `${m}m`;
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

/** The wake message for a scheduled check-in on a task that is still running. */
export function formatReminderWake(task: BgTask, elapsedMs: number, note?: string): string {
  const notePart = note ? ` — ${note}` : "";
  return `[reminder] ${task.id} (${task.kind}, ${formatDuration(elapsedMs)}) still running${notePart}`;
}

/** The "Check-ins:" block appended to task listings (task tool and /tasks). */
export function describeReminders(reminders: { id: string; ms: number; note?: string }[]): string {
  if (reminders.length === 0) return "";
  return `\nCheck-ins:\n${reminders
    .map((r) => `  ${r.id} in ${formatDuration(r.ms)}${r.note ? ` — ${r.note}` : ""}`)
    .join("\n")}`;
}

/** Create a session-scoped registry. Pure over its injected channels. */
export function createTaskRegistry(deps: TaskDeps = {}): TaskRegistry {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = deps.unschedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tasks = new Map<string, BgTask & { kill: () => void }>();
  const reminders = new Map<string, { handle: unknown; ms: number; note?: string }>();
  // Ids are "t-" + base36 millisecond timestamp, monotonic within the session.
  // Time-based so ids are unique across resumes and parallel sessions: a long
  // context can hold task ids from earlier sessions without "t-same" ever
  // meaning two different tasks. Same-millisecond adopts advance the clock by 1ms.
  let lastTs = 0;

  const refreshStatus = () => {
    const n = [...tasks.values()].filter((t) => t.state === "running").length;
    deps.setStatus?.("bg", n > 0 ? `${n} running` : undefined);
  };

  // Channels are external and can throw (a wake landing during session
  // teardown, say); the completion promise observing this call must not
  // reject unhandled and crash the host.
  const deliver = (text: string, ok: boolean) => {
    try {
      if (deps.wakeEnabled !== false) deps.sendUserMessage?.(text);
      deps.notify?.(text.split("\n")[0], ok ? "info" : "error");
    } catch {
      // Delivery failed after the fire-once flip — the wake is lost, but the
      // session survives it.
    }
  };

  const cancelReminder = (id: string): boolean => {
    const r = reminders.get(id);
    if (!r) return false;
    reminders.delete(id);
    try {
      unschedule(r.handle);
    } catch {
      // handle already consumed — nothing left to cancel
    }
    return true;
  };

  // Mark killed before killing: the child's close event must find a
  // non-running task, and a failed kill surfaces through the process exit.
  const killTask = (task: (BgTask & { kill: () => void }) | undefined): boolean => {
    if (!task || task.state !== "running") return false;
    task.state = "killed";
    task.endedAt = now();
    cancelReminder(task.id);
    try {
      task.kill();
    } catch {
      // a failed kill is reported by the process exit, not here
    }
    refreshStatus();
    return true;
  };

  return {
    adopt(record) {
      const ts = Math.max(now(), lastTs + 1);
      lastTs = ts;
      const id = `t-${ts.toString(36)}`;
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
    complete(id, { ok, text, status, wake = true }) {
      const task = tasks.get(id);
      if (!task || task.state !== "running") return; // fire-once; killed tasks never wake
      task.state = ok ? "done" : "failed";
      task.endedAt = now();
      if (status) task.status = status;
      refreshStatus();
      cancelReminder(id);
      if (wake) deliver(text, ok);
    },
    running() {
      return [...tasks.values()]
        .filter((t) => t.state === "running")
        .map(({ kill: _kill, ...rest }) => rest)
        .sort((a, b) => a.startedAt - b.startedAt);
    },
    isRunning(id) {
      return tasks.get(id)?.state === "running";
    },
    get(id) {
      const task = tasks.get(id);
      if (!task) return undefined;
      const { kill: _kill, ...rest } = task;
      return rest;
    },
    kill(id) {
      return killTask(tasks.get(id));
    },
    killAll() {
      let killed = 0;
      for (const task of tasks.values()) {
        if (killTask(task)) killed++;
      }
      refreshStatus();
      return killed;
    },
    remind(id, ms, note) {
      const task = tasks.get(id);
      if (!task || task.state !== "running") return false;
      cancelReminder(id); // re-arm replaces the pending check-in
      const handle = schedule(() => {
        if (!reminders.delete(id)) return; // cancelled or replaced in the meantime
        const current = tasks.get(id);
        // Settled tasks are dropped: the completion wake already delivered the
        // result, so the check-in would only burn a turn on stale news.
        if (!current || current.state !== "running") return;
        deliver(formatReminderWake(current, now() - current.startedAt, note), true);
      }, ms);
      reminders.set(id, { handle, ms, note });
      return true;
    },
    cancelReminder,
    reminderFor(id) {
      const r = reminders.get(id);
      return r ? { ms: r.ms, note: r.note } : undefined;
    },
    reminders() {
      return [...reminders.entries()].map(([id, r]) => ({ id, ms: r.ms, note: r.note }));
    },
  };
}

/** Rolling per-command output kept in memory so a chatty process can't grow the parent. */
export const BASH_TAIL_CAP = 8_192;

/** Node clamps out-of-range setTimeout delays to 1ms — an instant kill. Keep timeouts schedulable. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Clamp a caller-supplied timeout into schedulable range; invalid values fall back. */
export function clampTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

/** Full-output log for a backgrounded command, beside the session so it survives resume. */
export function outputLogPath(sessionDir: string, id: string): string {
  return join(sessionDir, "tasks", `${id}.log`);
}

/** Temp-file fallback when the session has no dir — mirrors pi's pi-bash-*.log temp files. */
export function tempOutputLogPath(id: string): string {
  return join(tmpdir(), `pi-task-${id}.log`);
}

/**
 * The agent config directory (~/.pi/agent by default), the parent of the bin
 * dir pi's bash tool prepends to PATH (fd, rg, …). Mirrors pi's getAgentDir.
 */
export function piAgentDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR?.trim();
  if (dir) {
    return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * The environment a backgrounded command sees — mirrors pi's built-in bash
 * tool (resolveSpawnContext with exposeSessionEnvironment defaulting to true,
 * on top of getShellEnv's bin-dir PATH prepend):
 * - pi's bin dir is prepended to PATH when missing (case-insensitive key);
 * - inherited PI_* session vars are stripped, then this session's are re-added,
 *   so stale values from another context can't leak to the child.
 */
export function buildBashEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    agentDir?: string;
    sessionId?: string;
    sessionFile?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (opts.agentDir) {
    const binDir = join(opts.agentDir, "bin");
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const current = env[pathKey] ?? "";
    if (!current.split(delimiter).filter(Boolean).includes(binDir)) {
      env[pathKey] = [binDir, current].filter(Boolean).join(delimiter);
    }
  }
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  if (opts.sessionId) env.PI_SESSION_ID = opts.sessionId;
  if (opts.sessionFile) env.PI_SESSION_FILE = opts.sessionFile;
  if (opts.provider && opts.model) {
    env.PI_PROVIDER = opts.provider;
    env.PI_MODEL = opts.model;
  }
  if (opts.thinkingLevel) env.PI_REASONING_LEVEL = opts.thinkingLevel;
  return env;
}

/** One line identifying the command for wake headers and the registry's running list. */
export function bashCommandHead(command: string): string {
  // Code-point aware truncation: a UTF-16 slice could split a surrogate pair
  // at the cap and put undecodable garbage in the wake header and notify.
  return Array.from(command.replace(/\s+/g, " ").trim()).slice(0, 80).join("");
}

/** The wake message for a finished shell command: status, duration, output tail. */
export function formatBashWake(opts: {
  command: string;
  id: string;
  status: string;
  durationMs: number;
  /** Output tail, already truncated to the wake budget by the tool. */
  output: string;
  /** Pointer/warning appended after the output (full-output path, or a stash failure). */
  outputNote?: string;
}): string {
  const body =
    opts.output.trim() || opts.outputNote
      ? `\n\n${[opts.output.trim(), opts.outputNote].filter(Boolean).join("\n")}`
      : ""; // quiet commands stay quiet
  return `[background] bash (${opts.id}, ${formatDuration(opts.durationMs)}) ${opts.status} — ${bashCommandHead(
    opts.command,
  )}${body}`;
}

/** Live output updates streamed to the TUI while an auto-mode call is still blocking. */
type BashOnUpdate = AgentToolUpdateCallback;

/** The inline executor: pi's own bash tool definition (the very one the built-in registers). */
type InlineResult = AgentToolResult;
export type BashInlineExecutor = (
  toolCallId: string,
  params: { command: string; timeout?: number },
  signal: AbortSignal | undefined,
  onUpdate: BashOnUpdate | undefined,
  ctx: unknown,
) => Promise<InlineResult>;

/** The session slice of the tool context the bash and task tools read. */
interface ToolCtx {
  cwd?: string;
  sessionManager?: {
    getSessionDir(): string | undefined;
    getSessionId(): string | undefined;
    getSessionFile?(): string | undefined;
  };
  model?: { provider: string; id: string } | undefined;
  thinkingLevel?: string | undefined;
}

export type BashWaitMode = "inline" | "auto" | "background";

export interface BashToolResult extends AgentToolResult {
  details: { kind: "bash"; mode: BashWaitMode; id?: string };
}

/** Live-output update cadence while an auto call is still blocking — pi's own
 * BASH_UPDATE_THROTTLE_MS. */
const UPDATE_THROTTLE_MS = 100;

/**
 * The unified bash tool — replaces the built-in by name and covers the whole
 * range of "run a CLI task":
 * - wait: "inline" — delegates to pi's own bash tool (same streaming,
 *   truncation, temp-file stashing, structured output); no task is registered
 * - wait: "auto" (default) — blocks up to the window, streaming live output to
 *   the TUI; a command that finishes in time returns a built-in-style result
 *   inline, one that doesn't is promoted to the background and the tool
 *   returns its task id, with the wake delivering the result later
 * - wait: "background" — returns the task id immediately
 * Auto and background run through pi's local bash operations with a full
 * output log, so `task <id>` can peek at any point and the output survives
 * resume.
 */
export function createBashTool(
  registry: TaskRegistry,
  opts: {
    operations?: BashOperations;
    /** Inline executor; defaults to pi's own bash tool. */
    inline?: BashInlineExecutor;
    /** Auto-promote window in ms; a function is called per invocation so env changes apply without a reload. */
    waitMs?: number | (() => number);
    now?: () => number;
  } = {},
) {
  const operations = opts.operations ?? createLocalBashOperations();
  const now = opts.now ?? Date.now;
  // The description states the auto-promote window; report the value in effect
  // at registration — PI_BASH_BG_AFTER_MS is a session-level knob, so a tuned
  // window shouldn't be described as the 2m default.
  const descWindowMs = typeof opts.waitMs === "function" ? opts.waitMs() : (opts.waitMs ?? DEFAULT_BASH_BG_AFTER_MS);
  // The definition (not the wrapped tool): its execute takes the tool ctx,
  // which the inline path needs for cwd, session env, and streaming.
  const piBashDef = opts.inline ? undefined : createBashToolDefinition(process.cwd());
  const runInline: BashInlineExecutor =
    opts.inline ??
    ((toolCallId, params, signal, onUpdate, ctx) =>
      (piBashDef as NonNullable<typeof piBashDef>).execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
        ctx as never,
      ) as unknown as Promise<InlineResult>);
  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); when truncated, the full output is saved to a file whose path the result includes.
wait: "auto" (default) blocks while the command runs, up to ~${formatDuration(descWindowMs)} — a command that finishes in time returns its output inline, one that doesn't move to the background and return a task id (t-xxxxx). "inline" always blocks. "background" returns a task id immediately. A backgrounded command's result (exit status, duration, output tail) is delivered to you automatically as your next message, even mid-run — never sleep or poll waiting for it. Check on a running task with task <id>; schedule a one-shot check-in with task_remind; stop it with task_kill.
Timeout is in seconds, optional, no default — a command without a timeout runs until it finishes or is killed (0 also means no timeout).`,
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "Use wait: auto (default) when you don't know how long a command takes; wait: background for known long-running work (builds, test suites, migrations) whose result you need later; wait: inline for quick commands you need to proceed with.",
      "Background results are delivered to you automatically as your next message, even mid-run — continue other work; never sleep or poll waiting for them.",
      "Peek at a running task with task <id>; schedule a one-shot check-in with task_remind; stop a task with task_kill.",
      "You can inspect PI_* environment variables for current model and session details.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (optional; no default — 0 or omitted means no timeout)",
        }),
      ),
      wait: Type.Optional(
        Type.Union([Type.Literal("inline"), Type.Literal("auto"), Type.Literal("background")], {
          description: `inline: block and return output. auto (default): block up to ~${formatDuration(descWindowMs)}, then move to the background. background: return a task id immediately.`,
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: { command: string; timeout?: number; wait?: BashWaitMode },
      signal: AbortSignal | undefined,
      onUpdate: BashOnUpdate | undefined,
      ctx: ToolCtx | undefined,
    ): Promise<BashToolResult> {
      const mode: BashWaitMode = params.wait ?? "auto";
      const error = (text: string): BashToolResult => ({
        content: [{ type: "text", text }],
        details: { kind: "bash", mode },
        isError: true,
      });
      const command = params.command?.trim();
      if (!command) return error("bash: command is required");
      // Timeout in seconds (like the built-in): omitted or 0 means no timeout;
      // anything else must be finite and schedulable — an explicit tool error
      // rather than a stray background wake for a task that never ran.
      let timeoutSecs: number | undefined;
      if (params.timeout !== undefined && params.timeout !== 0) {
        if (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > MAX_TIMEOUT_MS / 1000) {
          return error(
            `Invalid timeout: must be 0 (no timeout) or a finite number of seconds up to ${Math.floor(
              MAX_TIMEOUT_MS / 1000,
            )}`,
          );
        }
        timeoutSecs = params.timeout;
      }
      // Inline is the built-in, byte for byte: no task, no wake, no log.
      if (mode === "inline") {
        try {
          const result = await runInline(toolCallId, { command, timeout: timeoutSecs }, signal, onUpdate, ctx);
          return {
            ...result,
            details: { kind: "bash", mode, ...(result.details as Record<string, unknown> | undefined) },
          } as BashToolResult;
        } catch (e) {
          return error(e instanceof Error ? e.message : String(e));
        }
      }
      const cwd = ctx?.cwd ?? process.cwd();
      // pi's bash tool validates the working directory up front with a clear
      // error; do the same before adopting so a bad cwd is an immediate tool
      // error, not a stray "failed" wake for a task that never ran.
      if (!existsSync(cwd)) {
        return error(`Working directory does not exist: ${cwd}`);
      }
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      const env = buildBashEnv(process.env, {
        agentDir: piAgentDir(),
        sessionId: ctx?.sessionManager?.getSessionId?.(),
        sessionFile: ctx?.sessionManager?.getSessionFile?.(),
        provider: ctx?.model?.provider,
        model: ctx?.model?.id,
        thinkingLevel: ctx?.thinkingLevel,
      });
      // One controller per task: registry kills (task_kill, /tasks, shutdown)
      // and the tool call's own abort both funnel into it. pi's local ops kill
      // the whole process tree on abort, like the built-in bash tool.
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      // Rolling tail kept as bytes: a chunk can end mid-codepoint, and string
      // concatenation would bake U+FFFD into the tail at every boundary.
      let tail = Buffer.alloc(0);
      // Full output, streamed to the log from byte zero so `task <id>` can peek
      // while the command runs and the output survives resume. Node buffers
      // writes to the stream before the file opens, so no separate buffering
      // is needed.
      let logStream: import("node:fs").WriteStream | undefined;
      let logPath: string | undefined;
      let logFailed = false;
      const ensureLog = () => {
        if (logStream || logFailed) return;
        logPath = sessionDir ? outputLogPath(sessionDir, id) : tempOutputLogPath(id);
        try {
          if (sessionDir) mkdirSync(join(sessionDir, "tasks"), { recursive: true });
          logStream = createWriteStream(logPath);
          logStream.on("error", () => {
            logFailed = true;
            logStream?.destroy();
            logStream = undefined;
          });
        } catch {
          logFailed = true; // fail-open: the wake says the full output is lost
        }
      };
      // Ends the log once, with a promise the auto path can await before
      // reading the full output back (the end callback fires after all
      // buffered writes have flushed).
      let closing: Promise<void> | undefined;
      const closeLog = () => {
        closing ??= new Promise<void>((resolve) => {
          if (!logStream) return resolve();
          const s = logStream;
          logStream = undefined;
          s.once("error", () => resolve());
          s.end(() => resolve());
        });
        return closing;
      };
      // Live output in the TUI while an auto call is still blocking, throttled
      // like the built-in bash tool. Background mode skips it: the tool call
      // has already returned, so there is no panel to update.
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;
      const emitOutputUpdate = () => {
        if (!onUpdate || mode !== "auto" || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = now();
        onUpdate({ content: [{ type: "text", text: tail.toString("utf8") }], details: undefined });
      };
      const scheduleOutputUpdate = () => {
        // Once auto promotes, the tool call has returned — there is no panel
        // left to update, and calling onUpdate after completion is invalid.
        if (!onUpdate || mode !== "auto" || promoted) return;
        updateDirty = true;
        const delay = UPDATE_THROTTLE_MS - (now() - lastUpdateAt);
        if (delay <= 0) {
          if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = undefined;
          }
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };
      const id = registry.adopt({
        name: bashCommandHead(command),
        kind: "bash",
        kill: () => {
          controller.abort();
          // A killed task leaves no orphaned log: stop writes, remove the
          // partial file (best effort — Windows may still hold it open).
          logStream?.destroy();
          logStream = undefined;
          if (logPath) {
            try {
              unlinkSync(logPath);
            } catch {
              // best effort
            }
          }
        },
      });
      // Eager: even a quiet long build is peekable from its first byte.
      ensureLog();
      if (onUpdate && mode === "auto") onUpdate({ content: [], details: undefined });
      const onData = (data: Buffer) => {
        // A killed or settled task is done: ignore late chunks so a delayed
        // pipe read can't resurrect the log (or grow the tail) after teardown.
        if (!registry.isRunning(id) || data.length === 0) return;
        tail = Buffer.concat([tail, data]).subarray(-BASH_TAIL_CAP);
        if (logStream) logStream.write(data);
        scheduleOutputUpdate();
      };
      // True from the start in background mode; flipped when auto promotes.
      let promoted = mode === "background";
      const startedAt = now();
      const settle = (status: string, ok: boolean) => {
        signal?.removeEventListener("abort", onOuterAbort);
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
        void closeLog();
        // A task killed by task_kill/shutdown completes (and would compose its
        // wake) as a no-op — guard before composing so it leaves nothing behind.
        if (!registry.isRunning(id)) return;
        if (promoted) {
          const output = tail.toString("utf8");
          const display = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
          const note =
            display.truncated && logPath
              ? logFailed
                ? "[… truncated — could not save the full output …]"
                : `[… truncated — full output: ${logPath} …]`
              : undefined;
          registry.complete(id, {
            ok,
            status,
            text: formatBashWake({
              command,
              id,
              status,
              durationMs: now() - startedAt,
              output: display.content,
              outputNote: note,
            }),
          });
        } else {
          // Settled inside the auto window: the tool result carries the output,
          // so record the outcome without a duplicate wake.
          registry.complete(id, { ok, status, text: status, wake: false });
        }
      };
      const settleFromError = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "aborted") settle("aborted", false);
        else if (message.startsWith("timeout:"))
          settle(`timed out after ${timeoutSecs ?? message.split(":")[1]}s`, false);
        else settle(`failed: ${message}`, false);
      };
      let execPromise: Promise<{ exitCode: number | null }>;
      try {
        // pi's local ops take the timeout in seconds; the tree kill on
        // timeout/abort and the #5303-safe wait live inside ops.exec.
        execPromise = operations.exec(command, cwd, {
          onData,
          signal: controller.signal,
          timeout: timeoutSecs,
          env,
        });
      } catch (err) {
        settle(`failed: ${err instanceof Error ? err.message : String(err)}`, false);
        return error(`Failed to start command: ${err instanceof Error ? err.message : String(err)}`);
      }
      const backgrounded = (): BashToolResult => ({
        content: [
          {
            type: "text",
            text: `Backgrounded (${id}): ${bashCommandHead(command)}
The command keeps running in the background. When it exits, the exit status, duration, and output tail are delivered to you automatically as your next message — even mid-run, while you keep working. Check on it with task ${id}; schedule a one-shot check-in with task_remind ${id} <in_ms>. Never sleep or poll waiting for it.`,
          },
        ],
        details: { kind: "bash", mode, id },
        structuredContent: { backgrounded: true, task_id: id },
      });
      if (promoted) {
        void execPromise.then(
          ({ exitCode }) =>
            // ops.exec already maps signal kills to 128 + signal number, so a
            // plain "exited N" matches the built-in bash tool's convention.
            settle(exitCode === null ? "terminated without an exit code" : `exited ${exitCode}`, exitCode === 0),
          settleFromError,
        );
        return backgrounded();
      }
      // Auto: block up to the window, then promote. The window is read per
      // call so PI_BASH_BG_AFTER_MS changes apply without a reload; 0 behaves
      // like background.
      const windowMs = typeof opts.waitMs === "function" ? opts.waitMs() : (opts.waitMs ?? DEFAULT_BASH_BG_AFTER_MS);
      let windowTimer: ReturnType<typeof setTimeout> | undefined;
      const race = await Promise.race([
        execPromise.then(
          (r) => {
            const status = r.exitCode === null ? "terminated without an exit code" : `exited ${r.exitCode}`;
            settle(status, r.exitCode === 0);
            return { status, ok: r.exitCode === 0, exitCode: r.exitCode as number | null };
          },
          (e: unknown) => {
            settleFromError(e);
            return {
              status: "",
              ok: false,
              exitCode: null as number | null,
              error: e instanceof Error ? e.message : String(e),
            };
          },
        ),
        new Promise<"promote">((resolve) => {
          windowTimer = setTimeout(() => resolve("promote"), Math.max(0, windowMs - (now() - startedAt)));
        }),
      ]);
      if (windowTimer) clearTimeout(windowTimer);
      if (race === "promote") {
        promoted = true;
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
        emitOutputUpdate();
        void execPromise.then(
          ({ exitCode }) =>
            settle(exitCode === null ? "terminated without an exit code" : `exited ${exitCode}`, exitCode === 0),
          settleFromError,
        );
        return backgrounded();
      }
      // Finished inside the window: a built-in-style result, inline. Only
      // bounded slices of the log are read — a chatty command that finishes
      // quickly (yes | head -c 3G) must not pull gigabytes into the parent.
      const settled: { ok: boolean; exitCode: number | null; error?: string } = race;
      const HEAD_CAP = 1_048_576; // the structuredContent.output budget
      let head = tail.toString("utf8");
      let display = truncateTail(head, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      try {
        if (logPath) {
          await closeLog();
          const size = statSync(logPath).size;
          if (size <= DEFAULT_MAX_BYTES) {
            // Small enough that the whole file is already a bounded read.
            const all = readFileSync(logPath, "utf8");
            head = all;
            display = truncateTail(all, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
          } else {
            head = readLogChunk(logPath, 0, HEAD_CAP)?.text ?? head;
            const tailChunk = readLogChunk(logPath, undefined, DEFAULT_MAX_BYTES);
            if (tailChunk) {
              display = {
                ...truncateTail(tailChunk.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }),
                truncated: true, // the file exceeded the display budget
              };
            }
          }
        }
      } catch {
        // log gone (kill race) — the in-memory tail still stands
      }
      const wallTimeSeconds = Math.round((now() - startedAt) / 100) / 10;
      let text = display.content || "(no output)";
      if (display.truncated && logPath) {
        text += `\n\n[Output truncated — full output: ${logPath}]`;
      }
      const exitCode = settled.exitCode;
      if (!settled.ok) {
        // Mirror the built-in bash tool's failure wording: rejections carry a
        // message (aborted/timeout/spawn), a plain nonzero resolve doesn't.
        const statusText =
          settled.error === "aborted"
            ? "Command aborted"
            : settled.error?.startsWith("timeout:")
              ? `Command timed out after ${settled.error.split(":")[1]} seconds`
              : (settled.error ??
                (exitCode === null
                  ? "Command terminated without an exit code"
                  : `Command exited with code ${exitCode}`));
        return error(`${text ? `${text}\n\n` : ""}${statusText}`);
      }
      const structuredContent: NonNullable<BashToolResult["structuredContent"]> = {
        output: head, // head is bounded by HEAD_CAP by construction
        truncated: display.truncated,
        ...(display.truncated && logPath ? { full_output_path: logPath } : {}),
        exit_code: exitCode ?? 1,
        wall_time_seconds: wallTimeSeconds,
      };
      if (exitCode === null) {
        return error(`${text ? `${text}\n\n` : ""}Command terminated without an exit code`);
      }
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `${text}\n\nCommand exited with code ${exitCode}` }],
          details: { kind: "bash", mode, id },
          structuredContent,
          isError: true,
        };
      }
      return { content: [{ type: "text", text }], details: { kind: "bash", mode, id }, structuredContent };
    },
  };
}

/** One line of the /tasks listing and the kill/peek error hints. */
export function describeRunningTasks(tasks: BgTask[], nowMs: number = Date.now()): string {
  if (tasks.length === 0) return "No background tasks running.";
  return tasks.map((t) => `${t.id} (${t.kind}, ${formatDuration(nowMs - t.startedAt)}) ${t.name}`).join("\n");
}

/** A bounded slice of a task log from a byte offset (undefined = the tail). */
function readLogChunk(
  path: string,
  from: number | undefined,
  cap: number,
): { text: string; next: number; bytes: number } | undefined {
  try {
    const size = statSync(path).size;
    if (size === 0) return { text: "", next: 0, bytes: 0 };
    const start = from === undefined ? Math.max(0, size - cap) : Math.min(from, size);
    const len = Math.min(cap, size - start);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      // A tail/offset can start mid-codepoint; drop the lone leading
      // replacement character rather than printing it.
      return { text: buf.toString("utf8").replace(/^\uFFFD/, ""), next: start + len, bytes: len };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // log missing (killed) or unreadable
  }
}

/**
 * The peek side of task management: state, elapsed time, and new output since
 * the last check — pull-based, so no turn is spent while a task is quiet. The
 * byte offsets live in this tool's closure: session-scoped, and a fresh
 * session starts at the tail again, which is the useful default after resume.
 */
export function createTaskTool(registry: TaskRegistry, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const peekOffsets = new Map<string, number>();
  return {
    name: "task",
    label: "Task status",
    description: `Check on a background task (t-xxxxx) without waiting: state, elapsed time, and — for bash tasks — new output since your last check (the first check shows the last 4KB). Call with no id to list running tasks and pending check-ins.
Task ids come from bash (wait: background or auto), backgrounded subagents, or background wake messages.`,
    promptSnippet: "Check on a background task",
    promptGuidelines: [
      "Use task <id> to peek at a running task instead of waiting or polling; it returns only the output since your last check.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task id to check, e.g. t-1134z8v. Omit to list running tasks." })),
    }),
    async execute(
      _id: string,
      params: { id?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ToolCtx | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { kind: "task"; id?: string };
      isError?: boolean;
    }> {
      const taskId = params.id?.trim();
      if (!taskId) {
        const text = `${describeRunningTasks(registry.running(), now())}${describeReminders(registry.reminders())}`;
        return { content: [{ type: "text", text }], details: { kind: "task" } };
      }
      const task = registry.get(taskId);
      if (!task) {
        return {
          content: [
            { type: "text", text: `No task ${taskId}. Running:\n${describeRunningTasks(registry.running(), now())}` },
          ],
          details: { kind: "task", id: taskId },
          isError: true,
        };
      }
      // A settled task's duration is its run time (endedAt - startedAt); now()
      // would grow forever after completion.
      const elapsed = formatDuration((task.endedAt ?? now()) - task.startedAt);
      if (task.state !== "running") {
        const statusLine = task.status ? `, ${task.status}` : "";
        let text = `${task.id} (${task.kind}, ${task.state}${statusLine}, ${elapsed}) ${task.name}`;
        if (task.state === "killed") {
          text += " — killed; its output was discarded.";
        } else if (task.kind === "bash") {
          const sessionDir = ctx?.sessionManager?.getSessionDir?.();
          const logPath = sessionDir ? outputLogPath(sessionDir, task.id) : tempOutputLogPath(task.id);
          text += existsSync(logPath)
            ? `\nFull output: ${logPath} (the completion wake carried the tail).`
            : " — the completion wake carried its output.";
        } else {
          text += " — the completion wake carried its reply.";
        }
        return { content: [{ type: "text", text }], details: { kind: "task", id: task.id } };
      }
      if (task.kind === "subagent") {
        return {
          content: [
            {
              type: "text",
              text: `${task.id} (subagent, running, ${elapsed}) ${task.name} — still running; subagent tasks have no streaming output, the result arrives in its wake.`,
            },
          ],
          details: { kind: "task", id: task.id },
        };
      }
      // Running bash task: read only what has appeared since the last peek;
      // the first peek shows the tail so a long log doesn't flood the check.
      const sessionDir = ctx?.sessionManager?.getSessionDir?.();
      const logPath = sessionDir ? outputLogPath(sessionDir, task.id) : tempOutputLogPath(task.id);
      const chunk = readLogChunk(logPath, peekOffsets.get(task.id), WAKE_TEXT_CAP);
      if (chunk === undefined) {
        return {
          content: [{ type: "text", text: `${task.id} (bash, running, ${elapsed}) ${task.name} — (no output yet)` }],
          details: { kind: "task", id: task.id },
        };
      }
      peekOffsets.set(task.id, chunk.next);
      const body = chunk.text ? `\nNew output (${formatSize(chunk.bytes)}):\n${chunk.text}` : "\n(no output yet)";
      return {
        content: [{ type: "text", text: `${task.id} (bash, running, ${elapsed}) ${task.name}${body}` }],
        details: { kind: "task", id: task.id },
      };
    },
  };
}

/** The agent-side lever: kill one background task by id, whatever spawned it. */
export function createTaskKillTool(
  registry: TaskRegistry,
  opts: { now?: () => number; onKilled?: (id: string) => void } = {},
) {
  const now = opts.now ?? Date.now;
  return {
    name: "task_kill",
    label: "Kill background task",
    description: `Kill one running background task by id (t-xxxxx) — a backgrounded bash command or subagent alike.
The task stops immediately and its result never arrives. Ids come from bash (wait: background or auto), a backgrounded subagent's notice, or a background wake message.`,
    promptSnippet: "Kill a background task by id",
    promptGuidelines: [
      "Reach for task_kill when a backgrounded command or subagent is no longer wanted — stopped tasks are gone for good, so re-launch if the work is still needed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task id to kill, e.g. t-1134z8v" }),
    }),
    async execute(
      _id: string,
      params: { id: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { kind: "task_kill"; killed: boolean; id: string };
      isError?: boolean;
    }> {
      const id = params.id?.trim();
      const killed = registry.kill(id);
      if (!killed) {
        return {
          content: [
            {
              type: "text",
              text: `No running task ${id ?? "(none)"}. Running:\n${describeRunningTasks(registry.running(), now())}`,
            },
          ],
          details: { kind: "task_kill", killed: false, id: id ?? "" },
          isError: true,
        };
      }
      opts.onKilled?.(id ?? "");
      return {
        content: [{ type: "text", text: `Killed ${id}. No wake will arrive for it.` }],
        details: { kind: "task_kill", killed: true, id: id ?? "" },
      };
    },
  };
}

/**
 * The check-in lever: at most one one-shot timer per running task (re-arm
 * replaces, omitting in_ms cancels). The fire is dropped when the task has
 * settled — the completion wake already delivered the result, so a reminder
 * could only burn a turn on stale news.
 */
export function createTaskRemindTool(registry: TaskRegistry, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  return {
    name: "task_remind",
    label: "Schedule task check-in",
    description: `Schedule a one-shot check-in on a running background task (t-xxxxx): after in_ms, a wake message reports that it is still running, with elapsed time and your note. If the task settles first, the check-in is dropped — the completion wake already carries the result. Re-arming replaces the pending check-in for that task; omit in_ms to cancel it.
Use this instead of sleep-looping to check on long builds, servers, or watchers.`,
    promptSnippet: "Schedule a check-in on a background task",
    promptGuidelines: [
      "Use task_remind to check on a long-running task later instead of sleeping or polling; the wake arrives automatically and says whether the task is still running.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task id to check in on, e.g. t-1134z8v" }),
      in_ms: Type.Optional(
        Type.Number({
          description: "Delay in milliseconds. Omit to cancel the pending check-in for this task.",
        }),
      ),
      note: Type.Optional(Type.String({ description: "What to check when the reminder fires." })),
    }),
    async execute(
      _id: string,
      params: { id: string; in_ms?: number; note?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { kind: "task_remind"; id: string; in_ms?: number };
      isError?: boolean;
    }> {
      const id = params.id?.trim();
      if (!id) {
        return {
          content: [{ type: "text", text: "task_remind: id is required" }],
          details: { kind: "task_remind", id: "" },
          isError: true,
        };
      }
      if (params.in_ms === undefined) {
        const cancelled = registry.cancelReminder(id);
        if (!cancelled) {
          return {
            content: [{ type: "text", text: `No pending check-in for ${id}.` }],
            details: { kind: "task_remind", id: id ?? "" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Cancelled the pending check-in for ${id}.` }],
          details: { kind: "task_remind", id: id ?? "" },
        };
      }
      if (!Number.isInteger(params.in_ms) || params.in_ms < 1 || params.in_ms > MAX_TIMEOUT_MS) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid in_ms: must be a whole number of milliseconds up to ${MAX_TIMEOUT_MS} (about 24 days).`,
            },
          ],
          details: { kind: "task_remind", id: id ?? "" },
          isError: true,
        };
      }
      const ms = params.in_ms;
      const note = params.note?.trim() || undefined;
      if (!registry.remind(id, ms, note)) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot set a check-in for ${id}: the task is not running. Running:\n${describeRunningTasks(
                registry.running(),
                now(),
              )}`,
            },
          ],
          details: { kind: "task_remind", id: id ?? "" },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Check-in set for ${id} in ${formatDuration(ms)}${note ? ` — ${note}` : ""}; you'll be woken with its status if it is still running.`,
          },
        ],
        details: { kind: "task_remind", id: id ?? "", in_ms: ms },
      };
    },
  };
}

/** The user-side lever: /tasks lists running tasks and check-ins; /tasks kill <id|all> stops one or all. */
export function createTasksCommand(registry: TaskRegistry, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const listing = () => `${describeRunningTasks(registry.running(), now())}${describeReminders(registry.reminders())}`;
  const usage = () => `Usage: /tasks — list running tasks; /tasks kill <t-xxxxx | all>\n\n${listing()}`;
  return {
    description: "List background tasks and check-ins, or kill: /tasks kill <id | all>",
    handler: async (
      args: string,
      ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): unknown } },
    ) => {
      // Verb-first subcommands, matching pi's own /mcp add|remove|list grammar:
      // self-documenting on a mistype, extensible beyond kill without breaking.
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(listing(), "info");
        return;
      }
      const [verb, target] = parts;
      if (verb !== "kill" || !target || parts.length > 2) {
        ctx.ui.notify(usage(), "info");
        return;
      }
      if (target === "all") {
        const n = registry.killAll();
        ctx.ui.notify(
          n > 0 ? `Killed ${n} task${n === 1 ? "" : "s"}. Their wakes will not arrive.` : "No running tasks.",
          n > 0 ? "warning" : "info",
        );
        return;
      }
      if (registry.kill(target)) {
        ctx.ui.notify(`Killed ${target}. Its wake will not arrive.`, "warning");
      } else {
        ctx.ui.notify(
          `No running task ${target}. Running:\n${describeRunningTasks(registry.running(), now())}`,
          "error",
        );
      }
    },
  };
}
