/**
 * Background task core — the minimal registry behind non-blocking subagents
 * and shell commands.
 *
 * Design (the deliberate cut of a larger plan):
 * - a subagent child that outlives its adoption threshold keeps running while
 *   the parent turn moves on; when it settles, one wake message steers in
 *   with the result — delivered as the parent's next message at a turn
 *   boundary, even mid-run, so a sleep-polling model can never starve it
 *   (a real transcript entry, so recall can find it again after compaction;
 *   no status tool, no polling)
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
 * - bg commands run through pi's own local bash operations (the same
 *   createLocalBashOperations the built-in bash tool uses): identical shell
 *   resolution (Unix /bin/bash → PATH → sh; Windows Git Bash), identical env
 *   (pi's bin dir on PATH, this session's PI_* vars), identical process-tree
 *   kill, identical #5303-safe wait on detached descendants, and the 128+signal
 *   exit-code convention. bg-only deltas are deliberate: non-blocking + wake,
 *   a bounded default timeout, a small wake cap, and the full command output
 *   stashed beside the session at <sessionDir>/bg/<id>.log (or a temp file with
 *   no session dir) instead of pi's temp file — it survives resume
 * - PI_BG_WAKE=0 disables wake messages; the terminal notification still fires
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createLocalBashOperations,
  truncateTail,
  DEFAULT_MAX_LINES,
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
}

/** The handle runChild hands over at adoption: the child's eventual outcome, plus a kill switch. */
export interface AdoptedHandle<T = { text: string; usage?: unknown }> {
  completion: Promise<T>;
  kill: () => void;
  /** Child spawn time (ms epoch), so wakes can report total runtime, not just background time. */
  startedAt: number;
}

export interface BackgroundDeps {
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
}

export interface BackgroundRegistry {
  /** Register a running task; returns its id (bg-1, bg-2, …). */
  adopt(record: { name: string; kind: "subagent" | "bash"; kill: () => void }): string;
  /** Record the outcome and deliver the wake exactly once; a no-op for unknown or non-running tasks. */
  complete(id: string, wake: { ok: boolean; text: string }): void;
  /** Tasks still running, oldest first. */
  running(): BgTask[];
  /** Whether the task exists and has not settled or been killed. */
  isRunning(id: string): boolean;
  /** Kill every running task and mark it killed — no wakes fire for killed tasks. Returns how many were killed. */
  killAll(): number;
  /** Kill one task by id; true when it existed and was running. Killed tasks never wake. */
  kill(id: string): boolean;
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
  noun: "reply" | "output" = "reply",
): { text: string; resultPath?: string } {
  if (text.length <= cap) return { text };
  if (!sessionDir) {
    return { text: `${text.slice(0, cap)}\n[… truncated — no session dir to stash the full ${noun} …]` };
  }
  const resultPath = stashPath(sessionDir, id);
  try {
    mkdirSync(join(sessionDir, "bg"), { recursive: true });
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

  // Mark killed before killing: the child's close event must find a
  // non-running task, and a failed kill surfaces through the process exit.
  const killTask = (task: (BgTask & { kill: () => void }) | undefined): boolean => {
    if (!task || task.state !== "running") return false;
    task.state = "killed";
    task.endedAt = now();
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
    isRunning(id) {
      return tasks.get(id)?.state === "running";
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
  };
}

/**
 * The bg tool: a shell command adopted into the same registry as subagents —
 * one footer count, one shutdown kill, the same wake channel. The tool returns
 * a task id immediately; the exit status and output tail arrive in the wake.
 *
 * Execution is delegated to pi's local bash operations (createLocalBashOperations
 * — the public API pi exposes for exactly this), so a backgrounded command
 * behaves identically to an inline bash tool call: same shell resolution,
 * env, cwd validation, process-tree kill, wait semantics, and exit codes.
 */

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
  return join(sessionDir, "bg", `${id}.log`);
}

/** Temp-file fallback when the session has no dir — mirrors pi's pi-bash-*.log temp files. */
export function tempOutputLogPath(id: string): string {
  return join(tmpdir(), `pi-bg-${id}.log`);
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
 * The environment a bg command sees — mirrors pi's built-in bash tool
 * (resolveSpawnContext with exposeSessionEnvironment defaulting to true, on top
 * of getShellEnv's bin-dir PATH prepend):
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

export interface BgToolResult {
  content: { type: "text"; text: string }[];
  details: { kind: "bash"; id?: string };
  isError?: boolean;
}

export function createBgTool(
  registry: BackgroundRegistry,
  opts: { operations?: BashOperations; defaultTimeoutMs?: number; now?: () => number } = {},
) {
  const operations = opts.operations ?? createLocalBashOperations();
  const now = opts.now ?? Date.now;
  return {
    name: "bg",
    label: "Background shell",
    description: `Run a shell command in the background and return immediately with a task id.
When the command exits, its wake is delivered to you automatically as your next message — even mid-run, while you keep working — carrying the exit status, duration, and the tail of its combined output; long output is saved to a file whose path the message includes. Never sleep or poll waiting for it.
Use for long-running commands whose result you need later — builds, test suites, migrations — not for output you need inline. A timeout (default 10m) SIGKILLs; kill_task can stop a task early.`,
    promptSnippet: "Background a long-running shell command",
    promptGuidelines: [
      "Use bg for shell commands whose result you need later but don't need to wait for (builds, test suites, migrations).",
      "Prefer the regular bash tool when you need the output to proceed — bg never blocks and never returns output inline.",
      "Background results are delivered to you automatically as your next message, even mid-run — keep working and they will reach you; never sleep or poll waiting for one.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout_ms: Type.Optional(
        Type.Number({ description: "SIGKILL the command after this many milliseconds (default 10m)" }),
      ),
    }),
    async execute(
      _id: string,
      params: { command: string; timeout_ms?: number },
      signal: AbortSignal | undefined,
      _onUpdate: undefined, // unused: bg never streams partials; loose type to satisfy bivariant method checks
      ctx:
        | {
            cwd?: string;
            sessionManager?: {
              getSessionDir(): string | undefined;
              getSessionId(): string | undefined;
              getSessionFile?(): string | undefined;
            };
            model?: { provider: string; id: string } | undefined;
            thinkingLevel?: string | undefined;
          }
        | undefined,
    ): Promise<BgToolResult> {
      const command = params.command?.trim();
      if (!command) {
        return {
          content: [{ type: "text" as const, text: "bg: command is required" }],
          details: { kind: "bash" },
          isError: true,
        };
      }
      const cwd = ctx?.cwd ?? process.cwd();
      // pi's bash tool validates the working directory up front with a clear
      // error; do the same before adopting so a bad cwd is an immediate tool
      // error, not a stray "failed" wake for a task that never ran.
      if (!existsSync(cwd)) {
        return {
          content: [{ type: "text" as const, text: `Working directory does not exist: ${cwd}` }],
          details: { kind: "bash" },
          isError: true,
        };
      }
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      const startedAt = now();
      const timeoutMs = clampTimeoutMs(params.timeout_ms, opts.defaultTimeoutMs ?? 10 * 60_000);
      const env = buildBashEnv(process.env, {
        agentDir: piAgentDir(),
        sessionId: ctx?.sessionManager?.getSessionId?.(),
        sessionFile: ctx?.sessionManager?.getSessionFile?.(),
        provider: ctx?.model?.provider,
        model: ctx?.model?.id,
        thinkingLevel: ctx?.thinkingLevel,
      });
      // One controller per task: registry kills (kill_task, /tasks, shutdown)
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
      // Full output, streamed to a log once it will overflow the wake — pi's
      // bash tool does the same with a temp file. rawChunks replay to the log
      // when it opens late, so the log is complete from byte zero.
      let rawChunks: Buffer[] = [];
      let totalBytes = 0;
      let logStream: import("node:fs").WriteStream | undefined;
      let logPath: string | undefined;
      let logFailed = false;
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
      const ensureLog = () => {
        if (logStream || logFailed) return;
        logPath = sessionDir ? outputLogPath(sessionDir, id) : tempOutputLogPath(id);
        try {
          if (sessionDir) mkdirSync(join(sessionDir, "bg"), { recursive: true });
          logStream = createWriteStream(logPath);
          logStream.on("error", () => {
            logFailed = true;
            logStream?.destroy();
            logStream = undefined;
          });
          for (const chunk of rawChunks) logStream.write(chunk);
          rawChunks = [];
        } catch {
          logFailed = true; // fail-open: the wake says the full output is lost
        }
      };
      const onData = (data: Buffer) => {
        // A killed or settled task is done: ignore late chunks so a delayed
        // pipe read can't resurrect the log (or grow the tail) after teardown.
        if (!registry.isRunning(id)) return;
        totalBytes += data.length;
        const next = Buffer.concat([tail, data]);
        tail = next.subarray(next.length - BASH_TAIL_CAP);
        if (totalBytes > WAKE_TEXT_CAP) {
          ensureLog();
          logStream?.write(data);
        } else if (data.length > 0) {
          rawChunks.push(data);
        }
      };
      const settle = (status: string, ok: boolean) => {
        signal?.removeEventListener("abort", onOuterAbort);
        logStream?.end();
        // A task killed by kill_task/shutdown completes (and would compose its
        // wake) as a no-op — guard before composing so it leaves nothing behind.
        if (!registry.isRunning(id)) return;
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
          text: formatBashWake({
            command,
            id,
            status,
            durationMs: now() - startedAt,
            output: display.content,
            outputNote: note,
          }),
        });
      };
      let execPromise: Promise<{ exitCode: number | null }>;
      try {
        // pi's local ops take the timeout in seconds; the tree kill on
        // timeout/abort and the #5303-safe wait live inside ops.exec.
        execPromise = operations.exec(command, cwd, {
          onData,
          signal: controller.signal,
          timeout: timeoutMs / 1000,
          env,
        });
      } catch (error) {
        settle(`failed: ${error instanceof Error ? error.message : String(error)}`, false);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to start command: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { kind: "bash", id },
          isError: true,
        };
      }
      void execPromise.then(
        ({ exitCode }) =>
          // ops.exec already maps signal kills to 128 + signal number, so a
          // plain "exited N" matches the built-in bash tool's convention.
          settle(exitCode === null ? "terminated without an exit code" : `exited ${exitCode}`, exitCode === 0),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "aborted") settle("aborted", false);
          else if (message.startsWith("timeout:")) settle(`timed out after ${formatDuration(timeoutMs)}`, false);
          else settle(`failed: ${message}`, false);
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Backgrounded (${id}): ${bashCommandHead(command)}\nWhen the command exits, the exit status and output tail are delivered to you automatically as your next message — even mid-run, while you keep working. Continue other work if you have any; never sleep or poll waiting for it.`,
          },
        ],
        details: { kind: "bash", id },
      };
    },
  };
}

/** One line of the /tasks listing and the kill_task error hint. */
export function describeRunningTasks(tasks: BgTask[], nowMs: number = Date.now()): string {
  if (tasks.length === 0) return "No background tasks running.";
  return tasks.map((t) => `${t.id} (${t.kind}, ${formatDuration(nowMs - t.startedAt)}) ${t.name}`).join("\n");
}

/** The agent-side lever: kill one background task by id, whatever spawned it. */
export function createKillTaskTool(
  registry: BackgroundRegistry,
  opts: { now?: () => number; onKilled?: (id: string) => void } = {},
) {
  const now = opts.now ?? Date.now;
  return {
    name: "kill_task",
    label: "Kill background task",
    description: `Kill one running background task by id (bg-1, bg-2, …) — a backgrounded shell command or subagent alike.
The task stops immediately and its result never arrives. Ids come from the bg tool's return, a backgrounded subagent's notice, or a background wake message.`,
    promptSnippet: "Kill a background task by id",
    promptGuidelines: [
      "Reach for kill_task when a backgrounded command or subagent is no longer wanted — stopped tasks are gone for good, so re-launch if the work is still needed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task id to kill, e.g. bg-2" }),
    }),
    async execute(
      _id: string,
      params: { id: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { killed: boolean; id: string };
      isError?: boolean;
    }> {
      const id = params.id?.trim();
      const killed = registry.kill(id);
      if (!killed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No running task ${id ?? "(none)"}. Running:\n${describeRunningTasks(registry.running(), now())}`,
            },
          ],
          details: { killed: false, id: id ?? "" },
          isError: true,
        };
      }
      opts.onKilled?.(id ?? "");
      return {
        content: [{ type: "text" as const, text: `Killed ${id}. No wake will arrive for it.` }],
        details: { killed: true, id },
      };
    },
  };
}

/** The user-side lever: /tasks lists running tasks; /tasks <id> kills one. */
export function createTasksCommand(registry: BackgroundRegistry, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const usage = () =>
    `Usage: /tasks — list running tasks; /tasks kill <bg-N | all>\n\n${describeRunningTasks(
      registry.running(),
      now(),
    )}`;
  return {
    description: "List background tasks, or kill: /tasks kill <id | all>",
    handler: async (
      args: string,
      ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): unknown } },
    ) => {
      // Verb-first subcommands, matching pi's own /mcp add|remove|list grammar:
      // self-documenting on a mistype, extensible beyond kill without breaking.
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(describeRunningTasks(registry.running(), now()), "info");
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
