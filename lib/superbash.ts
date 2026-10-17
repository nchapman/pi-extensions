/**
 * superbash — the background-task core: the shared registry behind
 * non-blocking subagents and the unified `bash` tool, plus the task
 * management tools (task, task_kill, task_remind).
 *
 * Design (the deliberate cut of a larger plan):
 * - the registry is in-memory and session-scoped: pi reloads and exits run
 *   session_shutdown, which kills running children — an orphaned child burns
 *   API tokens with nobody consuming the result (the existing
 *   PI_SUBAGENT_TIMEOUT_MS hard kill still applies while running in the
 *   background). The one exception is persistent bash tasks (below), which
 *   shutdown spares because their state lives on disk
 * - one tool for every CLI task, named `bash` so it replaces the built-in by
 *   name: wait: "inline" (default) delegates to pi's own bash tool (identical
 *   streaming, truncation, temp-file stashing, structured output); wait: "auto"
 *   blocks for up to a ~2m window and then promotes to the
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
 *   in_secs cancels) whose fire is dropped when the task already settled — the
 *   completion wake already delivered the result, so a heartbeat could only
 *   burn turns on silence
 * - full replies over the wake cap are stashed beside the session at
 *   <sessionDir>/tasks/<id>.txt with a pointer in the wake (stash-and-pointer, recoverable after compaction);
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
 * - wait: "background" + persist: true opts a bash task into surviving pi
 *   itself (lib/persistent-bash holds the design: detached group leader, a
 *   wrapper that records the exit status, metadata under the session dir).
 *   Explicit persist that cannot be honored (non-background wait, tools built
 *   on a prepare seam, no session dir) is a loud error; PI_BG_BASH_PERSIST=1
 *   defaults background mode to persistent wherever those gates already pass,
 *   and persist: false overrides it. Shutdown detaches (spares) persistent
 *   tasks instead of killing them; resumePersistedTasks re-adopts live ones
 *   under their on-disk id and settles the rest — disk state, not memory, owns
 *   the outcome, so exactly one runtime ever wakes for a given task
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
  getShellConfig,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import {
  isProcessAlive,
  killPersistedTask,
  parseBashPersist,
  persistentLogPath,
  readStatusSync,
  removePersistedArtifacts,
  scanSessionTasks,
  spawnPersistentTask,
  taskEnv,
  taskStatusPath,
  writeTaskMeta,
  type KillOutcome,
  type PersistentTaskMeta,
  type ScanDeps,
  type ScanOutcome,
} from "./persistent-bash";

/** Budget (chars for replies, bytes for command output) that rides inline in the wake message. */
export const WAKE_TEXT_CAP = 4_000;

/** A running or settled background task managed by the registry. */
export interface BgTask {
  id: string;
  name: string;
  kind: "subagent" | "bash";
  state: "running" | "done" | "failed" | "killed";
  startedAt: number;
  endedAt?: number;
  /** Short terminal status line ("exited 0", "completed", …) recorded on complete. */
  status?: string;
  /** True for tasks that outlive pi: spared by killAll({sparePersistent}), shown with a marker. */
  persistent?: boolean;
  /** Live progress line for check-in wakes; undefined when the kind has nothing to report.
   *  Consuming: calling it advances the reminder channel's read offset — the
   *  delta it reports is one-shot, so call it exactly once per wake. */
  progress?: () => string | undefined;
}

/** The handle runChild hands over at adoption: the child's eventual outcome, plus a kill switch. */
export interface AdoptedHandle<T = { text: string; usage?: unknown }> {
  completion: Promise<T>;
  kill: () => void;
  /** Child spawn time (ms epoch), so wakes can report total runtime, not just background time. */
  startedAt: number;
}

/** Injected external capabilities and messaging channels for the task registry. */
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

/** The session-scoped background task registry interface. */
export interface TaskRegistry {
  /** Register a running task; returns its id (t-<base36 time>, e.g. t-1134z8v). */
  adopt(
    record: {
      name: string;
      kind: "subagent" | "bash";
      kill: () => void;
      progress?: () => string | undefined;
      persistent?: boolean;
      detach?: () => void;
      /** True start time for re-adopted durable tasks, so elapsed times and
       *  ordering report since the spawn, not since the restart. */
      startedAt?: number;
    },
    preferredId?: string,
  ): string;
  /** Re-adopt a durable task under its on-disk id (persistent tasks resuming
   *  after a restart); idempotent when that id is already registered. */
  adopt(
    record: {
      name: string;
      kind: "subagent" | "bash";
      kill: () => void;
      progress?: () => string | undefined;
      persistent?: boolean;
      detach?: () => void;
      startedAt?: number;
    },
    preferredId: string,
  ): string;
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
  /** Undo a kill that never landed: flip a killed task back to running. For a
   *  re-adopted persistent task whose verified kill was declined (pid not
   *  verifiable, signal refused) — the process was never signalled, so the
   *  task must not read as dead for the rest of the session. */
  revive(id: string): boolean;
  /** Kill every running task and mark it killed — no wakes fire for killed tasks. Returns how many were killed.
   *  sparePersistent: detach persistent tasks instead — hand them to the disk
   *  state (no kill signal, no wake, dropped from the registry) so they keep
   *  running across the restart. */
  killAll(opts?: { sparePersistent?: boolean }): number;
  /** Arm (or re-arm) a one-shot check-in on a running task; false when the task is unknown or settled. */
  remind(id: string, ms: number, note?: string): boolean;
  /** Cancel the task's pending check-in; true when one was pending. */
  cancelReminder(id: string): boolean;
  /** The task's pending check-in, if any. */
  reminderFor(id: string): { ms: number; note?: string } | undefined;
  /** All pending check-ins, oldest task first. */
  reminders(): { id: string; ms: number; note?: string }[];
}

/**
 * Subagents block to completion by default — adoption never fires unless
 * background: true or PI_SUBAGENT_BG_AFTER_MS opts in. Node clamps Infinity
 * setTimeout delays to 1ms (an instant adopt), so callers must guard with
 * Number.isFinite before scheduling.
 */
export const NEVER_ADOPT_MS = Number.POSITIVE_INFINITY;

/** Millis bash (wait: auto) blocks before promoting to the background. */
export const DEFAULT_BASH_BG_AFTER_MS = 120_000;

/** Shared PI_*_BG_AFTER_MS parsing: trim first (Number("") is 0, which would
 * background instantly); negative or invalid values fall back to the default. */
function parseAfterMs(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  return raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : fallback;
}

/** Parse PI_SUBAGENT_BG_AFTER_MS: threshold in ms after which a blocking child is backgrounded. */
export function parseBgAfterMs(env: Record<string, string | undefined>): number {
  // Default: never adopt — blocking is the norm; the env knob opts into the
  // old auto-adoption window.
  return parseAfterMs(env, "PI_SUBAGENT_BG_AFTER_MS", NEVER_ADOPT_MS);
}

/** Parse PI_BASH_BG_AFTER_MS: default auto-wait window in ms before promoting bash commands. */
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
  // The wake must be content-bearing: a bare elapsed time is the only salient
  // number otherwise, and it reads as pressure — the observed 3m→1m check-in
  // escalation ended in killing a healthy run ~90s early.
  const progress =
    task.progress?.() ??
    (task.kind === "subagent" ? "subagents stream no output, so elapsed time is the only signal" : undefined);
  const progressPart = progress ? `\n${progress}` : "";
  return `[reminder] ${task.id} (${task.kind}, ${formatDuration(elapsedMs)}) still running${notePart}${progressPart}\nNothing here needs action: end your turn unless you'd act differently at a later check-in. A long elapsed time alone is not a reason to kill or restart — the completion wake is automatic; kill only if the result is no longer wanted.`;
}

/** The "Check-ins:" block appended to task listings (task tool and /tasks). */
export function describeReminders(reminders: { id: string; ms: number; note?: string }[]): string {
  if (reminders.length === 0) return "";
  return `\nCheck-ins:\n${reminders
    .map((r) => `  ${r.id} in ${formatDuration(r.ms)}${r.note ? ` — ${r.note}` : ""}`)
    .join("\n")}`;
}

/** Minimal thenable check — deliver only needs to know "has a .catch to silence". */
function isPromiseLike(v: unknown): v is { catch: (onRejected: (reason: unknown) => void) => unknown } {
  return typeof v === "object" && v !== null && typeof (v as { catch?: unknown }).catch === "function";
}

/** Create a session-scoped registry. Pure over its injected channels. */
export function createTaskRegistry(deps: TaskDeps = {}): TaskRegistry {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = deps.unschedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tasks = new Map<string, BgTask & { kill: () => void; detach?: () => void }>();
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
      if (deps.wakeEnabled !== false) {
        const sent = deps.sendUserMessage?.(text) as unknown;
        // The channel is async (pi's sendUserMessage returns a promise) and pi
        // installs no unhandledRejection handler — a late rejection would
        // crash the host after this call already returned. Swallow it: the
        // wake is lost, the session survives (mirrors the sync case below).
        if (isPromiseLike(sent)) void sent.catch(() => {});
      }
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
    adopt(record, preferredId) {
      const ts = Math.max(now(), lastTs + 1);
      lastTs = ts;
      let id = `t-${ts.toString(36)}`;
      if (preferredId) {
        // Re-adoption under the durable id: time-based ids stay unique across
        // sessions; fold the old timestamp into the monotonic guard anyway.
        const prefTs = Number.parseInt(preferredId.slice(2), 36);
        if (Number.isFinite(prefTs)) lastTs = Math.max(lastTs, prefTs);
        if (tasks.has(preferredId)) return preferredId; // idempotent re-adopt
        id = preferredId;
      }
      tasks.set(id, {
        id,
        name: record.name,
        kind: record.kind,
        state: "running",
        startedAt: record.startedAt ?? now(),
        kill: record.kill,
        progress: record.progress,
        persistent: record.persistent,
        detach: record.detach,
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
        .map(({ kill: _kill, detach: _detach, ...rest }) => rest)
        .sort((a, b) => a.startedAt - b.startedAt);
    },
    isRunning(id) {
      return tasks.get(id)?.state === "running";
    },
    get(id) {
      const task = tasks.get(id);
      if (!task) return undefined;
      const { kill: _kill, detach: _detach, ...rest } = task;
      return rest;
    },
    kill(id) {
      return killTask(tasks.get(id));
    },
    revive(id) {
      const task = tasks.get(id);
      if (!task || task.state !== "killed") return false;
      task.state = "running";
      task.endedAt = undefined;
      refreshStatus();
      return true;
    },
    killAll(opts = {}) {
      let killed = 0;
      for (const [id, task] of tasks) {
        if (opts.sparePersistent && task.persistent) {
          // Spare = detach, not abandon: cancel the pending check-in, hand the
          // monitor its goodbye (listeners off, settle guard up), then drop the
          // task entirely — as if never adopted. No kill signal, no wake; the
          // on-disk metadata is the single owner of its outcome now.
          cancelReminder(id);
          try {
            task.detach?.();
          } catch {
            // teardown is best-effort; the scan on next start is the backstop
          }
          tasks.delete(id);
          continue;
        }
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

/**
 * Session-shared handle to the registry the subagents extension registers.
 *
 * Why a holder rather than a direct import: each extension file registers
 * independently, and goal's settle check needs "are background tasks running?"
 * without depending on the subagents module (or its agents-dir loading). The
 * holder is written once at subagents registration and read lazily per event,
 * so a /reload (new registry) is picked up without re-registration order
 * mattering. Readers must treat `undefined` as "no background work" —
 * fail-open, never stall the reader on a missing writer.
 *
 * The holder hangs off a Symbol.for process-global, NOT a module-scoped
 * object: pi loads each extension file through its own jiti instance with the
 * runtime module cache disabled, so two extension files importing this module
 * can hold two separate copies — a module-scoped holder would silently never
 * connect writer to reader (the deferral would no-op in production while
 * working in tests, which share one module graph). Symbol.for keys are
 * process-global by spec, identical across every copy.
 */
const SHARED_REGISTRY_KEY = Symbol.for("pi-extensions.superbash.registry");

function sharedHolder(): { current?: TaskRegistry } {
  const globals = globalThis as Record<symbol, { current?: TaskRegistry } | undefined>;
  return (globals[SHARED_REGISTRY_KEY] ??= {});
}

/** Injectable seams for resumePersistedTasks (tests); production defaults are real. */
export interface ResumeDeps {
  /** Adoption notice channel; settled outcomes wake through the registry. */
  wake?: (text: string) => void;
  now?: () => number;
  /** Passed to the scan (tests fake the fs/ps boundaries). */
  scan?: ScanDeps;
  /** Adopted-task monitor poll cadence; default 2s. */
  pollMs?: number;
  /** Kill seam for adopted tasks (task_kill, the deadline kill); tests fake
   *  declines (unverifiable pid, refused signal) to exercise the honest
   *  fallbacks — a real decline can't be scheduled deterministically. */
  killPersisted?: (meta: PersistentTaskMeta, sessionDir: string) => Promise<KillOutcome>;
}

/** Re-adopt a durable task after a restart. No child handle exists, so a
 *  status-first poll with a liveness backstop replaces the exit event, and the
 *  deadline kill verifies the pid first — it may have recycled since the scan.
 *  detach() (spare) stops every timer; the disk metadata owns the outcome. */
function adoptPersistedMonitor(
  registry: TaskRegistry,
  sessionDir: string,
  meta: PersistentTaskMeta,
  deps: ResumeDeps,
  now: () => number,
): void {
  const head = bashCommandHead(meta.command);
  const logPath = persistentLogPath(sessionDir, meta.id);
  const killTask = deps.killPersisted ?? ((m: PersistentTaskMeta, dir: string) => killPersistedTask(m, dir));
  let handedOff = false;
  let settled = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // A dead leader gets one extra poll cycle for its status write to land
  // (the wrapper writes before exiting, but a kill does not).
  let deadTicks = 0;
  const stop = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pollTimer = undefined;
    deadlineTimer = undefined;
  };
  const settle = (status: string, ok: boolean, preread?: { output: string; note?: string }) => {
    if (handedOff || settled) return;
    settled = true;
    stop();
    removePersistedArtifacts(sessionDir, meta.id); // keep the log
    if (!registry.isRunning(id)) return;
    // A caller that already destroyed the log (deadline kill) passes what it
    // read beforehand — including whether the tail pointed at the log file,
    // which may no longer exist by now. Never recompute that pointer from
    // logPath for a pre-read tail: it can name a deleted file.
    const chunk = preread ? { text: preread.output } : readLogChunk(logPath, undefined, BASH_TAIL_CAP);
    const display = truncateTail(chunk?.text ?? "", { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
    registry.complete(id, {
      ok,
      status,
      text: formatBashWake({
        command: head,
        id,
        status,
        durationMs: now() - meta.startedAt,
        output: display.content,
        outputNote: preread
          ? preread.note
          : display.truncated
            ? `[… truncated — full output: ${logPath} …]`
            : undefined,
      }),
    });
  };
  const readTail = () => {
    const chunk = readLogChunk(logPath, undefined, BASH_TAIL_CAP);
    const display = truncateTail(chunk?.text ?? "", { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
    return {
      output: display.content,
      note: display.truncated ? `[… truncated — full output: ${logPath} …]` : undefined,
    };
  };
  const id = registry.adopt(
    {
      name: head,
      kind: "bash",
      persistent: true,
      // The durable record owns the true start time — /tasks and reminders
      // report since the spawn, not since this restart.
      startedAt: meta.startedAt,
      progress: logProgressFor(() => logPath),
      kill: () => {
        // Registry kill (task_kill, /tasks kill). The registry already reports
        // success from in-memory state; when the verified kill is declined, the
        // task is revived (it was never signalled — reading as dead while it
        // runs would lie to /tasks and the next start) and a wake says so.
        void killTask(meta, sessionDir)
          .then((outcome) => {
            if (!outcome.killed && outcome.reason !== "mismatched") {
              registry.revive(meta.id);
              deps.wake?.(
                `Background task kill not confirmed (${meta.id}): ${
                  outcome.reason === "unknown"
                    ? "its pid could not be verified (ps unavailable?)"
                    : "the signal was denied"
                } — still running (shown as such), re-examined on the next start. Try again: task_kill ${meta.id}`,
              );
            }
          })
          .catch(() => {});
      },
      detach: () => {
        handedOff = true;
        stop();
      },
    },
    meta.id,
  );
  if (meta.timeoutSecs !== undefined) {
    deadlineTimer = setTimeout(
      () => {
        if (handedOff || settled) return;
        const tail = readTail(); // a successful kill removes the log — read first
        void killTask(meta, sessionDir)
          .then((outcome) => {
            if (outcome.killed) {
              // The kill removed the log — pass the pre-read output without its
              // pointer (the file it names is gone).
              settle(`timed out after ${meta.timeoutSecs}s (deadline passed while pi was away)`, false, {
                output: tail.output,
              });
              return;
            }
            if (outcome.reason === "mismatched") {
              settle(`timed out after ${meta.timeoutSecs}s — pid was reused while pi was away; not killed`, false, {
                output: tail.output,
              });
              return;
            }
            // ps could not answer, or the signal was refused: do NOT settle —
            // the task may be healthy and its durable state is the only record
            // (the same verdict the scan leaves alone). Say so and keep
            // monitoring; the poll still settles on status or liveness.
            deps.wake?.(
              `Background task (${meta.id}) hit its ${meta.timeoutSecs}s timeout but could not be killed (${
                outcome.reason === "unknown" ? "pid not verified — ps unavailable?" : "signal denied"
              }); left running and still monitored. Kill: task_kill ${meta.id}`,
            );
          })
          .catch(() => settle(`timed out after ${meta.timeoutSecs}s`, false, tail));
      },
      Math.max(0, meta.startedAt + meta.timeoutSecs * 1000 - now()),
    );
    deadlineTimer.unref();
  }
  pollTimer = setInterval(() => {
    const status = readStatusSync(sessionDir, meta.id);
    if (status !== undefined && status.trim() !== "") {
      const code = Number.parseInt(status.trim(), 10);
      settle(Number.isInteger(code) ? `exited ${code}` : "finished while pi was away (exit code unknown)", code === 0);
      return;
    }
    if (!isProcessAlive(meta.pid)) {
      if (++deadTicks >= 2) settle("died while pi was away (exit code unknown)", false);
    } else {
      deadTicks = 0;
    }
  }, deps.pollMs ?? 2_000);
  pollTimer.unref();
}

/** Reconcile a session's durable task state with a fresh runtime: scan the
 *  tasks directory and apply every decision — report finished/dead/recycled
 *  outcomes, kill expired survivors, re-adopt live ones under their on-disk ids.
 *  Never throws (session start must not block on disk I/O); per-task failures
 *  fail open so one bad metadata file cannot hide the other tasks' outcomes. */
export async function resumePersistedTasks(
  registry: TaskRegistry,
  sessionDir: string,
  deps: ResumeDeps = {},
): Promise<ScanOutcome[]> {
  const now = deps.now ?? Date.now;
  const outcomes = await scanSessionTasks(sessionDir, deps.scan ?? {});
  for (const outcome of outcomes) {
    try {
      if (outcome.meta === undefined) {
        removePersistedArtifacts(sessionDir, outcome.id); // discard; keep log for forensics
        continue;
      }
      const meta = outcome.meta;
      const head = bashCommandHead(meta.command);
      const logPath = persistentLogPath(sessionDir, meta.id);
      const logTail = () => {
        const chunk = readLogChunk(logPath, undefined, BASH_TAIL_CAP);
        const display = truncateTail(chunk?.text ?? "", { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
        return {
          output: display.content,
          note: display.truncated ? `[… truncated — full output: ${logPath} …]` : undefined,
        };
      };
      // Report a task that no longer runs: register it under its durable id
      // (the durable record owns the true start time — /tasks and reminders
      // report since the spawn, not since this restart) and settle immediately,
      // so the wake flows through the registry's channels and /tasks history
      // records what happened.
      const reportSettled = (status: string, ok: boolean) => {
        const id = registry.adopt(
          {
            name: head,
            kind: "bash",
            persistent: true,
            kill: () => undefined,
            detach: () => undefined,
            startedAt: meta.startedAt,
          },
          meta.id,
        );
        const tail = logTail();
        registry.complete(id, {
          ok,
          status,
          text: formatBashWake({
            command: head,
            id,
            status,
            durationMs: now() - meta.startedAt,
            output: tail.output,
            outputNote: tail.note,
          }),
        });
      };
      switch (outcome.decision.action) {
        case "complete": {
          const code = outcome.decision.exitCode;
          const overran = meta.timeoutSecs !== undefined && now() >= meta.startedAt + meta.timeoutSecs * 1000;
          removePersistedArtifacts(sessionDir, meta.id);
          reportSettled(
            code === null
              ? "finished while pi was away (exit code unknown)"
              : `exited ${code} (finished while pi was away${overran ? "; overran its timeout" : ""})`,
            code === 0,
          );
          break;
        }
        case "finalize-dead":
          removePersistedArtifacts(sessionDir, meta.id);
          reportSettled("died while pi was away (exit code unknown)", false);
          break;
        case "finalize-recycled":
          removePersistedArtifacts(sessionDir, meta.id);
          reportSettled("lost while pi was away (its pid was reused; exit code unknown)", false);
          break;
        case "kill-expired": {
          const tail = logTail(); // read before any kill removes the log
          const outcome = await killPersistedTask(meta, sessionDir);
          const id = registry.adopt(
            {
              name: head,
              kind: "bash",
              persistent: true,
              kill: () => undefined,
              detach: () => undefined,
              startedAt: meta.startedAt,
            },
            meta.id,
          );
          const statusText = outcome.killed
            ? "timed out — deadline passed while pi was away"
            : outcome.reason === "mismatched"
              ? "timed out — deadline passed while pi was away (pid was reused; not killed)"
              : "timed out — deadline passed while pi was away (could not be killed; left for the next start)";
          registry.complete(id, {
            ok: false,
            status: "timed out",
            text: formatBashWake({
              command: head,
              id,
              status: statusText,
              durationMs: now() - meta.startedAt,
              output: tail.output, // captured before the kill
              // Only point at the log when it still exists (kept on a decline,
              // removed on a kill or a recycled pid).
              outputNote: outcome.killed || outcome.reason === "mismatched" ? undefined : tail.note,
            }),
          });
          break;
        }
        case "unknown-identity":
          // ps could not answer: neither adopt (its kill would be a no-op) nor
          // destroy (the task may be healthy). Leave the durable state for the
          // next start to retry, and say so.
          deps.wake?.(
            `Background task may still be running (${meta.id}): ${head} — its identity could not be verified (is ps available?); left untouched for the next start.`,
          );
          break;
        case "adopt":
          adoptPersistedMonitor(registry, sessionDir, meta, deps, now);
          deps.wake?.(
            `Background task still running (${meta.id}): ${head} — it survived the restart and was re-adopted; its outcome will be delivered when it exits. Peek: task ${meta.id}`,
          );
          break;
        case "discard":
          removePersistedArtifacts(sessionDir, meta.id);
          break;
      }
    } catch {
      // One task's resume must not sink the rest — fail open per task.
    }
  }
  return outcomes;
}

/** Publish the session's registry for cross-extension readers (goal's settle check). */
export function publishSharedTaskRegistry(registry: TaskRegistry): void {
  sharedHolder().current = registry;
}

/** The session's live task registry, if the subagents extension has registered one. */
export function getSharedTaskRegistry(): TaskRegistry | undefined {
  return sharedHolder().current;
}

/** Rolling per-command output kept in memory so a chatty process can't grow the parent. */
export const BASH_TAIL_CAP = 8_192;

/** Tail cap for a check-in wake's progress line — a nudge, not a dump. */
export const REMINDER_TAIL_CAP = 500;

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

/** The fixed prefixes of this package's three machine-written wake messages. */
const WAKE_PREFIXES = ['[background] subagent "', "[background] bash (t-", "[reminder] t-"];

/**
 * True when text is one of this package's machine-written wake messages (a
 * background completion or a check-in). Consumers that classify agent starts
 * — todo's staleness counter, say — use this to tell a wake-driven start from
 * an agent- or user-driven one: the prefixes are fixed by the formatters
 * above, and the tests pin all three outputs to this predicate.
 */
export function isWakeMessage(text: string | undefined): boolean {
  return text !== undefined && WAKE_PREFIXES.some((p) => text.trimStart().startsWith(p));
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

/** The unified bash shape plus any params a sibling tool adds (ssh_bash's
 * target/port/key): values of the extras are the extension's to validate. */
export type BashToolCallParams = {
  command: string;
  timeout?: number;
  wait?: BashWaitMode;
  /** Opt the background command into surviving pi restarts (background mode only). */
  persist?: boolean;
} & Record<string, unknown>;

/** Per-call provisioning from a `prepare` hook: the operations this call runs
 * through, an optional inline executor over them, and the one-line task name
 * for the registry and wakes (default: the command head). */
export interface BashCallContext {
  operations: BashOperations;
  inline?: BashInlineExecutor;
  head?: string;
}

export interface BashToolResult extends AgentToolResult {
  details: { kind: "bash"; mode: BashWaitMode; id?: string };
}

/** Live-output update cadence while an auto call is still blocking — pi's own
 * BASH_UPDATE_THROTTLE_MS. */
const UPDATE_THROTTLE_MS = 100;

/**
 * The unified bash tool — replaces the built-in by name and covers the whole
 * range of "run a CLI task":
 * - wait: "inline" (default) — delegates to pi's own bash tool (same streaming,
 *   truncation, temp-file stashing, structured output); no task is registered
 * - wait: "auto" — blocks up to the window, streaming live output to
 *   the TUI; a command that finishes in time returns a built-in-style result
 *   inline, one that doesn't is promoted to the background and the tool
 *   returns its task id, with the wake delivering the result later
 * - wait: "background" — returns the task id immediately
 * Auto and background run through pi's local bash operations with a full
 * output log, so `task <id>` can peek at any point and the output survives
 * resume.
 */
export function createBashTool(
  registry: TaskRegistry | (() => TaskRegistry | undefined),
  opts: {
    operations?: BashOperations;
    /** Inline executor; defaults to pi's own bash tool. */
    inline?: BashInlineExecutor;
    /** Auto-promote window in ms; a function is called per invocation so env changes apply without a reload. */
    waitMs?: number | (() => number);
    now?: () => number;
    /** Tool identity overrides for sibling tools built on the same core
     * (ssh_bash); the default is the built-in-replacing `bash`. */
    name?: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    /** Extra parameter schemas merged into the tool's parameters. */
    extraParams?: Record<string, TSchema>;
    /** Per-call provisioning (ssh_bash resolves the target into operations
     * and a task head); when given it replaces the static operations/inline. */
    prepare?: (params: BashToolCallParams) => BashCallContext;
    /** Test seam and overrides for the persistent-background spawn.
     *  localOperations: declare that an injected `operations` seam still runs
     *  commands on the local host (the subagents wiring harness) — persistence
     *  stays available for such tools; other injections are refused. */
    persistent?: {
      shell?: string;
      shellArgs?: string[];
      spawn?: typeof import("node:child_process").spawn;
      localOperations?: boolean;
    };
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
  // The inline executor for prepare-based tools that don't supply one: pi's
  // own bash definition over this call's operations, so streaming, truncation,
  // and structured output stay identical to the built-in bash tool.
  const inlineFromOps = (ops: BashOperations): BashInlineExecutor => {
    const def = createBashToolDefinition(process.cwd(), { operations: ops });
    return (toolCallId, params, signal, onUpdate, ctx) =>
      def.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
        ctx as never,
      ) as unknown as Promise<InlineResult>;
  };
  const name = opts.name ?? "bash";
  return {
    name,
    label: opts.label ?? name,
    description:
      opts.description ??
      `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); when truncated, the full output is saved to a file whose path the result includes.
wait: "inline" (default) blocks until the command finishes and returns its output — waiting on a tool call costs nothing, so this is the normal choice; pass a timeout to bound a command you're unsure about. wait: "auto" blocks up to ~${formatDuration(descWindowMs)} — a command that finishes in time returns its output inline, one that doesn't move to the background and return a task id (t-xxxxx). "background" returns a task id immediately — for work you'll do other things while it runs. A backgrounded command's result (exit status, duration, output tail) is delivered to you automatically as your next message, even mid-run — if you have nothing else to do, end your turn and the wake re-engages you; never sleep or poll to wait. Peek at a running task with task <id> only when its new output would change what you do; stop it with task_kill.
persist: true (wait: "background" only) detaches the command from pi entirely: it keeps running across pi exits and restarts, logs to the session's tasks directory, and its outcome is reported when the session resumes. The default is non-persistent; PI_BG_BASH_PERSIST=1 flips the default for background mode.
Timeout is in seconds, optional, no default — a command without a timeout runs until it finishes or is killed (0 also means no timeout).`,
    promptSnippet: opts.promptSnippet ?? "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: opts.promptGuidelines ?? [
      "Default to plain blocking (inline): waiting on a tool call costs nothing. Use wait: background for long-running work (builds, test suites, migrations) you have other work to do alongside; wait: auto only when you want a bounded block before backgrounding.",
      "Background results are delivered to you automatically as your next message, even mid-run — if you have nothing else to do, end your turn; the wake re-engages you. Never sleep or poll to wait.",
      "Peek at a running task with task <id> only when new output would change what you do; otherwise end your turn and let the completion wake re-engage you. Stop a task with task_kill.",
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
          description: `inline (default): block and return output. auto: block up to ~${formatDuration(descWindowMs)}, then move to the background. background: return a task id immediately.`,
        }),
      ),
      persist: Type.Optional(
        Type.Boolean({
          description: `With wait: "background" only: keep the command running across pi restarts (outcome reported on session resume).`,
        }),
      ),
      ...(opts.extraParams ?? {}),
    }),
    async execute(
      toolCallId: string,
      params: BashToolCallParams,
      signal: AbortSignal | undefined,
      onUpdate: BashOnUpdate | undefined,
      ctx: ToolCtx | undefined,
    ): Promise<BashToolResult> {
      const mode: BashWaitMode = params.wait ?? "inline";
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
      // persist composes only with background — reject before any execution leg
      // (inline would otherwise delegate to pi's built-in and fail differently).
      if (params.persist === true && mode !== "background") {
        return error(`persist: true requires wait: "background" (got "${mode}")`);
      }
      // Per-call provisioning: a prepare hook (sibling tools) supplies the
      // operations this call runs through, an inline executor over them, and
      // the task head that names the command in the registry, wakes, and the
      // backgrounded notice. Without one, the static factories stand.
      const prep = opts.prepare?.(params) ?? { operations, inline: runInline };
      const inlineExec = prep.inline ?? (opts.prepare ? inlineFromOps(prep.operations) : runInline);
      const taskHead = prep.head ?? bashCommandHead(command);
      // Inline is the built-in, byte for byte: no task, no wake, no log.
      if (mode === "inline") {
        try {
          const result = await inlineExec(toolCallId, { command, timeout: timeoutSecs }, signal, onUpdate, ctx);
          return {
            ...result,
            details: { kind: "bash", mode, ...(result.details as Record<string, unknown> | undefined) },
          } as BashToolResult;
        } catch (e) {
          return error(e instanceof Error ? e.message : String(e));
        }
      }
      // A lazy registry (sibling tools read the session's shared registry per
      // call) may be absent; inline already ran above, so only the background
      // legs need it, and the error says exactly which mode still works.
      const reg = typeof registry === "function" ? registry() : registry;
      if (!reg) {
        return error(`${name}: background execution unavailable (no task registry); use wait: "inline"`);
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
      // ---- persistent background leg ----
      // Explicit persistence must pass every gate loudly (an explicit request
      // that silently downgraded would strand a task the agent believes is
      // durable). The PI_BG_BASH_PERSIST default applies only where the gates
      // already pass, so sibling tools (ssh_bash) and non-background modes
      // silently keep the pipe path.
      // Persistence runs the command through a local detached spawn — a tool
      // whose execution backend was replaced (per-call prepare, injected
      // operations, or an inline executor: container, remote, jailed) must not
      // silently lose that confinement because the model asked to persist.
      // localOperations re-enables it for seams that still execute locally.
      const localBackend =
        !opts.prepare && !opts.inline && (!opts.operations || opts.persistent?.localOperations === true);
      const persistGatesPass = localBackend && process.platform !== "win32" && !!sessionDir && mode === "background";
      const persistWanted = params.persist ?? (mode === "background" && parseBashPersist(process.env));
      if (params.persist === true && !persistGatesPass) {
        if (!localBackend)
          return error(
            `${name}: persistent background tasks are not supported for this tool (custom execution backend)`,
          );
        if (process.platform === "win32") return error("Persistent background tasks are not supported on Windows");
        return error("Persistent background tasks require a session directory");
      }
      // The persistent leg: spawn the wrapper detached (own process group,
      // stdio straight to the append-mode log), write the durable metadata
      // that a later session scans for, and monitor to a single settle. Full
      // rationale in lib/persistent-bash.ts and the design doc.
      const runPersistent = (): BashToolResult => {
        const dir = sessionDir as string; // gates guaranteed it
        let logPath: string | undefined;
        let meta: PersistentTaskMeta | undefined;
        let child: ReturnType<typeof spawnPersistentTask> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        // Single settle + handoff guard: after detach() the on-disk metadata
        // owns the outcome and nothing in this runtime may fire for the task.
        let handedOff = false;
        let settled = false;
        const stopMonitor = () => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (pollTimer) clearInterval(pollTimer);
          deadlineTimer = undefined;
          pollTimer = undefined;
          if (child) {
            child.removeAllListeners("exit");
            child.removeAllListeners("error");
          }
        };
        const failStart = (message: string): BashToolResult => {
          reg.complete(id, { ok: false, status: "failed to start", text: `failed: ${message}`, wake: false });
          return error(`Failed to start command: ${message}`);
        };
        const id = reg.adopt({
          name: taskHead,
          kind: "bash",
          persistent: true,
          progress: logProgressFor(() => logPath),
          kill: () => {
            // Registry kill (task_kill, /tasks kill). We hold the child handle,
            // so the pid cannot have recycled — signal the group directly, no
            // ps round-trip that a ps-less host would turn into a no-op. A
            // killed task leaves no artifacts, the log included.
            if (meta) {
              try {
                process.kill(-meta.pid, "SIGKILL");
              } catch {
                // already gone
              }
              removePersistedArtifacts(dir, id, { keepLog: false });
            }
          },
          detach: () => {
            handedOff = true;
            stopMonitor();
          },
        });
        logPath = persistentLogPath(dir, id);
        const statusPath = taskStatusPath(dir, id);
        const startedAt = now();
        try {
          child = spawnPersistentTask({
            shell: opts.persistent?.shell ?? getShellConfig().shell,
            ...(opts.persistent?.shellArgs ? { shellArgs: opts.persistent.shellArgs } : {}),
            cwd,
            env: taskEnv(env, command, statusPath),
            logPath,
            ...(opts.persistent?.spawn ? { spawnFn: opts.persistent.spawn } : {}),
          });
        } catch (err) {
          return failStart(err instanceof Error ? err.message : String(err));
        }
        // A failed spawn (missing shell, EMFILE) reports pid undefined and emits
        // "error" on a later tick; an unconsumed "error" event throws uncaught.
        // Consume it before any early return — on the happy path the real
        // handler below runs too ("once" listeners are additive).
        child.once("error", () => {});
        const pid = child.pid;
        if (!pid) return failStart("no pid from spawn");
        meta = {
          version: 1,
          id,
          command,
          pid,
          startedAt,
          ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
          cwd,
        };
        try {
          writeTaskMeta(dir, meta); // after spawn — the pid must exist by now
        } catch (err) {
          // The command runs but a restart would never report it (nothing to
          // scan). Fail closed: kill the group, leave no artifacts.
          const message = err instanceof Error ? err.message : String(err);
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
          removePersistedArtifacts(dir, id, { keepLog: false });
          return failStart(`could not persist task metadata: ${message}`);
        }
        const settle = (status: string, ok: boolean, options: { dropLog?: boolean } = {}) => {
          if (handedOff || settled) return; // fire-once, and never after handoff
          settled = true;
          stopMonitor();
          // Settle invariant: metadata exists ⇔ outcome unreported — deleted on
          // any settle; the log stays for peeking (dropped only when nothing ran).
          removePersistedArtifacts(dir, id, { keepLog: !options.dropLog });
          if (!reg.isRunning(id)) return; // killed via the registry: no wake
          const chunk = readLogChunk(logPath as string, undefined, BASH_TAIL_CAP);
          const display = truncateTail(chunk?.text ?? "", { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
          reg.complete(id, {
            ok,
            status,
            text: formatBashWake({
              command: taskHead,
              id,
              status,
              durationMs: now() - startedAt,
              output: display.content,
              outputNote: display.truncated ? `[… truncated — full output: ${logPath} …]` : undefined,
            }),
          });
        };
        // The wrapper writes its status file before exiting, but a bare `exit N`
        // skips that write (documented degradation) — the event code wins.
        child.once("exit", (code: number | null) =>
          settle(code === null ? "terminated without an exit code" : `exited ${code}`, code === 0),
        );
        child.once("error", (err: Error) => settle(`failed: ${err.message}`, false, { dropLog: true }));
        if (timeoutSecs !== undefined) {
          // We hold the child handle, so the pid cannot have recycled — signal
          // the group directly, no ps verification needed.
          deadlineTimer = setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // already gone — the exit event settles
            }
            settle(`timed out after ${timeoutSecs}s`, false);
          }, timeoutSecs * 1000);
          deadlineTimer.unref();
        }
        // Backstop poll: the exit event is the fast path; this catches a status
        // file that landed (or a leader that died) without the event firing.
        pollTimer = setInterval(() => {
          const status = readStatusSync(dir, id);
          if (status !== undefined && status.trim() !== "") {
            const code = Number.parseInt(status.trim(), 10);
            settle(
              Number.isInteger(code) ? `exited ${code}` : "terminated without an exit code",
              Number.isInteger(code) && code === 0,
            );
            return;
          }
          if (!isProcessAlive(pid)) settle("terminated without an exit code", false);
        }, 2_000);
        pollTimer.unref();
        return {
          content: [
            {
              type: "text",
              text: `Backgrounded (${id}, persistent): ${taskHead}
The command keeps running in its own process group, detached from pi — it survives pi exiting and restarting, and its outcome is reported when the session resumes. In this session the exit status, duration, and output tail are delivered to you automatically as your next message when it exits — even mid-run. If you have nothing else to do, end your turn: the wake re-engages you, so waiting is never your job. Never sleep or poll to wait, and don't arm a check-in just to wait — the result arrives on its own. Peek at it with task ${id}; stop it with task_kill ${id}. Any timeout you passed still applies.`,
            },
          ],
          details: { kind: "bash", mode, id },
          structuredContent: { backgrounded: true, task_id: id, persistent: true },
        };
      };
      if (persistWanted && persistGatesPass) return runPersistent();
      // ---- pipe leg (default) ----
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
      const id = reg.adopt({
        name: taskHead,
        kind: "bash",
        // Check-in wakes read the log from their own offset, so each wake
        // carries the output that appeared since the last look — the wake is
        // content-bearing, never just an elapsed-time nag.
        progress: logProgressFor(() => logPath),
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
        if (!reg.isRunning(id) || data.length === 0) return;
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
        if (!reg.isRunning(id)) return;
        if (promoted) {
          const output = tail.toString("utf8");
          const display = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: WAKE_TEXT_CAP });
          const note =
            display.truncated && logPath
              ? logFailed
                ? "[… truncated — could not save the full output …]"
                : `[… truncated — full output: ${logPath} …]`
              : undefined;
          reg.complete(id, {
            ok,
            status,
            text: formatBashWake({
              command: taskHead,
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
          reg.complete(id, { ok, status, text: status, wake: false });
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
        execPromise = prep.operations.exec(command, cwd, {
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
            text: `Backgrounded (${id}): ${taskHead}
The command keeps running in the background. When it exits, the exit status, duration, and output tail are delivered to you automatically as your next message — even mid-run. If you have nothing else to do, end your turn: the wake re-engages you, so waiting is never your job. Never sleep or poll to wait, and don't arm a check-in just to wait — the result arrives on its own. Peek at it with task ${id}; stop it with task_kill ${id}. Any timeout you passed still applies.`,
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

/** Check-in progress over a log file: each call reads the delta since the
 *  last look (tail-biased, like a first peek), so every check-in wake carries
 *  new output rather than an elapsed-time nag. Shared by the pipe and
 *  persistent background paths. */
function logProgressFor(getPath: () => string | undefined): () => string | undefined {
  let offset = 0;
  return () => {
    // Runs from reminder timers (outside deliver's try/catch) and the log has
    // an asynchronous remover (killPersistedTask); a check-then-stat race must
    // degrade the check-in text, not escape into the event loop.
    try {
      const path = getPath();
      if (!path || !existsSync(path)) return "(no output yet)";
      const size = statSync(path).size;
      if (size <= offset) return "no new output since the last look";
      const chunk = readLogChunk(path, Math.max(offset, size - REMINDER_TAIL_CAP), REMINDER_TAIL_CAP);
      if (!chunk) return "(no output yet)";
      offset = size;
      return `new output since the last look (${formatSize(chunk.bytes)}):\n${chunk.text}`;
    } catch {
      return "(no output yet)";
    }
  };
}

/** One line of the /tasks listing and the kill/peek error hints. */
export function describeRunningTasks(tasks: BgTask[], nowMs: number = Date.now()): string {
  if (tasks.length === 0) return "No background tasks running.";
  return tasks
    .map(
      (t) =>
        `${t.id} (${t.kind}${t.persistent ? ", persistent" : ""}, ${formatDuration(nowMs - t.startedAt)}) ${t.name}`,
    )
    .join("\n");
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
      "Use task <id> to peek at a running task only when its new output would change what you do; otherwise end your turn and let the completion wake re-engage you — it returns only the output since your last check.",
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
              text: `${task.id} (subagent, running, ${elapsed}) ${task.name} — still running; subagents stream no output, so there is nothing to learn by waiting: if you have nothing else to do, end your turn — the wake re-engages you.`,
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
          content: [
            {
              type: "text",
              text: `${task.id} (bash, running, ${elapsed}) ${task.name} — (no output yet) If there's nothing to act on, end your turn — the completion wake re-engages you.`,
            },
          ],
          details: { kind: "task", id: task.id },
        };
      }
      peekOffsets.set(task.id, chunk.next);
      const body = chunk.text ? `\nNew output (${formatSize(chunk.bytes)}):\n${chunk.text}` : "\n(no output yet)";
      return {
        content: [
          {
            type: "text",
            text: `${task.id} (bash, running, ${elapsed}) ${task.name}${body}\nIf the new output doesn't change what you do, end your turn — the completion wake re-engages you.`,
          },
        ],
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
      "Reach for task_kill when a backgrounded command or subagent is no longer wanted — stopped tasks are gone for good, so re-launch if the work is still needed. Never kill a task just because you're idle or unsure how long it will take — the completion wake arrives on its own; kill only when the result is no longer wanted.",
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
 * replaces, omitting in_secs cancels). The fire is dropped when the task has
 * settled — the completion wake already delivered the result, so a reminder
 * could only burn a turn on stale news.
 */
export function createTaskRemindTool(registry: TaskRegistry, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  return {
    name: "task_remind",
    label: "Schedule task check-in",
    description: `Schedule a one-shot check-in on a running background task (t-xxxxx): after in_secs, a wake message reports that it is still running, with elapsed time and your note. If the task settles first, the check-in is dropped — the completion wake already carries the result. Re-arming replaces the pending check-in for that task; omit in_secs to cancel it.
Use this only for long, uncertain runs where a status ping would change what you do — never to wait for a result you'll receive anyway (for that, end your turn; the completion wake is automatic). The fit is work with a go/no-go point: watchers, dev servers, migrations past a deadline you'd abandon.`,
    promptSnippet: "Schedule a check-in on a background task",
    promptGuidelines: [
      "Use task_remind only when a status ping would change what you do on a long, uncertain run — not as a way to wait; for that, end your turn and let the completion wake re-engage you.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task id to check in on, e.g. t-1134z8v" }),
      in_secs: Type.Optional(
        Type.Number({
          description: "Delay in seconds (fractional ok). Omit to cancel the pending check-in for this task.",
        }),
      ),
      note: Type.Optional(
        Type.String({
          description:
            "What you'd act on at this check-in (echoed back in the wake), e.g. 'if not done by then, proceed without it'.",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { id: string; in_secs?: number; note?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { kind: "task_remind"; id: string; in_secs?: number };
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
      if (params.in_secs === undefined) {
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
      // Agent-facing time is seconds (matching bash/ssh_bash timeouts); ms
      // stays the internal unit so timers and caps need no conversion layers.
      const MAX_REMIND_SECS = Math.floor(MAX_TIMEOUT_MS / 1_000);
      if (!Number.isFinite(params.in_secs) || params.in_secs <= 0 || params.in_secs > MAX_REMIND_SECS) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid in_secs: must be a number of seconds (fractional ok) up to ${MAX_REMIND_SECS} (about 24 days).`,
            },
          ],
          details: { kind: "task_remind", id: id ?? "" },
          isError: true,
        };
      }
      const ms = params.in_secs * 1_000;
      const note = params.note?.trim() || undefined;
      const prev = registry.reminderFor(id); // shown below: silent re-arming hides cadence escalation
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
            text: `Check-in set for ${id} in ${formatDuration(ms)}${prev ? ` (replacing the earlier check-in, was in ${formatDuration(prev.ms)})` : ""}${note ? ` — ${note}` : ""}; you'll be woken with its status if it is still running. This is not a way to wait: if you have nothing else to do, end your turn — the completion or check-in wake re-engages you either way.`,
          },
        ],
        details: { kind: "task_remind", id: id ?? "", in_secs: params.in_secs },
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
