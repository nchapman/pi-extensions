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
 * - an agent_settled continuation loop keeps the agent working toward the goal:
 *   on every settle, if the goal is still active it injects a followUp restating
 *   the objective + criteria, so the run proceeds turn after turn until the goal
 *   is completed or blocked. Two model-untouchable circuit breakers keep a stuck
 *   run bounded: a per-session cap (PI_GOAL_MAX_CONTINUATIONS) on
 *   auto-continuations, and a per-run turn bound (PI_GOAL_MAX_TURNS_PER_RUN) that
 *   steers a long turn to settle so the cap can re-engage. The model's
 *   set/complete/blocked actions never reset either (a stuck model can't farm
 *   fresh turns by re-setting or faking a completion); both re-arm only on a
 *   resumed session or when the user starts a goal via /goal, and /goal stop
 *   halts the loop session-scoped
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
  /** Optional shell command that must exit 0 for the goal to count as complete. */
  verify?: string;
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

export interface RegisterGoalOptions {
  /** Optional semantic judge (Jev-style). v1 leaves this unset; the structural gate is the floor. */
  judge?: GoalJudge;
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

const GOAL_STATUSES = ["active", "paused", "blocked", "complete"] as const;

const GoalSetParams = Type.Object({
  action: Type.Literal("set"),
  objective: Type.String({ description: "The goal, in one or a few sentences. Keep it under 4000 chars." }),
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
        "Optional shell command that must exit 0 for the goal to count as complete (e.g. `npm test`). The extension runs it on completion — it must genuinely pass, not just be claimed. A no-op that always passes is rejected.",
    }),
  ),
});

const GoalCompleteParams = Type.Object({
  action: Type.Literal("complete"),
  goalId: Type.Number({ description: "The id of the goal being completed (from the last set result)." }),
  summary: Type.String({ description: "A concise statement of what was done." }),
  evidence: Type.Array(
    Type.String({
      description: "Concrete proof for the criterion at the same index (test name, file, command output).",
    }),
    { description: "evidence[i] is the proof for criteria[i]; one entry per criterion." },
  ),
});

const GoalBlockedParams = Type.Object({
  action: Type.Literal("blocked"),
  goalId: Type.Number({ description: "The id of the goal being blocked." }),
  reason: Type.String({ description: "Why the goal cannot proceed." }),
});

const GoalParams = Type.Union([GoalSetParams, GoalCompleteParams, GoalBlockedParams]);

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
    (goal.verify === undefined || typeof goal.verify === "string")
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
 * Continuation prompt injected as a followUp at the end of each turn while a goal
 * is still active — the mechanism that keeps the agent working (and re-states the
 * objective) turn after turn until the goal is completed or blocked.
 */
export function renderContinuationPrompt(goal: Goal, continuations: number, max: number): string {
  const lines = [
    `GOAL #${goal.id} is not complete — keep working toward it (continuation ${continuations}/${max}):`,
    goal.objective,
    "",
  ];
  for (const c of effectiveCriteria(goal)) lines.push(`  • ${c}`);
  lines.push(
    "Do not stop or write a final summary until every criterion is met AND verified. Make progress this turn — if a step fails, diagnose it and continue; do not declare the goal blocked over a transient failure, and do not redo work already done.",
  );
  lines.push(
    'Before calling complete, re-verify each criterion by actually running the check (read the file / run the test), and cite the real command and its output as evidence. Only call "complete" when every criterion genuinely passes; call "blocked" with a reason only for a true, non-transient impasse.',
  );
  return lines.join("\n");
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
      .some((entry) => entry.type === "custom_message" && entry.customType === GOAL_REMINDER_TYPE);
  return { goal, hiddenByCompaction };
}

/** Newest goal snapshot recorded on the session branch, or null. */
export function lastGoalSnapshot(branch: GoalBranchEntry[]): Goal | null {
  return scanGoalBranch(branch).goal;
}

export interface RegisterGoalOptions {
  /** Optional semantic judge (Jev-style). v1 leaves this unset; the structural gate is the floor. */
  judge?: GoalJudge;
  /** Per-session cap on auto-continuations for a still-active goal. Defaults to
   *  PI_GOAL_MAX_CONTINUATIONS, then GOAL_MAX_CONTINUATIONS_DEFAULT. */
  maxContinuations?: number;
  /** Per-run turn bound before steering a settle. Defaults to
   *  PI_GOAL_MAX_TURNS_PER_RUN, then GOAL_MAX_TURNS_PER_RUN_DEFAULT. */
  maxTurnsPerRun?: number;
}

export function registerGoalTool(pi: ExtensionAPI, options: RegisterGoalOptions = {}): void {
  let goal: Goal | null = null;
  let goalSeq = 0;
  let compactedSinceUpdate = false;
  let continuations = 0;
  let stopped = false;
  let perRunTurns = 0;
  let perRunNudged = false;
  const maxContinuations = options.maxContinuations ?? parseMaxContinuations(process.env[GOAL_MAX_CONTINUATIONS_ENV]);
  const maxTurnsPerRun = options.maxTurnsPerRun ?? parseMaxTurnsPerRun(process.env[GOAL_MAX_TURNS_PER_RUN_ENV]);
  const judge = options.judge;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? parseVerifyTimeoutMs(process.env[VERIFY_TIMEOUT_ENV]);
  const verifyRunner: VerifyRunner = options.verifyRunner ?? runVerify;

  const activateTool = () => {
    const active = pi.getActiveTools();
    if (!active.includes(GOAL_TOOL_NAME)) pi.setActiveTools([...active, GOAL_TOOL_NAME]);
  };

  // Reset the auto-continuation budget. Called only at genuine engagement
  // boundaries (resume, a gated completion, a user /goal kickoff) — never on the
  // model's set/blocked, which is how a stuck model would defeat the cap.
  const resetContinuationBudget = () => {
    continuations = 0;
    stopped = false;
  };

  const adoptBranchState = (ctx: ExtensionContext) => {
    const { goal: g, hiddenByCompaction } = scanGoalBranch(ctx.sessionManager.getBranch() as GoalBranchEntry[]);
    goal = g;
    if (g) goalSeq = g.id;
    compactedSinceUpdate = hiddenByCompaction;
    continuations = 0;
    // Re-arm the continuation loop for an active goal on resume; it never runs for
    // a finished or blocked one.
    stopped = !(g && g.status === "active");
    if (g && g.status !== "complete") activateTool();
  };

  const setGoal = (objective: string, criteria: string[], verify?: string): Goal => {
    goalSeq += 1;
    goal = { id: goalSeq, objective, criteria, status: "active", ...(verify ? { verify } : {}) };
    compactedSinceUpdate = false;
    // A model-set goal does NOT reset the continuation budget: re-setting the goal
    // must not farm fresh auto-continuations and defeat the cap. The budget
    // re-arms only at resume, a gated completion, or a user /goal kickoff.
    activateTool();
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

  // The continuation loop: on every settle, if the goal is still active and the
  // loop is armed and under the cap, re-engage the model with a followUp restating
  // the objective. This is what keeps the agent working turn after turn until the
  // goal is completed or blocked. At the cap we stop and tell the user, so a stuck
  // loop can't run away. (agent_settled fires only when the run is fully settled,
  // so a followUp here starts a fresh turn rather than colliding with one.)
  pi.on("agent_settled", (_event, ctx) => {
    if (!goal || goal.status !== "active" || stopped) return;
    if (continuations >= maxContinuations) {
      stopped = true;
      ctx.ui.notify(
        `Goal #${goal.id} still active after ${maxContinuations} auto-continuations — stopping. ` +
          "Complete it via the goal tool, adjust it, or stop it.",
      );
      return;
    }
    continuations += 1;
    pi.sendUserMessage(renderContinuationPrompt(goal, continuations, maxContinuations), { deliverAs: "followUp" });
  });

  // Per-run busy-loop bound: a stuck model can loop tool calls inside a single
  // run without ever settling, so the settle-cap never fires and the run burns
  // unbounded cost. Count turns per run; past the bound, steer the model to
  // settle once so the run is bounded and the settle-cap can re-engage.
  pi.on("agent_start", () => {
    perRunTurns = 0;
    perRunNudged = false;
  });
  pi.on("turn_end", () => {
    if (!goal || goal.status !== "active" || stopped) return;
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

  pi.registerTool({
    name: GOAL_TOOL_NAME,
    label: "Goal",
    description:
      'Track a single high-level objective that must be finished and verified. Use it to commit to a goal and to gate its completion: set a goal (optionally with checkable criteria and a `verify` command, e.g. `npm test`, that must exit 0 for the goal to count as done — the extension runs it, so it must genuinely pass, not just be claimed), then work toward it, then call it again with action "complete" and per-criterion evidence (evidence[i] proves criteria[i]) — a free-text \'done\' without proof is rejected, as is a summary that names a failure. Call it with action "blocked" only for a true impasse. Do not use it to organize steps (that is the todo tool) or for work that finishes in a couple of tool calls.',
    parameters: GoalParams,
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params) {
      if (params.action === "set") {
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
        // Independent verification: run the goal's verify command and require a zero
        // exit. The extension executes it (bounded) — the model cannot fake the result
        // — which is what makes completion consistent and truthful. A failure is
        // rejected with its output so the model fixes the real cause and retries.
        if (goal.verify) {
          const res = await verifyRunner(goal.verify, { timeoutMs: verifyTimeoutMs });
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
        const verdict = judge?.evaluate(goal, params.evidence, params.summary);
        if (verdict && !verdict.complete) {
          const judgeReason = `judge: ${verdict.reason ?? "insufficient evidence"}`;
          return finish(goal, `Goal #${goal.id} NOT completed: ${judgeReason}`, judgeReason);
        }
        goal = { ...goal, status: "complete" };
        // A completion does NOT re-arm the budget: the structural gate is
        // presence-only (no judge in v1), so a self-certifying model could
        // otherwise fake `complete` to farm fresh auto-continuations. The budget
        // re-arms only on resume or a user /goal kickoff, keeping the cap a true
        // per-session circuit breaker.
        return finish(goal, `Goal #${goal.id} complete: ${params.summary.trim()}`);
      }

      // params.action === "blocked"
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
    description: "Show the active goal, start one with /goal <objective>, or stop the loop with /goal stop",
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

      if (trimmed === "stop") {
        if (!goal || goal.status !== "active") {
          ctx.ui.notify("No active goal to stop.");
          return;
        }
        // Session-scoped kill switch: pause auto-continuation and mark the goal
        // not-pursuing (blocked). Not persisted to the branch — goal state stays
        // model-owned, so a reload re-adopts the last snapshot and can re-arm.
        stopped = true;
        goal = { ...goal, status: "blocked", blockedReason: "stopped by user" };
        ctx.ui.notify(`Goal #${goal.id} stopped (auto-continuation paused for this session).`);
        return;
      }

      // Start a goal by routing it through the model: the goal is created by the
      // goal tool (which persists a branch snapshot), so the branch stays the
      // single source of truth. State-changing verbs (pause/resume/clear) are
      // deliberately absent in v1 — goal state is owned by the model.
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
        `Set the goal "${trimmed}" using the goal tool (action "set"), then work toward it autonomously: keep making tool calls until every part is done and verified — do not stop or write a closing summary before then. When it is genuinely met, call the goal tool with action "complete" and per-criterion evidence that cites the real command and its output.`,
        { deliverAs: "followUp" },
      );
      ctx.ui.notify("Goal started; the agent will set it via the goal tool.");
    },
  });
}

export default registerGoalTool;
