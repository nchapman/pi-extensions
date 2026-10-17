/**
 * persistent-bash — the on-disk contract and re-adoption core for persistent
 * background bash tasks: spawn a shell command detached from pi's process
 * tree, child-side log + exit-code files beside the session, and a scan that
 * re-adopts survivors when the session is opened again.
 *
 * Design (the deliberate cuts, full rationale in
 * docs/persistent-background-tasks-design.md):
 * - ownership lives on disk: metadata files exist ⇔ the outcome is not yet
 *   reported; the owning monitor deletes them on any settle and keeps the log.
 *   An in-memory closure must never be able to delete the durable state once
 *   handed off (the registry's detach does the handing)
 * - the command rides in the environment (PI_BG_TASK_COMMAND/…_STATUS) and the
 *   wrapper `eval`s it: no quoting questions, and eval parses at runtime so
 *   the status write survives a syntax-error command. Known degradations,
 *   documented not machined around: `exec cmd` and bare `exit N` skip the
 *   status write; a self-backgrounding command (`cmd &`) leaks grandchildren
 * - never kill an unverified pid: a re-adopted task's identity is checked via
 *   `ps -p PID -o etime=` (±60s against the recorded startedAt) before any
 *   adoption or kill, because pids recycle; a mismatch reads as died-while-away
 * - status before liveness everywhere: `kill(pid, 0)` succeeds on zombies, but
 *   the wrapper always writes the status file before exiting, so the file wins
 *   every race that matters
 * - fork shares the session dir and therefore the tasks (accepted); two
 *   processes resuming one session both adopt and each wake their own agent
 *   once (benign, no locks for a personal tool)
 * - metadata is written after spawn (the pid must exist); the milliseconds-wide
 *   crash window between spawn and write leaves an unowned, untracked process
 *   that every scan ignores — documented, not machined around
 * - no log rotation: the child holds the fd (O_APPEND — leader and
 *   grandchildren share one open-file description); rotation would break that
 */

import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";

/** Env var carrying the command text into the wrapper's `eval`. */
export const TASK_COMMAND_VAR = "PI_BG_TASK_COMMAND";
/** Env var carrying the status-file path into the wrapper's exit-code write. */
export const TASK_STATUS_VAR = "PI_BG_TASK_STATUS";

/**
 * The fixed wrapper script. The command never appears in the script text —
 * see the header. `code=$?` must precede the write: `echo $? > file` would
 * capture echo's own status.
 */
export const PERSISTENT_WRAPPER_SCRIPT = `eval "$${TASK_COMMAND_VAR}"
code=$?
printf '%s' "$code" > "$${TASK_STATUS_VAR}"
exit "$code"`;

/** Identity tolerance: ps etime has second resolution and clocks wobble. */
export const IDENTITY_TOLERANCE_MS = 60_000;

/** How long a finalize path re-reads a missing/empty status file before concluding. */
export const STATUS_RETRY_BUDGET_MS = 2_000;

const tasksDir = (sessionDir: string): string => join(sessionDir, "tasks");

/** Durable task metadata — the file a later session scans for. */
export function taskMetaPath(sessionDir: string, id: string): string {
  return join(tasksDir(sessionDir), `${id}.task.json`);
}

/** The wrapper's exit-code write target. */
export function taskStatusPath(sessionDir: string, id: string): string {
  return join(tasksDir(sessionDir), `${id}.status`);
}

/**
 * The child-side output log. Must stay identical to superbash's
 * outputLogPath (the task tool peeks persistent tasks through the same file);
 * tests pin the two together rather than share a module and a cycle.
 */
export function persistentLogPath(sessionDir: string, id: string): string {
  return join(tasksDir(sessionDir), `${id}.log`);
}

/**
 * Parse PI_BG_BASH_PERSIST: persistence is opt-in, so only an explicit truthy
 * value turns the session default on; anything else (missing, invalid) is off.
 */
const PERSIST_ON = new Set(["1", "true", "yes", "on"]);

export function parseBashPersist(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_BG_BASH_PERSIST?.trim().toLowerCase();
  return raw !== undefined && PERSIST_ON.has(raw);
}

/** The environment a persistent wrapper runs with: base + the two task vars. */
export function taskEnv(base: NodeJS.ProcessEnv, command: string, statusPath: string): NodeJS.ProcessEnv {
  return { ...base, [TASK_COMMAND_VAR]: command, [TASK_STATUS_VAR]: statusPath };
}

/** Durable metadata for one persistent task, written after a successful spawn. */
export interface PersistentTaskMeta {
  version: 1;
  id: string;
  command: string;
  /** Process-group leader pid (spawned detached, so pgid === pid). */
  pid: number;
  startedAt: number;
  timeoutSecs?: number;
  cwd: string;
}

function isTaskMeta(v: unknown): v is PersistentTaskMeta {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m.version === 1 &&
    typeof m.id === "string" &&
    m.id !== "" &&
    typeof m.command === "string" &&
    typeof m.pid === "number" &&
    Number.isInteger(m.pid) &&
    m.pid > 0 &&
    typeof m.startedAt === "number" &&
    Number.isFinite(m.startedAt) &&
    typeof m.cwd === "string" &&
    (m.timeoutSecs === undefined ||
      (typeof m.timeoutSecs === "number" && Number.isFinite(m.timeoutSecs) && m.timeoutSecs > 0))
  );
}

/** Persist task metadata (after spawn — the pid must exist by then). */
export function writeTaskMeta(sessionDir: string, meta: PersistentTaskMeta): void {
  mkdirSync(tasksDir(sessionDir), { recursive: true });
  writeFileSync(taskMetaPath(sessionDir, meta.id), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/** Read and validate one task's metadata; undefined when missing or corrupt. */
export function readTaskMeta(sessionDir: string, id: string): PersistentTaskMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(taskMetaPath(sessionDir, id), "utf8"));
    return isTaskMeta(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every task id with metadata on disk; fail-open to none (no tasks dir yet, unreadable). */
export function listPersistedTaskIds(sessionDir: string): string[] {
  try {
    return readdirSync(tasksDir(sessionDir))
      .filter((f) => f.endsWith(".task.json"))
      .map((f) => f.slice(0, -".task.json".length));
  } catch {
    return [];
  }
}

/**
 * Remove a task's durable artifacts. Settle paths keep the log (the task tool
 * points at it, matching pipe mode); kill removes everything.
 */
export function removePersistedArtifacts(sessionDir: string, id: string, opts: { keepLog?: boolean } = {}): void {
  const paths = [taskMetaPath(sessionDir, id), taskStatusPath(sessionDir, id)];
  if (opts.keepLog === false) paths.push(persistentLogPath(sessionDir, id));
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // already gone — removal is idempotent by design
    }
  }
}

/**
 * Parse `ps -o etime=` output: `mm:ss`, `hh:mm:ss`, or `dd-hh:mm:ss` (LC_ALL=C
 * keeps ps off locale formats). Seconds, or undefined for anything unrecognized.
 */
export function parseEtime(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  let days = 0;
  let rest = t;
  const dash = t.indexOf("-");
  if (dash >= 0) {
    const dayText = t.slice(0, dash);
    // Number("") is 0, so a leading dash would otherwise slip through as day 0.
    if (!/^\d+$/.test(dayText)) return undefined;
    days = Number(dayText);
    rest = t.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return undefined;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return ((days * 24 + h) * 60 + m) * 60 + s;
}

/** Whether a ps-reported elapsed time plausibly belongs to a task started at startedAt. */
export function matchesStartTime(
  elapsedSecs: number,
  startedAtMs: number,
  nowMs: number,
  toleranceMs: number = IDENTITY_TOLERANCE_MS,
): boolean {
  return Math.abs(elapsedSecs * 1000 - (nowMs - startedAtMs)) <= toleranceMs;
}

/**
 * The process's elapsed time via ps, bounded (5s timeout, 4KB output) and
 * never rejecting: a dead pid, a missing ps, or a timeout are all
 * "unverifiable" — undefined.
 */
export async function psEtime(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "etime="],
      { timeout: 5_000, maxBuffer: 4_096, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
      (err, stdout) => resolve(err ? undefined : parseEtime(stdout)),
    );
  });
}

/** Liveness by signal 0: ESRCH means gone; EPERM means alive but not ours. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Verify a re-adopted task's identity: ps elapsed time must match its recorded start. */
export async function verifyTaskIdentity(
  meta: PersistentTaskMeta,
  opts: { now?: () => number; runPs?: (pid: number) => Promise<number | undefined> } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const runPs = opts.runPs ?? psEtime;
  const elapsed = await runPs(meta.pid);
  if (elapsed === undefined) return false;
  return matchesStartTime(elapsed, meta.startedAt, now());
}

/** Facts a scan gathers; the decision machine itself stays pure over these. */
export interface ScanFacts {
  /** Status-file content; undefined = missing, "" = exists but empty (truncate-write window). */
  status?: string;
  alive: boolean;
  /** Identity verdict, meaningful only when alive; undefined counts as unverified. */
  identityVerified?: boolean;
}

/** What the session-start wiring must do for one scanned task. */
export type ScanDecision =
  | { action: "complete"; exitCode: number | null }
  | { action: "finalize-dead" }
  | { action: "finalize-recycled" }
  | { action: "kill-expired" }
  | { action: "adopt" }
  | { action: "discard" };

const usableStatus = (s: string | undefined): boolean => s !== undefined && s.trim() !== "";

/**
 * The scan's decision machine, in the order that wins races: a usable status
 * file settles everything (the wrapper writes it before exiting — a zombie
 * leader still has one); a dead leader without one died unknown; a live pid
 * must be identity-verified before adoption (recycled pids read as gone, never
 * killed); only a verified survivor can hit its deadline.
 */
export function decideScan(meta: PersistentTaskMeta, facts: ScanFacts, nowMs: number): ScanDecision {
  if (usableStatus(facts.status)) {
    const code = Number.parseInt((facts.status as string).trim(), 10);
    return { action: "complete", exitCode: Number.isInteger(code) ? code : null };
  }
  if (!facts.alive) return { action: "finalize-dead" };
  if (!facts.identityVerified) return { action: "finalize-recycled" };
  if (meta.timeoutSecs !== undefined && nowMs >= meta.startedAt + meta.timeoutSecs * 1000) {
    return { action: "kill-expired" };
  }
  return { action: "adopt" };
}

/** The status-file content, or undefined when missing/empty. */
export function readStatusSync(sessionDir: string, id: string): string | undefined {
  try {
    return readFileSync(taskStatusPath(sessionDir, id), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Re-read a status file within a small budget before concluding it will never
 * arrive — the wrapper's truncate-then-write window is microseconds, but a
 * concluded "exit code unknown" is irreversible, so the read side over-waits.
 */
export async function readStatusWithRetry(
  sessionDir: string,
  id: string,
  opts: {
    readStatus?: (sessionDir: string, id: string) => string | undefined;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    budgetMs?: number;
  } = {},
): Promise<string | undefined> {
  const read = opts.readStatus ?? readStatusSync;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? STATUS_RETRY_BUDGET_MS);
  for (;;) {
    const s = read(sessionDir, id);
    if (usableStatus(s)) return s;
    if (now() >= deadline) return undefined;
    await sleep(100);
  }
}

/** One scanned task: its metadata (when readable) and what to do about it. */
export type ScanOutcome =
  | { id: string; meta: PersistentTaskMeta; decision: ScanDecision }
  | { id: string; meta: undefined; decision: { action: "discard" } };

/** Injectable boundaries for scanSessionTasks; the fs/process defaults are production. */
export interface ScanDeps {
  listIds?: (sessionDir: string) => string[];
  readMeta?: (sessionDir: string, id: string) => PersistentTaskMeta | undefined;
  readStatus?: (sessionDir: string, id: string) => string | undefined;
  isAlive?: (pid: number) => boolean;
  verifyIdentity?: (meta: PersistentTaskMeta) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Scan a session's task metadata and decide, per task, what the new runtime
 * must do. Status-first: a finished task needs no liveness probe and no ps.
 * Never throws — a scan failure must not block session start (fail-open).
 */
export async function scanSessionTasks(sessionDir: string, deps: ScanDeps = {}): Promise<ScanOutcome[]> {
  const listIds = deps.listIds ?? listPersistedTaskIds;
  const readMeta = deps.readMeta ?? readTaskMeta;
  const readStatus = deps.readStatus ?? readStatusSync;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const verify = deps.verifyIdentity ?? ((meta) => verifyTaskIdentity(meta, { now }));
  const outcomes: ScanOutcome[] = [];
  for (const id of listIds(sessionDir)) {
    try {
      const meta = readMeta(sessionDir, id);
      if (!meta) {
        outcomes.push({ id, meta: undefined, decision: { action: "discard" } });
        continue;
      }
      const status = readStatus(sessionDir, id);
      if (usableStatus(status)) {
        outcomes.push({ id, meta, decision: decideScan(meta, { status, alive: false }, now()) });
        continue;
      }
      const alive = isAlive(meta.pid);
      if (!alive) {
        // Dead without a usable status: over-wait the truncate-write window
        // before reporting an outcome that cannot be corrected later.
        const retried = await readStatusWithRetry(sessionDir, id, {
          readStatus,
          sleep: deps.sleep,
          now,
          budgetMs: STATUS_RETRY_BUDGET_MS,
        });
        outcomes.push({
          id,
          meta,
          decision:
            retried !== undefined
              ? decideScan(meta, { status: retried, alive: false }, now())
              : decideScan(meta, { status, alive }, now()),
        });
        continue;
      }
      const identityVerified = await verify(meta);
      outcomes.push({ id, meta, decision: decideScan(meta, { status, alive, identityVerified }, now()) });
    } catch {
      // One unreadable task must not sink the rest of the scan.
      outcomes.push({ id, meta: undefined, decision: { action: "discard" } });
    }
  }
  return outcomes;
}

/** Kill a persisted task by process group, after verifying the pid still is ours. */
export async function killPersistedTask(
  meta: PersistentTaskMeta,
  sessionDir: string,
  opts: {
    verifyIdentity?: (meta: PersistentTaskMeta) => Promise<boolean>;
    killGroup?: (pid: number) => boolean;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const verify = opts.verifyIdentity ?? ((meta) => verifyTaskIdentity(meta, { now: opts.now }));
  const killGroup =
    opts.killGroup ??
    ((pid: number) => {
      try {
        process.kill(-pid, "SIGKILL");
        return true;
      } catch {
        return false; // already gone (ESRCH) or not ours to signal (EPERM)
      }
    });
  if (!(await verify(meta))) {
    // Unverified: never signal — the pid may belong to someone else now.
    // Clean the artifacts so scans stop considering it.
    removePersistedArtifacts(sessionDir, meta.id, { keepLog: false });
    return false;
  }
  killGroup(meta.pid);
  removePersistedArtifacts(sessionDir, meta.id, { keepLog: false });
  return true;
}

/** Options for spawnPersistentTask; the shell comes resolved (pi's getShellConfig). */
export interface PersistentSpawnOptions {
  shell: string;
  /** Invocation args ahead of the script ("-c" for POSIX shells). */
  shellArgs?: string[];
  cwd: string;
  /** Already carries the two task vars (taskEnv). */
  env: NodeJS.ProcessEnv;
  logPath: string;
  /** Injectable for tests; production is child_process.spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Spawn one persistent wrapper: detached (setsid — own session and group, no
 * controlling terminal, pgid === pid), stdio straight to the append-mode log
 * fd (no pipes, so SIGPIPE is structurally impossible), unref'd (the task must
 * never keep pi's loop alive). The parent's log-fd copy is closed after spawn
 * — the child holds the only reference through its dup. On spawn failure the
 * empty log is removed; the id→log orphan risk is the documented crash window
 * (metadata is written after spawn, by the caller).
 */
export function spawnPersistentTask(opts: PersistentSpawnOptions): ChildProcess {
  const doSpawn = opts.spawnFn ?? spawn;
  mkdirSync(dirname(opts.logPath), { recursive: true });
  // "a" = O_APPEND: leader and grandchildren share one open-file description,
  // and interleaved writes must extend the file, not overwrite each other.
  const logFd = openSync(opts.logPath, "a");
  let child: ChildProcess;
  try {
    child = doSpawn(opts.shell, [...(opts.shellArgs ?? ["-c"]), PERSISTENT_WRAPPER_SCRIPT], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: opts.env,
    });
  } catch (err) {
    closeSync(logFd);
    try {
      unlinkSync(opts.logPath);
    } catch {
      // best effort — an empty orphan log is harmless
    }
    throw err;
  }
  closeSync(logFd);
  child.unref();
  return child;
}
