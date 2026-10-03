/**
 * Goal extension — a single session-scoped objective with a verifiable
 * completion gate.
 *
 * Design (a deliberate cut of pi-goal, keeping the parent context small):
 * - one active goal per session, thread-owned (not a global per-directory
 *   goal). State snapshots ride in the goal tool result `details` and are
 *   reconstructed on session_start / session_tree — the branch-safe pattern
 *   from todo.ts, no filesystem, nothing desyncs on rewind or resume
 * - one tool, `goal`, with an `action` discriminator (set | complete | blocked)
 *   instead of three separate tools; it registers inactive and is revealed on
 *   the first goal (after-first-goal visibility) so a fresh session adds zero
 *   tool surface
 * - completion is a structural gate, not a model self-assessment: the model
 *   must supply a `summary` plus `evidence` indexed to the goal's criteria
 *   (evidence[i] proves criteria[i]). A free-text "I'm done" is rejected when
 *   it names a failure, a criterion lacks proof, or the id is stale. If the
 *   goal carries a `verify` command, completion also requires it to exit 0 —
 *   the extension runs it itself (bounded), so the model can't fake success and a
 *   failed run is rejected with its output to fix the real cause. A semantic
 *   second opinion (a Jev-style classifier) is a later pass behind the
 *   injectable GoalJudge seam; v1 ships no judge (fail-open floor)
 * - an agent_before_settle continuation loop drives the goal turn by turn: at
 *   each settle, if the goal is active and carries a `verify` command, the
 *   extension runs it (bounded), reads the measured state, and queues a
 *   follow-up (display:true with a compact registered message renderer, so the
 *   user sees a one-line "goal check N/M · verify failed — continuing" heartbeat
 *   instead of an invisible hand-off) — "close these measured gaps" when the
 *   check fails, "the check passed, summarize and call complete" when it
 *   passes. The check is graded, not boolean: it prints the measured state
 *   (coverage %, test summary) and exits 0 only when the objective is met, so
 *   the agent measures, narrates the gap, and works until it closes. While the
 *   verify runs, an animated chat-area spinner widget shows the check in flight
 *   (pi clears its own working spinner at agent_end, so the settle boundary
 *   would otherwise render as a dead pause), and an expensive verify can be
 *   throttled via PI_GOAL_CHECK_EVERY (every Nth continuation; the in-between
 *   turns reuse the last measured state, marked stale in the prompt — keep
 *   checkEvery ≤ maxContinuations − 1 so each judge window still holds ≥ 2
 *   fresh outputs). A footer status (elapsed time) keeps the goal in view the
 *   whole time. A goal without a verify is user-driven (no auto-loop) — the
 *   check is what makes progress measurable. Two
 *   model-untouchable circuit breakers keep a stuck run bounded: a per-session
 *   cap (PI_GOAL_MAX_CONTINUATIONS) on auto-continuations, and a per-run turn
 *   bound (PI_GOAL_MAX_TURNS_PER_RUN) that steers a long turn to settle so the
 *   cap can re-engage. At the cap, an injectable ProgressJudge seam decides
 *   between "still progressing → reset the budget and continue" and "plateaued
 *   → stop": the default judge is deterministic (the verify output changed
 *   across the budget window ⇒ progressing), a semantic judge can slot in
 *   later, and a no-opinion or throwing judge fails closed to the stop. The
 *   seam is awaitable so an async (LLM) judge needs no adapter; judge resets are
 *   themselves capped (PI_GOAL_MAX_PROGRESS_RESETS) so the breaker stays a
 *   breaker — the worst case any strategy achieves is
 *   maxContinuations × (maxProgressResets + 1). The
 *   model's set/complete/blocked actions never reset
 *   either (a stuck model can't farm fresh turns by re-setting or faking a
 *   completion); both re-arm only on a resumed session or when the user starts a
 *   goal via /goal, and /goal stop halts the loop session-scoped
 * - a before_agent_start reminder re-injects the objective + criteria when a
 *   compaction hid it (summaries never carry the goal); a compaction mid-turn
 *   additionally re-injects immediately by steering the in-progress run (no new
 *   turn), since before_agent_start won't re-fire until the next user prompt
 * - /goal is a view + kickoff: it shows the goal, starts one by routing the
 *   objective through the model (the goal tool creates and persists it), or stops
 *   the loop with /goal stop. Goal state is owned by the model and reconstructed
 *   from the branch, so nothing user-side desyncs it; the stop is the only
 *   user-side mutation and it is session-scoped loop control, not a persisted change
 */

import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOL_NAME = "goal";
export const MAX_OBJECTIVE_CHARS = 4000;
export const MAX_CRITERIA = 20;

/** customType of this extension's one-shot goal reminder message. */
export const GOAL_REMINDER_TYPE = "goal.reminder";

/** Distinct from GOAL_REMINDER_TYPE: the paused steer says the OPPOSITE of a
 * reminder, and scanGoalBranch treats any post-compaction goal.reminder as
 * proof the goal is still in context — a shared type would mask compaction
 * and let a reload re-adopt a paused goal as active with "do NOT work"
 * instructions still in context. */
export const GOAL_PAUSED_STEER_TYPE = "goal.paused";

/** customType of the hidden turn-end check prompt (the graded "close the gaps" / "summarize + complete" message). */
export const GOAL_CHECK_TYPE = "goal.check";

/** Structured summary of one turn-end check, carried in the goal.check custom
 * message `details` (not sent to the model) so the transcript renderer can show
 * a compact row without parsing the prompt. */
export interface GoalCheckDetails {
  continuation: number;
  max: number;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  staleContinuations: number;
  output: string;
}

/** Per-session cap on auto-continuations for a still-active goal (PI_GOAL_MAX_CONTINUATIONS). */
export const GOAL_MAX_CONTINUATIONS_DEFAULT = 25;
const GOAL_MAX_CONTINUATIONS_ENV = "PI_GOAL_MAX_CONTINUATIONS";

/**
 * Parse PI_GOAL_MAX_CONTINUATIONS: how many times the continuation loop may
 * re-engage a still-active goal before it stops and reports. Invalid values
 * (non-numeric, < 1, absurdly large) fall back to the default — fail-open, no throw.
 */
export function parseMaxContinuations(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return GOAL_MAX_CONTINUATIONS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return GOAL_MAX_CONTINUATIONS_DEFAULT;
  return n;
}

/**
 * Per-run turn bound (PI_GOAL_MAX_TURNS_PER_RUN): after this many turns in a
 * single run, steer the model to settle. A stuck model can loop tool calls
 * inside one run without ever settling, so the settle-cap alone can't catch it —
 * this converts a runaway run into bounded runs the cap can then re-engage.
 */
export const GOAL_MAX_TURNS_PER_RUN_DEFAULT = 50;
const GOAL_MAX_TURNS_PER_RUN_ENV = "PI_GOAL_MAX_TURNS_PER_RUN";

/**
 * Parse PI_GOAL_MAX_TURNS_PER_RUN. Invalid values (non-numeric, < 1, absurdly
 * large) fall back to the default — fail-open, no throw.
 */
export function parseMaxTurnsPerRun(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return GOAL_MAX_TURNS_PER_RUN_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return GOAL_MAX_TURNS_PER_RUN_DEFAULT;
  return n;
}

/**
 * Cap on judge-approved budget resets at the continuation cap
 * (PI_GOAL_MAX_PROGRESS_RESETS). Each reset re-arms the continuation budget;
 * without this the progress judge would defeat the circuit breaker entirely.
 */
export const GOAL_MAX_PROGRESS_RESETS_DEFAULT = 3;
const GOAL_MAX_PROGRESS_RESETS_ENV = "PI_GOAL_MAX_PROGRESS_RESETS";

/** Parse PI_GOAL_MAX_PROGRESS_RESETS. Invalid values fall back to the default — fail-open, no throw. */
export function parseMaxProgressResets(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return GOAL_MAX_PROGRESS_RESETS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) return GOAL_MAX_PROGRESS_RESETS_DEFAULT;
  return n;
}

/**
 * Run the verify check every Nth continuation (PI_GOAL_CHECK_EVERY), reusing the
 * previous measured state in between. Default 1 (every turn — the graded loop
 * as designed). An expensive verify (a full benchmark suite can take minutes)
 * sets this higher so most turns re-engage instantly on the last measurement.
 */
export const GOAL_CHECK_EVERY_DEFAULT = 1;
const GOAL_CHECK_EVERY_ENV = "PI_GOAL_CHECK_EVERY";

/** Parse PI_GOAL_CHECK_EVERY. Invalid values fall back to the default — fail-open, no throw. */
export function parseCheckEvery(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return GOAL_CHECK_EVERY_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000) return GOAL_CHECK_EVERY_DEFAULT;
  return n;
}

/**
 * Verification timeout + output cap for a goal's `verify` command. The command
 * runs in a bounded shell (hard timeout, capped output) so a hanging or verbose
 * verify can't stall the loop or blow up context.
 */
export const VERIFY_TIMEOUT_MS_DEFAULT = 120_000;
const VERIFY_TIMEOUT_ENV = "PI_GOAL_VERIFY_TIMEOUT_MS";
const MAX_VERIFY_OUTPUT = 4096;

/** Parse PI_GOAL_VERIFY_TIMEOUT_MS (ms). Invalid values fall back to the default. */
export function parseVerifyTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return VERIFY_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) return VERIFY_TIMEOUT_MS_DEFAULT;
  return n;
}

/**
 * Result of running a goal's verify command. `ok` is true only on a clean exit 0
 * with no timeout/spawn error; `output` is a capped tail of combined output.
 */
export interface VerifyResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  output: string;
}

/** The verify boundary: execute a command, return its result. Injected in tests. */
export type VerifyRunner = (command: string, opts: { timeoutMs?: number; cwd?: string }) => Promise<VerifyResult>;

function capVerifyOutput(s: string, n = MAX_VERIFY_OUTPUT): string {
  return s.length > n ? `…(truncated) ${s.slice(-n)}` : s;
}

/**
 * Run a verify command in a bounded shell: hard timeout + capped output. This is
 * the boundary the model cannot fake — the extension executes the command and
 * reads the exit code, so completion reflects reality, not a claim.
 */
export function runVerify(command: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS_DEFAULT;
  const cwd = opts.cwd ?? process.cwd();
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: VerifyResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const onData = (d: Buffer) => {
      if (out.length < MAX_VERIFY_OUTPUT * 4) out += d.toString();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd });
    } catch (e) {
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnError: e instanceof Error ? e.message : String(e),
        output: "",
      });
      return;
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, exitCode: null, timedOut: true, output: capVerifyOutput(out) });
    }, timeoutMs);
    child.on("error", (e) => {
      finish({ ok: false, exitCode: null, timedOut: false, spawnError: e.message, output: capVerifyOutput(out) });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code, timedOut: false, output: capVerifyOutput(out) });
    });
  });
}

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface Goal {
  /** Monotonic id, rotated on every set so a stale completion can't hit a newer goal. */
  id: number;
  objective: string;
  /** Ordered success criteria; empty means the objective is the single criterion. */
  criteria: string[];
  status: GoalStatus;
  blockedReason?: string;
  /**
   * Optional measurable check: a shell command that prints the measured state
   * (coverage %, test summary) and exits 0 only when the objective is met. The
   * extension runs it at the end of every turn while the goal is active — its
   * output is the graded signal the agent reads to see what's left, and it must
   * genuinely exit 0 for the goal to count as complete.
   */
  verify?: string;
  /** Wall-clock ms at which the goal was set; the footer shows elapsed time from here. */
  startedAt: number;
}

/** Snapshot carried by every goal tool result (see lastGoalSnapshot). */
export interface GoalDetails {
  goal: Goal | null;
  error?: string;
}

/** A typed second opinion on completion. `undefined` = no opinion (fail-open). */
export interface GoalVerdict {
  complete: boolean;
  reason?: string;
}

/**
 * Optional semantic judge consulted after the structural gate passes. v1 ships
 * none (the structural gate is the floor); a Jev-style classifier slots in here
 * without touching the tool, state, or gate.
 */
export interface GoalJudge {
  evaluate(goal: Goal, evidence: string[], summary: string): GoalVerdict | undefined;
}

/** A typed second opinion on continuing past the continuation cap. */
export interface ProgressVerdict {
  continueRun: boolean;
  reason?: string;
}

/**
 * Decides, at the continuation cap, whether the run is still making progress
 * (reset the budget and continue) or has plateaued (stop). Receives the verify
 * outputs observed during the current budget window, oldest first. May return
 * a Promise (an LLM judge is async; the seam awaits it). `undefined`
 * = no opinion, which fails closed to the stop — the circuit breaker is the
 * floor, so an absent or ambiguous judge may not extend the run.
 */
export interface ProgressJudge {
  assess(goal: Goal, verifyOutputs: string[]): ProgressVerdict | undefined | Promise<ProgressVerdict | undefined>;
}

/** Max verify outputs retained per budget window (~4KB each — bounded retention). */
export const MAX_BUDGET_OUTPUTS = 32;

/**
 * Append a verify output to the budget window, bounding retention: keep the
 * oldest (the window's baseline), drop second-oldest beyond the cap. The
 * default judge only needs first vs last; a semantic judge gets the baseline
 * plus the most recent tail — enough signal without unbounded memory.
 */
export function recordBudgetOutput(outputs: string[], output: string): string[] {
  outputs.push(output);
  if (outputs.length > MAX_BUDGET_OUTPUTS) outputs.splice(1, 1);
  return outputs;
}

/**
 * The default deterministic progress judge: the measured state changed across
 * the budget window ⇒ progressing. A verify that prints live numbers (coverage,
 * benchmarks) moves whenever real work lands; a stuck run reproduces the same
 * output turn after turn. This is a proxy, not a regression test — it can't
 * tell improvement from drift — and any verify whose output carries timestamps
 * or timings reads as "changed" every turn, so its resets are effectively
 * always granted up to the cap; that is why the resets are themselves capped.
 * The window is scoped to the current goal (cleared on set) so a reset always
 * certifies measured movement of that goal, never a re-set trick.
 */
export function defaultProgressJudge(_goal: Goal, verifyOutputs: string[]): ProgressVerdict {
  const outputs = verifyOutputs.map((o) => o.trim()).filter((o) => o !== "");
  if (outputs.length < 2) {
    return { continueRun: false, reason: "not enough measured states to show progress" };
  }
  const changed = outputs[0] !== outputs[outputs.length - 1];
  return changed
    ? { continueRun: true, reason: "measured state changed across the budget window" }
    : { continueRun: false, reason: "measured state is unchanged since the budget started (plateau)" };
}

const GOAL_STATUSES = ["active", "paused", "blocked", "complete"] as const;

/**
 * One flat object schema, not a discriminated union. A top-level Type.Union
 * serializes to a rootless anyOf with no `properties` for OpenAI-compatible
 * providers to key arguments off — GLM via zai answered such a schema with
 * empty arguments, and the tool silently fell through to "No goal." Every
 * action-specific field is optional here and validated per-branch in execute.
 */
const GoalParams = Type.Object({
  action: Type.Union([Type.Literal("set"), Type.Literal("complete"), Type.Literal("blocked")], {
    description:
      'Which operation: "set" starts a goal, "complete" finishes it with evidence, "blocked" reports an impasse.',
  }),
  // action: "set"
  objective: Type.Optional(
    Type.String({ description: "The goal, in one or a few sentences. Keep it under 4000 chars." }),
  ),
  criteria: Type.Optional(
    Type.Array(
      Type.String({
        description: "A checkable success criterion; evidence is matched to these by index on completion.",
      }),
      { description: "Optional list of success criteria. Omit for a single implicit criterion (the objective)." },
    ),
  ),
  verify: Type.Optional(
    Type.String({
      description:
        "Optional measurable check: a shell command that prints the measured state (e.g. `npm test`, a coverage report) and exits 0 only when the objective is met. The extension runs it at the end of every turn while the goal is active — it reads the output to see what is still missing and re-engages you to close the gaps, and it must genuinely exit 0 for the goal to count as complete. A no-op that always passes is rejected.",
    }),
  ),
  // action: "complete"
  goalId: Type.Optional(
    Type.Number({ description: "The id of the goal being completed or blocked (from the last set result)." }),
  ),
  summary: Type.Optional(Type.String({ description: "A concise statement of what was done." })),
  evidence: Type.Optional(
    Type.Array(
      Type.String({
        description: "Concrete proof for the criterion at the same index (test name, file, command output).",
      }),
      { description: "evidence[i] is the proof for criteria[i]; one entry per criterion." },
    ),
  ),
  // action: "blocked"
  reason: Type.Optional(Type.String({ description: "Why the goal cannot proceed." })),
});

/** The single checkable criterion when the model set none: the objective itself. */
export function effectiveCriteria(goal: Goal): string[] {
  return goal.criteria.length > 0 ? goal.criteria : [goal.objective];
}

/** Shape guard shared by streamed arguments and replayed snapshots. */
function isGoal(g: unknown): g is Goal {
  const goal = g as Partial<Goal> | null;
  if (!goal || typeof goal !== "object") return false;
  return (
    typeof goal.id === "number" &&
    Number.isInteger(goal.id) &&
    typeof goal.objective === "string" &&
    goal.objective.length > 0 &&
    Array.isArray(goal.criteria) &&
    goal.criteria.every((c) => typeof c === "string") &&
    typeof goal.status === "string" &&
    GOAL_STATUSES.includes(goal.status as GoalStatus) &&
    (goal.verify === undefined || typeof goal.verify === "string") &&
    typeof goal.startedAt === "number" &&
    Number.isFinite(goal.startedAt)
  );
}

export function validateObjective(raw: unknown): { objective: string; error?: string } {
  if (typeof raw !== "string") return { objective: "", error: "objective must be a string" };
  const objective = raw.trim();
  if (objective === "") return { objective: "", error: "objective must be non-empty" };
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return {
      objective: "",
      error: `objective exceeds ${MAX_OBJECTIVE_CHARS} chars; put long instructions in a file and reference its path`,
    };
  }
  return { objective };
}

export function validateCriteria(raw: unknown): { criteria: string[]; error?: string } {
  if (raw === undefined) return { criteria: [] };
  if (!Array.isArray(raw)) return { criteria: [], error: "criteria must be an array of strings" };
  if (raw.length > MAX_CRITERIA) return { criteria: [], error: `at most ${MAX_CRITERIA} criteria` };
  const criteria: string[] = [];
  for (const [i, c] of raw.entries()) {
    if (typeof c !== "string" || c.trim() === "") {
      return { criteria: [], error: `criteria[${i}] must be a non-empty string` };
    }
    criteria.push(c.trim());
  }
  return { criteria };
}

const MAX_VERIFY_CHARS = 500;
/** Commands that always exit 0 regardless of code state — a model can't prove anything with them. */
const NOOP_VERIFY = new Set(["true", ":", "exit 0"]);

/** Validate the optional `verify` command. Empty, oversized, or always-pass commands are rejected. */
export function validateVerify(raw: unknown): { verify?: string; error?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: "verify must be a string command" };
  const v = raw.trim();
  if (v === "") return { error: "verify must be a non-empty command" };
  if (v.length > MAX_VERIFY_CHARS) return { error: `verify exceeds ${MAX_VERIFY_CHARS} chars` };
  if (NOOP_VERIFY.has(v))
    return { error: `verify "${v}" is a no-op that always passes; give a real check (e.g. \`npm test\`)` };
  return { verify: v };
}

/**
 * Plainly-contradictory completion summaries. A conservative floor: it flags
 * explicit "not done" language but avoids tripping on legitimate summaries that
 * merely mention a now-fixed failure ("the failing test now passes").
 */
const CONTRADICTION_PATTERNS: RegExp[] = [
  /not\s+(?:complete|done|finished|working|passing|resolved|fixed)/i,
  /isn'?t\s+(?:complete|done|finished|working)/i,
  /still\s+(?:fail|failing|broken|incomplete|pending|erroring)/i,
  /doe?s\s+not\s+work/i,
  /d(o|oes)n'?t\s+work/i,
  /\bincomplete\b/i,
  /not\s+(?:yet\s+)?implemented/i,
];

export function isContradictorySummary(summary: string): boolean {
  return CONTRADICTION_PATTERNS.some((p) => p.test(summary));
}

/** evidence[i] must be a non-empty string for each criterion i. */
export function checkEvidenceCoverage(criteria: string[], evidence: unknown): { ok: boolean; missing: number[] } {
  if (!Array.isArray(evidence)) return { ok: false, missing: criteria.map((_, i) => i) };
  const missing: number[] = [];
  for (let i = 0; i < criteria.length; i++) {
    const e = evidence[i];
    if (typeof e !== "string" || e.trim() === "") missing.push(i);
  }
  return { ok: missing.length === 0, missing };
}

export interface CompletionCheck {
  ok: boolean;
  reason?: string;
}

/** The deterministic, free completion gate (no model). */
export function checkCompletion(
  goal: Goal,
  params: { goalId: unknown; summary: unknown; evidence: unknown },
): CompletionCheck {
  if (goal.status !== "active") return { ok: false, reason: `goal is ${goal.status}, not active` };
  if (!Number.isInteger(params.goalId)) return { ok: false, reason: "goalId must be an integer" };
  if (params.goalId !== goal.id) {
    return { ok: false, reason: `stale goal id ${String(params.goalId)}; the current goal is #${goal.id}` };
  }
  const summary = typeof params.summary === "string" ? params.summary.trim() : "";
  if (summary === "") return { ok: false, reason: "summary must be non-empty" };
  if (isContradictorySummary(summary)) {
    return {
      ok: false,
      reason:
        "summary contradicts completion (mentions a failure or 'not done'); resolve it or reword with the correct outcome",
    };
  }
  const criteria = effectiveCriteria(goal);
  const coverage = checkEvidenceCoverage(criteria, params.evidence);
  if (!coverage.ok) {
    const names = coverage.missing.map((i) => `"${criteria[i]}"`).join(", ");
    return { ok: false, reason: `missing or empty evidence for: ${names}` };
  }
  return { ok: true };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Human-friendly elapsed time for the footer. Seconds under a minute, minutes
 * under an hour ("4m 12s"), hours beyond ("1h 5m"). Negative / non-finite input
 * clamps to 0s — the footer must never show a negative or NaN timer.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/** Footer status line: `goal · <elapsed>` — presence + time only, no emoji (the
 * footer is plain text throughout). The objective lives in the /goal view and
 * the turn-end prompt; the footer is an ambient indicator and stays short so
 * other footer segments keep their room. */
export function renderGoalFooter(goal: Goal, now: number): string {
  return `goal · ${formatElapsed(now - goal.startedAt)}`;
}

/** Widget key for the animated goal-check spinner shown above the editor. */
const GOAL_CHECK_WIDGET_KEY = "goal-check";
const CHECK_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const CHECK_SPINNER_INTERVAL_MS = 120;

/**
 * Animated "running goal check" row shown above the editor while the
 * settle-boundary verify runs. pi clears its own working spinner on agent_end
 * (before settle), so a slow verify would otherwise render as a dead pause —
 * this widget keeps an explicit, self-animating indicator in the chat area for
 * exactly the duration of the check.
 */
class CheckSpinnerComponent {
  private frame = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: { requestRender(): void },
    private theme: Pick<Theme, "fg">,
    private label: string,
  ) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % CHECK_SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, CHECK_SPINNER_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // Width-keyed rendering isn't cached; the timer drives frame changes.
  }

  render(width: number): string[] {
    const frame = this.theme.fg("accent", CHECK_SPINNER_FRAMES[this.frame]!);
    return [truncateToWidth(` ${frame} ${this.label}`, width)];
  }
}

/** Plain reminder re-injected as a one-shot custom message when a compaction hid the goal. */
export function renderGoalReminder(goal: Goal): string {
  const lines = [`GOAL REMINDER — active goal #${goal.id}:`, goal.objective, ""];
  for (const c of effectiveCriteria(goal)) lines.push(`  • ${c}`);
  lines.push(
    "Context may have been reset by compaction. Re-orient first: check git status/diff and review any plan/todo, note what is already done, and do NOT redo completed work.",
  );
  lines.push(
    'Keep working toward it. When every criterion is met AND verified (run the real check — do not assert it from memory), call the goal tool with action "complete" and per-criterion evidence citing the actual command and its output.',
  );
  return lines.join("\n");
}

/**
 * Turn-end check prompt, injected as a HIDDEN followUp at the end of each turn
 * while a goal is active. It carries the graded result of the goal's verify
 * command — the measured state — and either directs the agent to close the
 * remaining gaps (check failed) or to summarize and complete (check passed).
 * This is what keeps the agent working turn after turn without a visible
 * "keep going" line.
 */
export function renderCheckPrompt(
  goal: Goal,
  check: VerifyResult,
  continuations: number,
  max: number,
  staleContinuations = 0,
): string {
  const lines = [`GOAL #${goal.id} — turn-end check (continuation ${continuations}/${max}):`, goal.objective, ""];
  for (const c of effectiveCriteria(goal)) lines.push(`  • ${c}`);
  // Staleness rides the outcome lines, not the measured-state block: a reused
  // timeout has empty output, and "it timed out" presented as just-happened
  // would send the model chasing a stale failure.
  const stale = staleContinuations > 0 ? `, measured ${staleContinuations} continuation(s) ago` : "";
  const measured = check.output.trim() ? `\n\nMeasured state (verify output):\n${check.output.trim()}` : "";
  if (check.ok) {
    lines.push("", `The verify command passed (exit 0).${stale}${measured}`, "");
    lines.push(
      'The measurable criterion is met. Summarize the final state — what was achieved, the key numbers, what changed — and call the goal tool with action "complete", citing per-criterion evidence from the real commands and their output.',
    );
  } else {
    const why = check.spawnError
      ? `it could not run (${check.spawnError})`
      : check.timedOut
        ? "it timed out"
        : `it exited ${check.exitCode ?? "?"}`;
    lines.push("", `The verify command did not pass yet (${why}${stale}).${measured}`, "");
    lines.push(
      'Do not declare the goal done. Read the measured state above, identify the specific gaps it reveals, and make concrete progress closing them this turn — do not redo work already done. When you believe every criterion is met, re-run the check yourself; only if it genuinely passes, call the goal tool with action "complete" with per-criterion evidence. Call "blocked" only for a true, non-transient impasse.',
    );
  }
  return lines.join("\n");
}

/** Transcript row for a goal.check message: the loop's visible heartbeat —
 * which continuation ran, what the verify said, what happens next. Registered
 * via registerMessageRenderer so the model still receives the full prompt while
 * the user sees one compact line. */
export function renderCheckMessage(
  details: GoalCheckDetails | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg">,
): string {
  if (!details) return theme.fg("dim", "goal check");
  const outcome = details.ok
    ? theme.fg("success", "verify passed — agent will summarize and complete")
    : theme.fg(
        "accent",
        `verify ${
          details.timedOut
            ? "timed out"
            : details.spawnError
              ? `could not run (${details.spawnError})`
              : `failed (exit ${details.exitCode ?? "?"})`
        } — continuing`,
      );
  const stale =
    details.staleContinuations > 0 ? theme.fg("dim", ` · measured ${details.staleContinuations} turn(s) ago`) : "";
  const head = `${theme.fg("dim", `goal check ${details.continuation}/${details.max} · `)}${outcome}${stale}`;
  if (options.expanded && details.output.trim()) {
    return `${head}\n${details.output.trim()}`;
  }
  return head;
}

const STATUS_COLORS: Record<GoalStatus, "accent" | "muted" | "error" | "success"> = {
  active: "accent",
  paused: "muted",
  blocked: "error",
  complete: "success",
};

/** Collapsed call row: `goal <objective>`, `goal complete`, or `goal blocked`. */
export function renderGoalCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
  const a = (args ?? {}) as { action?: string; objective?: unknown };
  if (a.action === "set" && typeof a.objective === "string") {
    return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("dim", clip(a.objective, 60));
  }
  if (a.action === "complete") return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("success", "complete");
  if (a.action === "blocked") return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("error", "blocked");
  return theme.fg("toolTitle", theme.bold("goal"));
}

/** Result row: `goal #N <status> — objective`, with the criteria list when expanded. */
export function renderGoalResult(
  details: GoalDetails | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg" | "bold">,
): string {
  if (details?.error) return theme.fg("error", `✗ ${details.error}`);
  const goal = details?.goal;
  if (!goal) return theme.fg("dim", "no goal");
  let text = theme.fg("toolTitle", theme.bold(`goal #${goal.id} `)) + theme.fg(STATUS_COLORS[goal.status], goal.status);
  text += ` ${theme.fg("dim", clip(goal.objective, 50))}`;
  if (options.expanded) {
    const list = effectiveCriteria(goal)
      .map((c) => `  • ${theme.fg("dim", c)}`)
      .join("\n");
    text += `\n${list}`;
    if (goal.status === "blocked" && goal.blockedReason)
      text += `\n  ${theme.fg("error", `blocked: ${goal.blockedReason}`)}`;
  }
  return text;
}

/** Reuse the prior render component when available (pi renderer idiom). */
function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

/** Full-screen status shown by /goal (no arguments). */
class GoalStatusComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private goal: Goal | null,
    private theme: Pick<Theme, "fg" | "bold">,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [""];

    const title = th.fg("accent", " Goal ");
    const header =
      th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(header, width), "");

    if (!this.goal) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No active goal. Set one with /goal <objective> or the goal tool.")}`, width),
      );
    } else {
      const g = this.goal;
      lines.push(truncateToWidth(`  ${th.fg("muted", `#${g.id}`)} ${th.fg("text", g.objective)}`, width));
      lines.push(truncateToWidth(`  ${th.fg(STATUS_COLORS[g.status], g.status)}`, width));
      lines.push("");
      for (const c of effectiveCriteria(g)) lines.push(truncateToWidth(`  • ${th.fg("dim", c)}`, width));
      if (g.status === "blocked" && g.blockedReason) {
        lines.push(truncateToWidth(`  ${th.fg("error", `blocked: ${g.blockedReason}`)}`, width));
      }
    }

    lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  // Required by pi's Component interface; the width-keyed render cache makes this
  // a no-op for width changes, but pi may call it for other reasons.
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Loose entry shape so the scan accepts both SessionEntry[] and test doubles. */
type GoalBranchEntry = {
  type?: string;
  customType?: unknown;
  message?: { role?: string; toolName?: string; content?: unknown; details?: unknown } | null;
};

/**
 * One scan of the branch: the newest valid goal snapshot (tool results carry the
 * state) and whether a compaction after it hid the goal (no reminder carrier
 * follows it). Snapshots with malformed details never win — the scan keeps the
 * last one whose `details.goal` is a valid Goal.
 */
export function scanGoalBranch(branch: GoalBranchEntry[]): { goal: Goal | null; hiddenByCompaction: boolean } {
  let goal: Goal | null = null;
  let lastIndex = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "toolResult" || msg.toolName !== GOAL_TOOL_NAME) continue;
    const g = (msg.details as GoalDetails | undefined)?.goal;
    if (!isGoal(g)) continue;
    goal = g;
    lastIndex = i;
  }
  // Only the newest compaction after the snapshot decides: a later one folds the
  // earlier and is what the context actually shows.
  let lastCompactionIndex = -1;
  for (let i = branch.length - 1; i > lastIndex; i--) {
    if (branch[i].type === "compaction") {
      lastCompactionIndex = i;
      break;
    }
  }
  const hiddenByCompaction =
    goal !== null &&
    goal.status === "active" &&
    lastCompactionIndex !== -1 &&
    !branch
      .slice(lastCompactionIndex + 1)
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          (entry.customType === GOAL_REMINDER_TYPE || entry.customType === GOAL_CHECK_TYPE),
      );
  return { goal, hiddenByCompaction };
}

/** Newest goal snapshot recorded on the session branch, or null. */
export function lastGoalSnapshot(branch: GoalBranchEntry[]): Goal | null {
  return scanGoalBranch(branch).goal;
}

export interface RegisterGoalOptions {
  /** Optional semantic judge (Jev-style). v1 leaves this unset; the structural gate is the floor. */
  judge?: GoalJudge;
  /** Optional progress judge consulted at the continuation cap. Defaults to the
   *  deterministic defaultProgressJudge (verify output changed ⇒ progressing). */
  progressJudge?: ProgressJudge;
  /** Cap on judge-approved budget resets at the continuation cap. Defaults to
   *  PI_GOAL_MAX_PROGRESS_RESETS, then GOAL_MAX_PROGRESS_RESETS_DEFAULT. */
  maxProgressResets?: number;
  /** Run the verify check every Nth continuation, reusing the last measured
   *  state in between. Defaults to PI_GOAL_CHECK_EVERY, then 1 (every turn). */
  checkEvery?: number;
  /** Per-session cap on auto-continuations for a still-active goal. Defaults to
   *  PI_GOAL_MAX_CONTINUATIONS, then GOAL_MAX_CONTINUATIONS_DEFAULT. */
  maxContinuations?: number;
  /** Per-run turn bound before steering a settle. Defaults to
   *  PI_GOAL_MAX_TURNS_PER_RUN, then GOAL_MAX_TURNS_PER_RUN_DEFAULT. */
  maxTurnsPerRun?: number;
  /** Verifier run on `complete` (and prefetched on `set`). Inject a fake in tests. */
  verifyRunner?: VerifyRunner;
  /** Timeout (ms) for a verify run. Defaults to PI_GOAL_VERIFY_TIMEOUT_MS, then VERIFY_TIMEOUT_MS_DEFAULT. */
  verifyTimeoutMs?: number;
}

export function registerGoalTool(pi: ExtensionAPI, options: RegisterGoalOptions = {}): void {
  let goal: Goal | null = null;
  let goalSeq = 0;
  let compactedSinceUpdate = false;
  let continuations = 0;
  let stopped = false;
  let perRunTurns = 0;
  let perRunNudged = false;
  // Captured from the latest ctx (session_start / session_tree / agent_before_settle)
  // so the goal tool handlers (which get no ctx) can still update the footer.
  let uiRef: ExtensionContext["ui"] | undefined;
  const maxContinuations = options.maxContinuations ?? parseMaxContinuations(process.env[GOAL_MAX_CONTINUATIONS_ENV]);
  const maxTurnsPerRun = options.maxTurnsPerRun ?? parseMaxTurnsPerRun(process.env[GOAL_MAX_TURNS_PER_RUN_ENV]);
  const maxProgressResets =
    options.maxProgressResets ?? parseMaxProgressResets(process.env[GOAL_MAX_PROGRESS_RESETS_ENV]);
  const progressJudge: ProgressJudge = options.progressJudge ?? { assess: defaultProgressJudge };
  const judge = options.judge;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? parseVerifyTimeoutMs(process.env[VERIFY_TIMEOUT_ENV]);
  const verifyRunner: VerifyRunner = options.verifyRunner ?? runVerify;
  // Verify outputs observed during the current budget window (oldest first) —
  // the evidence the progress judge reads at the cap. Cleared with the budget.
  let budgetOutputs: string[] = [];
  let resetsUsed = 0;
  const checkEvery = options.checkEvery ?? parseCheckEvery(process.env[GOAL_CHECK_EVERY_ENV]);
  // Last verify result + how many continuations ago it ran. With checkEvery > 1
  // most turns reuse it instead of re-running an expensive verify.
  let lastCheck: VerifyResult | undefined;
  let lastCheckAge = 0;

  const activateTool = () => {
    const active = pi.getActiveTools();
    if (!active.includes(GOAL_TOOL_NAME)) pi.setActiveTools([...active, GOAL_TOOL_NAME]);
  };

  // Footer status: `goal · <elapsed>` while a goal is active, `goal · <elapsed> · paused`
  // while paused (so a parked goal stays visible), cleared on completion /
  // block. Best-effort — a missing UI (print mode) is a no-op.
  // Re-asserted at every event below: pi clears extension statuses on
  // rebind/reload (resetExtensionUI), so a status set once would vanish until
  // the next turn_end — visible as the footer "coming and going".
  const updateFooter = (checking = false) => {
    if (goal && goal.status === "active") {
      uiRef?.setStatus("goal", checking ? `goal · checking (${goal.verify})` : renderGoalFooter(goal, Date.now()));
    } else if (goal && goal.status === "paused") {
      // No elapsed while paused: startedAt never freezes, so a ticking clock
      // would read as active work time during a long conversation.
      uiRef?.setStatus("goal", "goal · paused");
    } else uiRef?.setStatus("goal", undefined);
  };
  const clearFooter = () => uiRef?.setStatus("goal", undefined);

  // Reset the auto-continuation budget. Called only at genuine engagement
  // boundaries (a resumed session or a user /goal kickoff) — never on the
  // model's set/complete/blocked, which is how a stuck model would defeat the cap.
  const resetContinuationBudget = () => {
    continuations = 0;
    stopped = false;
    budgetOutputs = [];
    resetsUsed = 0;
    lastCheck = undefined; // a resumed goal re-establishes its measured state
    lastCheckAge = 0;
  };

  const adoptBranchState = (ctx: ExtensionContext) => {
    if (ctx.ui) uiRef = ctx.ui;
    const { goal: g, hiddenByCompaction } = scanGoalBranch(ctx.sessionManager.getBranch() as GoalBranchEntry[]);
    goal = g;
    if (g) goalSeq = g.id;
    compactedSinceUpdate = hiddenByCompaction;
    continuations = 0;
    budgetOutputs = [];
    resetsUsed = 0;
    lastCheck = undefined;
    lastCheckAge = 0;
    // Re-arm the continuation loop for an active goal on resume; a finished or
    // blocked snapshot stays disarmed. A branch with NO goal (a fresh session)
    // stays armed — disarming there would kill the loop for a goal the model
    // sets later in the same session, since a model set never re-arms.
    stopped = g ? g.status !== "active" : false;
    if (g && g.status !== "complete") activateTool();
    updateFooter();
  };

  const setGoal = (objective: string, criteria: string[], verify?: string): Goal => {
    goalSeq += 1;
    goal = { id: goalSeq, objective, criteria, status: "active", startedAt: Date.now(), ...(verify ? { verify } : {}) };
    compactedSinceUpdate = false;
    // Scope the judge's evidence to THIS goal: a window mixing goal A's outputs
    // with goal B's would let a re-set with any differently-printing verify buy
    // a "progressing" reset without moving the current goal. Clearing only the
    // evidence (not continuations/resetsUsed) is strictly tightening — a fresh
    // window with <2 outputs fails closed to the stop.
    budgetOutputs = [];
    lastCheck = undefined; // a new verify command invalidates the cached state
    lastCheckAge = 0;
    // A model-set goal does NOT reset the continuation budget: re-setting the goal
    // must not farm fresh auto-continuations and defeat the cap. The budget
    // re-arms only at resume, a gated completion, or a user /goal kickoff.
    activateTool();
    updateFooter();
    return goal;
  };

  pi.on("session_start", (_event, ctx) => {
    adoptBranchState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    adoptBranchState(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    if (goal?.status !== "active") return;
    // A compaction folds the goal out of context. If it happens mid-turn,
    // before_agent_start won't re-fire until the next user prompt, so re-inject
    // now by steering the in-progress run (no new turn). Between turns there is
    // nothing to steer; re-arm the flag for the next before_agent_start instead.
    const midTurn = ctx ? !ctx.isIdle() : false;
    if (midTurn) {
      pi.sendMessage(
        { customType: GOAL_REMINDER_TYPE, content: renderGoalReminder(goal), display: false },
        { deliverAs: "steer", triggerTurn: false },
      );
      compactedSinceUpdate = false; // already re-injected this turn
    } else {
      compactedSinceUpdate = true;
    }
  });

  pi.on("before_agent_start", () => {
    updateFooter(); // re-assert: pi clears extension statuses on rebind/reload
    // A paused goal must not be worked on: the model's context still holds the
    // original "work toward the goal" instruction, and without a per-prompt
    // steer it would keep grinding criteria inside every conversational turn.
    if (goal && goal.status === "paused") {
      return {
        message: {
          customType: GOAL_PAUSED_STEER_TYPE,
          content:
            `GOAL PAUSED — goal #${goal.id} was paused by the user for a conversation. ` +
            "Do NOT work toward it this turn and do not call the goal tool; just respond to the user's message. " +
            "The user will resume it with /goal resume.",
          display: false,
        },
      };
    }
    // A between-turns compaction folds the goal out of context and there is no
    // in-progress turn to steer, so re-inject it at the start of the next turn.
    // (Mid-turn compactions are handled directly in the session_compact handler.)
    if (goal && goal.status === "active" && compactedSinceUpdate) {
      compactedSinceUpdate = false; // consume: fire once, not every turn
      return {
        message: {
          customType: GOAL_REMINDER_TYPE,
          content: renderGoalReminder(goal),
          display: false,
        },
      };
    }
    return undefined;
  });

  // The continuation loop — the "turn-end check" that drives the goal. At each
  // settle (the point where the run is about to hand control back), if the goal is
  // active and carries a measurable check, the extension runs the check (bounded),
  // reads the graded result, and queues a HIDDEN follow-up (display:false — the user
  // sees no "keep going" line) telling the agent the measured state and what to do
  // next. Returning { continue: true } makes the session call agent.continue() with
  // that queued message — a clean in-loop continuation, not a fresh prompt. At the
  // cap we stop and tell the user, so a stuck loop can't run away.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (ctx.ui) uiRef = ctx.ui;
    // Only re-engage after a clean completion — not after an errored or aborted
    // run, where re-engaging would just re-run the failure.
    if (event.outcome === "error" || event.outcome === "aborted") return;
    if (!goal || goal.status !== "active" || stopped) return;
    if (!goal.verify) return;
    if (continuations >= maxContinuations) {
      // At the cap, a progress judge decides: still moving → reset the budget
      // and continue (itself capped, so the judge can't defeat the breaker);
      // plateaued or no opinion → stop. Fail-closed on ambiguity.
      let verdict: ProgressVerdict | undefined;
      try {
        // Awaited so an async (LLM) judge needs no adapter; its rejection lands
        // in this catch and fails closed.
        verdict = await progressJudge.assess(goal, budgetOutputs);
      } catch {
        verdict = undefined; // a throwing judge must not extend the run
      }
      if (verdict?.continueRun && resetsUsed < maxProgressResets) {
        resetsUsed += 1;
        continuations = 0;
        budgetOutputs = [];
        // Drop the cached check too: a fresh window must open with a fresh
        // baseline, else (with a high checkEvery) the window would hold a
        // single fresh output and the judge would fail closed on "not enough
        // measured states" — defeating the judge in exactly the configs the
        // throttle exists for.
        lastCheck = undefined;
        lastCheckAge = 0;
        ctx.ui?.notify(
          `Goal #${goal.id} hit the continuation cap but is still progressing (${verdict.reason ?? "judge approved"}) — ` +
            `resetting the budget (reset ${resetsUsed}/${maxProgressResets}).`,
        );
      } else {
        stopped = true;
        const why = verdict?.continueRun
          ? `progress-judge resets exhausted (${resetsUsed}/${maxProgressResets})`
          : verdict
            ? (verdict.reason ?? "no progress signal")
            : "progress judge unavailable — failing closed";
        ctx.ui?.notify(
          `Goal #${goal.id} still active after ${maxContinuations} auto-continuations — stopping (${why}). ` +
            "Complete it via the goal tool, adjust it, or /goal stop.",
        );
        updateFooter();
        return;
      }
    }
    continuations += 1;
    let check: VerifyResult;
    // Throttle: with checkEvery > 1 only every Nth continuation re-runs the
    // verify; the others reuse the last measured state (aged) so the settle is
    // instant instead of a silent multi-minute benchmark.
    const due = continuations % checkEvery === 0 || !lastCheck;
    const verifyCommand = goal.verify; // captured for the closure: narrowing of `goal` doesn't cross it
    if (due) {
      // Animated chat-area spinner while the (possibly minutes-long) verify
      // runs — pi clears its own working spinner at agent_end, so without this
      // the settle boundary renders as a dead pause.
      uiRef?.setWidget(
        GOAL_CHECK_WIDGET_KEY,
        (tui: { requestRender(): void }, theme: Pick<Theme, "fg">) =>
          new CheckSpinnerComponent(tui, theme, `running goal check: ${clip(verifyCommand, 60)}`),
      );
      try {
        check = await verifyRunner(goal.verify, { timeoutMs: verifyTimeoutMs });
      } catch (e) {
        // The built-in runner never rejects; an injected one might. A throw must
        // not escape the settle boundary — treat it as a failed check and
        // re-engage with the error so the model can fix the check itself.
        check = {
          ok: false,
          exitCode: null,
          timedOut: false,
          spawnError: e instanceof Error ? e.message : String(e),
          output: "",
        };
      }
      lastCheck = check;
      lastCheckAge = 0;
      uiRef?.setWidget(GOAL_CHECK_WIDGET_KEY, undefined); // spinner lives only for the check's duration
    } else {
      check = lastCheck!;
      lastCheckAge += 1;
    }
    updateFooter();
    if (due) recordBudgetOutput(budgetOutputs, check.output);
    pi.sendMessage(
      {
        customType: GOAL_CHECK_TYPE,
        content: renderCheckPrompt(goal, check, continuations, maxContinuations, lastCheckAge),
        // Visible in the transcript via the compact renderer (registerMessageRenderer
        // below) — the loop's heartbeat shouldn't be invisible to the user.
        display: true,
        details: {
          continuation: continuations,
          max: maxContinuations,
          ok: check.ok,
          exitCode: check.exitCode,
          timedOut: check.timedOut,
          ...(check.spawnError ? { spawnError: check.spawnError } : {}),
          staleContinuations: lastCheckAge,
          output: clip(check.output, 2000),
        } satisfies GoalCheckDetails,
      },
      { deliverAs: "followUp" },
    );
    return { continue: true };
  });

  // Per-run busy-loop bound: a stuck model can loop tool calls inside a single
  // run without ever settling, so the settle-cap never fires and the run burns
  // unbounded cost. Count turns per run; past the bound, steer the model to
  // settle once so the run is bounded and the settle-cap can re-engage.
  pi.on("agent_start", () => {
    perRunTurns = 0;
    perRunNudged = false;
    updateFooter(); // re-assert: pi clears extension statuses on rebind/reload
  });
  pi.on("turn_end", () => {
    if (!goal || goal.status !== "active") return;
    updateFooter(); // keep the footer's elapsed time current during a long run (and after the cap trips)
    if (stopped) return;
    perRunTurns += 1;
    if (!perRunNudged && perRunTurns >= maxTurnsPerRun) {
      perRunNudged = true;
      pi.sendMessage(
        {
          customType: GOAL_REMINDER_TYPE,
          content: `You have made ${perRunTurns} steps this run without settling. Summarize your progress and stop now; I will re-engage you with the goal.`,
          display: false,
        },
        { deliverAs: "steer", triggerTurn: false },
      );
    }
  });

  // Compact transcript rendering for the visible goal.check messages — the
  // model receives the full prompt; the user sees the one-line heartbeat
  // (continuation count, verify outcome, stale age), with the measured state
  // when the row is expanded.
  pi.registerMessageRenderer?.(GOAL_CHECK_TYPE, (message, options, theme) => {
    const text = new Text("", 0, 0);
    text.setText(
      renderCheckMessage(message.details as GoalCheckDetails | undefined, { expanded: options.expanded }, theme),
    );
    return text;
  });

  pi.registerTool({
    name: GOAL_TOOL_NAME,
    label: "Goal",
    description:
      'Track a single high-level objective that must be finished and verified. Use it to commit to a goal and to gate its completion: set a goal (optionally with checkable criteria and a `verify` check, e.g. `npm test` or a coverage report, that prints the measured state and exits 0 only when the objective is met — the extension runs it at the end of every turn, reads the output to see what is still missing, and re-engages you to close the gaps, so it must genuinely exit 0, not just be claimed), then work toward it, then call it again with action "complete" and per-criterion evidence (evidence[i] proves criteria[i]) — a free-text \'done\' without proof is rejected, as is a summary that names a failure. Call it with action "blocked" only for a true impasse. Do not use it to organize steps (that is the todo tool) or for work that finishes in a couple of tool calls.',
    parameters: GoalParams,
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params) {
      if (params.action === "set") {
        // A user-paused goal must not be replaced: set is the one action that
        // persists a new snapshot, so an unguarded call would discard the
        // pause AND wedge /goal resume (stopped stays true, status goes
        // active). The steer says don't call the tool; this is the backstop.
        if (goal?.status === "paused") {
          return finish(
            goal,
            `Error: goal #${goal.id} is paused by the user; wait for /goal resume before starting or changing goals`,
            "goal is paused",
          );
        }
        const o = validateObjective(params.objective);
        if (o.error) return finish(null, `Error: ${o.error}`);
        const c = validateCriteria(params.criteria);
        if (c.error) return finish(null, `Error: ${c.error}`);
        const v = validateVerify(params.verify);
        if (v.error) return finish(null, `Error: ${v.error}`);
        const g = setGoal(o.objective, c.criteria, v.verify);
        const criteriaLine =
          g.criteria.length > 0 ? ` Criteria: ${g.criteria.map((cr, i) => `${i + 1}. ${cr}`).join("; ")}.` : "";
        if (!g.verify) {
          return finish(
            g,
            `Goal #${g.id} set: ${g.objective}.${criteriaLine} Call goal with action "complete" and per-criterion evidence when done.`,
          );
        }
        // Preflight: run the verify now to establish the baseline. A verify that
        // already passes means the goal is likely already met or mis-specified,
        // so surface it before the model starts (and before it can "complete" trivially).
        const pre = await verifyRunner(g.verify, { timeoutMs: verifyTimeoutMs });
        // Seed the budget window with the baseline so the judge has a first
        // measured state even for tiny caps (PI_GOAL_MAX_CONTINUATIONS=1).
        recordBudgetOutput(budgetOutputs, pre.output);
        const baseline = pre.ok
          ? ` NOTE: the verify command already passes — confirm the goal isn't already met or the check is too weak, and refine it if so.`
          : ` It currently fails, as expected for an unmet goal; completion is gated on it passing.`;
        return finish(
          g,
          `Goal #${g.id} set: ${g.objective}.${criteriaLine} Completion is gated on the verify command \`${g.verify}\` exiting 0${baseline} Call goal with action "complete" when done.`,
        );
      }

      if (params.action === "complete") {
        if (!goal) return finish(null, "Error: no goal to complete");
        const check = checkCompletion(goal, {
          goalId: params.goalId,
          summary: params.summary,
          evidence: params.evidence,
        });
        if (!check.ok) {
          return finish(
            goal,
            `Goal #${goal.id} NOT completed: ${check.reason}\nObjective: ${goal.objective}`,
            check.reason,
          );
        }
        // checkCompletion has validated these by now; re-narrow for the flat schema.
        const summary = params.summary ?? "";
        const evidence = params.evidence ?? [];
        // Independent verification: run the goal's verify command and require a zero
        // exit. The extension executes it (bounded) — the model cannot fake the result
        // — which is what makes completion consistent and truthful. A failure is
        // rejected with its output so the model fixes the real cause and retries.
        if (goal.verify) {
          const res = await verifyRunner(goal.verify, { timeoutMs: verifyTimeoutMs });
          // A failed complete-time verify is the freshest measurement — cache it
          // so a throttled settle doesn't reuse (and over-age) an older result.
          if (!res.ok) {
            lastCheck = res;
            lastCheckAge = 0;
          }
          if (!res.ok) {
            const detail = res.spawnError
              ? `verify could not run: ${res.spawnError}`
              : res.timedOut
                ? `verify timed out after ${verifyTimeoutMs} ms`
                : `verify exited ${res.exitCode ?? "?"}`;
            return finish(
              goal,
              `Goal #${goal.id} NOT completed — ${detail}.\nOutput:\n${res.output}\nFix the failure, then call complete again with fresh evidence.`,
              `verify failed: ${detail}`,
            );
          }
        }
        // Optional semantic second opinion (Jev-style). v1 ships no judge.
        const verdict = judge?.evaluate(goal, evidence, summary);
        if (verdict && !verdict.complete) {
          const judgeReason = `judge: ${verdict.reason ?? "insufficient evidence"}`;
          return finish(goal, `Goal #${goal.id} NOT completed: ${judgeReason}`, judgeReason);
        }
        goal = { ...goal, status: "complete" };
        clearFooter();
        // A completion does NOT re-arm the budget: the structural gate is
        // presence-only (no judge in v1), so a self-certifying model could
        // otherwise fake `complete` to farm fresh auto-continuations. The budget
        // re-arms only on resume or a user /goal kickoff, keeping the cap a true
        // per-session circuit breaker.
        return finish(goal, `Goal #${goal.id} complete: ${summary.trim()}`);
      }

      // params.action === "blocked"
      if (params.action !== "blocked") {
        // A loud error, not a silent status readout: empty or malformed
        // arguments used to fall through to "No goal." with no signal about
        // what went wrong (observed with a rootless-union schema on zai).
        return finish(
          null,
          `Error: action must be one of "set", "complete", or "blocked" (got ${JSON.stringify(params.action) ?? "nothing"}); resend the call with the full arguments object`,
          "invalid action",
        );
      }
      if (!goal) return finish(null, "Error: no goal to block");
      if (!Number.isInteger(params.goalId) || params.goalId !== goal.id) {
        const r = `stale goal id ${String(params.goalId)}; the current goal is #${goal.id}`;
        return finish(goal, `Goal NOT blocked: ${r}`, r);
      }
      if (goal.status !== "active") {
        const r = `goal is ${goal.status}, not active`;
        return finish(goal, `Goal NOT blocked: ${r}`, r);
      }
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (reason === "") {
        const r = "reason must be non-empty";
        return finish(goal, `Goal NOT blocked: ${r}`, r);
      }
      goal = { ...goal, status: "blocked", blockedReason: reason };
      clearFooter();
      return finish(goal, `Goal #${goal.id} blocked: ${reason}`);

      function finish(state: Goal | null, text: string, error?: string) {
        return {
          content: [{ type: "text" as const, text }],
          details: { goal: state, ...(error ? { error } : {}) } as GoalDetails,
        };
      }
    },
    renderCall(args, theme, context) {
      const text = reuseText(context);
      text.setText(renderGoalCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = reuseText(context);
      text.setText(renderGoalResult(result.details as GoalDetails | undefined, { expanded: options.expanded }, theme));
      return text;
    },
  });

  const statusText = (): string => {
    if (!goal) return "No goal.";
    const criteria = effectiveCriteria(goal)
      .map((c, i) => `  ${i + 1}. ${c}`)
      .join("\n");
    const extra = goal.status === "blocked" && goal.blockedReason ? `\nBlocked: ${goal.blockedReason}` : "";
    return `Goal #${goal.id} (${goal.status}): ${goal.objective}\n${criteria}${extra}`;
  };

  pi.registerCommand("goal", {
    description:
      "Show the active goal, start one with /goal <objective>, pause/resume with /goal pause|resume, or stop the loop with /goal stop",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed === "" || trimmed === "status" || trimmed === "show") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(statusText());
          return;
        }
        await ctx.ui.custom<void>((_tui, theme, _kb, done) => new GoalStatusComponent(goal, theme, () => done()));
        return;
      }

      if (trimmed === "pause") {
        if (!goal || goal.status !== "active") {
          ctx.ui.notify("No active goal to pause.");
          return;
        }
        // Session-scoped, like stop: the loop halts and the goal shows paused,
        // but nothing is persisted to the branch — a reload re-adopts the last
        // snapshot. Unlike stop, the goal stays pursuing (not blocked) and all
        // progress is retained for /goal resume.
        stopped = true;
        goal = { ...goal, status: "paused" };
        updateFooter();
        ctx.ui.notify(
          `Goal #${goal.id} paused — talk freely; /goal resume when ready. Session-scoped: reloading the session resumes it.`,
        );
        return;
      }

      if (trimmed === "resume") {
        if (!goal || goal.status !== "paused") {
          ctx.ui.notify("No paused goal to resume.");
          return;
        }
        // A user resuming is a deliberate engagement: re-arm the continuation
        // budget, exactly like a user (re)starting a goal.
        goal = { ...goal, status: "active" };
        stopped = false;
        resetContinuationBudget();
        ctx.ui.notify(`Goal #${goal.id} resumed.`);
        pi.sendUserMessage(
          `The user paused goal #${goal.id} to have a conversation; that conversation is over and the goal is active again. Continue working toward it — the goal is: ${goal.objective}`,
          { deliverAs: "followUp" },
        );
        return;
      }

      if (trimmed === "stop") {
        if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
          ctx.ui.notify("No active or paused goal to stop.");
          return;
        }
        // Session-scoped kill switch: pause auto-continuation and mark the goal
        // not-pursuing (blocked). Not persisted to the branch — goal state stays
        // model-owned, so a reload re-adopts the last snapshot and can re-arm.
        stopped = true;
        goal = { ...goal, status: "blocked", blockedReason: "stopped by user" };
        clearFooter();
        ctx.ui.notify(`Goal #${goal.id} stopped (auto-continuation paused for this session).`);
        return;
      }

      // Start a goal by routing it through the model: the goal is created by the
      // goal tool (which persists a branch snapshot), so the branch stays the
      // single source of truth. Pause/resume are the deliberate user-control
      // exceptions: they only steer the session loop (the model still owns the
      // branch snapshot).
      const o = validateObjective(trimmed);
      if (o.error) {
        ctx.ui.notify(o.error, "error");
        return;
      }
      activateTool();
      // A user (re)starting a goal re-arms the loop budget — a deliberate
      // engagement, distinct from the model's autonomous set (which can't re-arm).
      resetContinuationBudget();
      pi.sendUserMessage(
        `Set the goal "${trimmed}" using the goal tool (action "set"). If the objective is measurable, give it a verify command that prints the current state and exits 0 only when the objective is met — the extension re-runs it at the end of every turn and only lets you complete when it passes. Then work toward the goal, and when it is genuinely met, call the goal tool with action "complete" and per-criterion evidence that cites the real command and its output.`,
        { deliverAs: "followUp" },
      );
      ctx.ui.notify("Goal started; the agent will set it via the goal tool.");
    },
  });
}

export default registerGoalTool;
