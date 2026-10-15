/** The goal model and its durable representation: `goal.state` branch entries
 * (goal + loop latch + loop accounting), the scan that reconstructs them, and
 * the budget-window accounting rules. The single source of truth across
 * reload/rewind/resume; invisible to the model. */

import { scanCustomState } from "../../lib/branchstate";
import { MAX_VERIFY_OUTPUT, VERIFY_TRUNCATION_PREFIX, capVerifyOutput } from "./verify";

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

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface Goal {
  /** Monotonic id, rotated on every set so a stale completion can't hit a newer goal. */
  id: number;
  objective: string;
  /** Ordered success criteria; empty means the objective is the single criterion. */
  criteria: string[];
  status: GoalStatus;
  blockedReason?: string;
  /** The park decision packet, present exactly when the loop parked this
   * goal through a judge-mediated Stop (an accepted `blocked` request today;
   * premise/budget/work-appears-complete flavors arrive with the merged
   * judge). A plain status write never sets it — the packet is what an
   * out-of-band channel (pushover) needs: the case, the typed flavor, what a
   * resume requires, and the spend it cost to learn this. */
  park?: ParkPacket;
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

export type GoalParkFlavor = "impasse" | "premise" | "budget" | "work-appears-complete";
export type GoalResumeRequirement = "goal-change" | "spend" | "evidence";

const PARK_FLAVORS = ["impasse", "premise", "budget", "work-appears-complete"] as const;
const RESUME_REQUIREMENTS = ["goal-change", "spend", "evidence"] as const;

/** The decision packet a park emits (also rides the GoalParked event). Free
 * text is bounded at construction; these guards only check shape. */
export interface ParkPacket {
  flavor: GoalParkFlavor;
  /** The case, free text — the agent's claim or the judge's basis. */
  caseText: string;
  resumeRequires: GoalResumeRequirement;
  /** Cumulative spend at park time, ms. */
  spendMs: number;
  /** The second opinion was unavailable — the park rests on the request alone. */
  unverified?: boolean;
}

/** What un-parking requires, by flavor: an impasse needs new evidence of a
 * path, a contradicted premise needs a changed goal, an exhausted budget
 * needs more spend. (work-appears-complete does not park.) */
export function parkResumeRequires(flavor: GoalParkFlavor): GoalResumeRequirement {
  if (flavor === "premise") return "goal-change";
  if (flavor === "budget") return "spend";
  return "evidence";
}

/** Free-text cap for the packet's case: bounded at construction — the packet
 * persists, rides events, and reaches out-of-band channels; none of them
 * should inherit an unbounded model claim. */
export const MAX_PARK_CASE_CHARS = 1_000;

export function isParkPacket(p: unknown): p is ParkPacket {
  const packet = p as Partial<ParkPacket> | null;
  if (!packet || typeof packet !== "object") return false;
  return (
    typeof packet.flavor === "string" &&
    PARK_FLAVORS.includes(packet.flavor as (typeof PARK_FLAVORS)[number]) &&
    typeof packet.caseText === "string" &&
    packet.caseText.length > 0 &&
    typeof packet.resumeRequires === "string" &&
    RESUME_REQUIREMENTS.includes(packet.resumeRequires as (typeof RESUME_REQUIREMENTS)[number]) &&
    typeof packet.spendMs === "number" &&
    Number.isFinite(packet.spendMs) &&
    packet.spendMs >= 0 &&
    (packet.unverified === undefined || typeof packet.unverified === "boolean")
  );
}

/** Render data carried by goal tool results (durable state lives in goal.state
 * branch entries; this shape drives the result row). Running partials (onUpdate)
 * reuse the same shape so an in-flight check renders on the tool row. */
export interface GoalDetails {
  goal: Goal | null;
  error?: string;
  /** Present on onUpdate partials while a baseline/completion check runs. */
  running?: string;
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
  // Cap at record time with the SAME transform the persisted trajectory uses
  // (the verify cap): the live window and the restored one must stay
  // like-for-like, or a reload flips plateaus to "progressing" (or the
  // reverse) as a clipping artifact.
  outputs.push(capVerifyOutput(output));
  if (outputs.length > MAX_BUDGET_OUTPUTS) outputs.splice(1, 1);
  return outputs;
}

const GOAL_STATUSES = ["active", "paused", "blocked", "complete"] as const;

// ---------------------------------------------------------------------------
// Milestone judge — the settle-boundary check for goals without a verify
// ---------------------------------------------------------------------------

/** Shape guard shared by streamed arguments and replayed snapshots. */
export function isGoal(g: unknown): g is Goal {
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
    // park is optional (legacy goals predate it) but must be a valid packet
    // when present — a malformed one would lie to every resume path.
    (goal.park === undefined || isParkPacket(goal.park)) &&
    typeof goal.startedAt === "number" &&
    Number.isFinite(goal.startedAt)
  );
}

/** Loose entry shape so the scan accepts both SessionEntry[] and test doubles. */
export type GoalBranchEntry = {
  type?: string;
  customType?: unknown;
  data?: unknown;
  // Branches mix entry kinds (messages, compactions); the scan only reads the
  // fields above — `message` keeps foreign entries type-compatible in tests.
  message?: unknown;
};

/** customType of the durable goal-state entries (pi.appendEntry): the single
 * source of truth for goal state across reload/rewind/resume. Model tool calls
 * and user commands both append the full goal here; tool-result details are
 * render-only. Invisible to the LLM, rides the branch. */
export const GOAL_STATE_TYPE = "goal.state";

/** Data carried by goal.state entries. `stopped` is the session loop latch —
 * written explicitly when it must not be derived from the goal status (a
 * model `set` while the loop is stopped persists an ACTIVE goal + stopped:
 * true, the warp3090 trap shape). `loop` is the persisted loop accounting:
 * without it, every reload re-granted a fresh continuation budget — the F1
 * trap (a pause/resume or plain reload mid-run reset the counters silently). */
export interface GoalStateData {
  goal: Goal | null;
  stopped?: boolean;
  loop?: GoalLoopState;
}

/** Persisted loop accounting. Window counters (continuations, resetsUsed)
 * face the caps and re-arm only on deliberate user engagement; the budget
 * window's stable strings ride along as `trajectory` — the judge-side memory
 * that survives reloads and compactions. totalContinuations and spendMs are
 * lifetime and monotonic per session (they cross goals): the loud numbers a
 * resume must show before re-authorizing spend. goalSpendMs is the per-goal
 * view the ambient footer shows (a fresh goal must not inherit its
 * predecessor's hours); optional because early entries predate it — the
 * restore falls back to spendMs, exact for the single-goal sessions that
 * dominate. */
export interface GoalLoopState {
  continuations: number;
  resetsUsed: number;
  totalContinuations: number;
  spendMs: number;
  goalSpendMs?: number;
  /** Pivots consumed this goal (PI_GOAL_MAX_PIVOTS budget). Optional — legacy
   * entries predate it — but validated: a NaN here would arm a fresh pivot
   * every settle after reload. */
  pivotsUsed?: number;
  /** Continuations consumed since the trajectory baseline began — the
   * projection's rate denominator. The window counter (continuations) is
   * refreshed by pivots while the trajectory deliberately carries over, so
   * the span needs its own durable counter. */
  windowContinuations?: number;
  /** The work-appears-complete evidence re-engagement was used for this
   * goal — durable so a reload cannot mint a second one. */
  reengagedOnce?: boolean;
  trajectory: string[];
}

/** Trajectory tail kept per goal.state entry — enough for the progress
 * judge's first-vs-last diff to survive a reload, small enough that a
 * per-settle accounting write stays cheap. The entry cap IS the verify cap
 * (same constant, same tail-preserving formula): a smaller or differently-
 * shaped cap would let the live window and the persisted trajectory diverge,
 * flipping a plateau to "progressing" (or the reverse) as a clipping
 * artifact, and would cut the judge's resolution below what the verify path
 * itself delivers. */
export const MAX_PERSISTED_TRAJECTORY = 8;
export const MAX_PERSISTED_TRAJECTORY_CHARS = MAX_VERIFY_OUTPUT;

export function isGoalLoopState(l: unknown): l is GoalLoopState {
  const s = l as Partial<GoalLoopState> | null;
  if (!s || typeof s !== "object") return false;
  if (
    ![s.continuations, s.resetsUsed, s.totalContinuations, s.spendMs].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  )
    return false;
  // goalSpendMs is optional (legacy entries predate it) but not exempt: a
  // non-number would NaN-poison the next persist and silently flip the footer
  // to the lifetime clock.
  if (
    s.goalSpendMs !== undefined &&
    !(typeof s.goalSpendMs === "number" && Number.isFinite(s.goalSpendMs) && s.goalSpendMs >= 0)
  )
    return false;
  // pivotsUsed: same optionality, same reasoning (see the interface).
  if (
    s.pivotsUsed !== undefined &&
    !(typeof s.pivotsUsed === "number" && Number.isInteger(s.pivotsUsed) && s.pivotsUsed >= 0)
  )
    return false;
  if (
    s.windowContinuations !== undefined &&
    !(
      typeof s.windowContinuations === "number" &&
      Number.isInteger(s.windowContinuations) &&
      s.windowContinuations >= 0
    )
  )
    return false;
  if (s.reengagedOnce !== undefined && typeof s.reengagedOnce !== "boolean") return false;
  return (
    Array.isArray(s.trajectory) &&
    s.trajectory.length <= MAX_PERSISTED_TRAJECTORY &&
    // Element length too: restored windows feed the judge prompt, and session
    // files are editable — the read side must bound what the write side bounds
    // (a capped entry carries the truncation prefix beyond the raw cap).
    s.trajectory.every(
      (t) => typeof t === "string" && t.length <= MAX_PERSISTED_TRAJECTORY_CHARS + VERIFY_TRUNCATION_PREFIX.length,
    )
  );
}

function isGoalStateData(d: unknown): d is GoalStateData {
  const data = d as Partial<GoalStateData> | null;
  if (!data || typeof data !== "object") return false;
  if (data.goal !== null && !isGoal(data.goal)) return false;
  if (data.stopped !== undefined && typeof data.stopped !== "boolean") return false;
  // The loop field never vetoes the entry, in ANY shape (absent, legacy-valid,
  // null, corrupt): a rejected entry would silently discard its goal AND its
  // stop latch — the F1 failure mode, restyled. scanGoalState sanitizes the
  // accounting separately; here the goal and latch are all that matter.
  return true;
}

/** Derive the loop latch from a state entry: an explicit flag wins.
 * Without one, only a paused goal means "halted" — blocked/complete goals keep
 * the loop down through the status guards, so deriving a latch from them
 * would let a later model `set` inherit a permanent stop the user never made
 * (the derived value differed depending on whether a reload happened). */
function stoppedFromState(data: GoalStateData): boolean {
  if (typeof data.stopped === "boolean") return data.stopped;
  return data.goal?.status === "paused";
}

/** Reconstruct goal state from the session branch: the newest goal.state
 * entry is the state (every writer appends the full goal, so the last valid
 * entry alone suffices — no replay ordering). Also reports whether a
 * compaction that hides the goal follows the state entry with no in-context
 * carrier (reminder/check message) after it, which re-arms the reminder. */
export function scanGoalState(branch: GoalBranchEntry[]): {
  goal: Goal | null;
  sessionStopped: boolean | undefined;
  hiddenByCompaction: boolean;
  /** The newest entry carried a `loop` that failed validation: the entry
   * survives, but its accounting was dropped (the budget restarts at full). */
  loopDropped: boolean;
  loop: GoalLoopState | undefined;
} {
  const { data, index: lastIndex } = scanCustomState(branch, GOAL_STATE_TYPE, isGoalStateData);
  const goal = data?.goal ?? null;
  // Sanitize the accounting here (not in isGoalStateData, which must not veto
  // an entry over its loop): a malformed loop adopts as no accounting — the
  // budget degrades to a fresh window, but the goal and its latch survive.
  // Only an explicit latch from a real entry counts; undefined = derive from
  // the goal status (no state entry on this branch at all).
  const sessionStopped = data ? stoppedFromState(data) : undefined;
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
          typeof entry.customType === "string" &&
          (entry.customType === GOAL_REMINDER_TYPE || entry.customType === GOAL_CHECK_TYPE),
      );
  return {
    goal,
    sessionStopped,
    hiddenByCompaction,
    loop: data?.loop !== undefined && isGoalLoopState(data.loop) ? data.loop : undefined,
    // Present-but-invalid accounting: the entry survives (goal + latch are
    // load-bearing), but the consumer must be able to warn that the budget
    // silently restarted instead of reading the zeroed counters as "fresh".
    loopDropped: data?.loop !== undefined && !isGoalLoopState(data.loop),
  };
}

/** Newest goal recorded on the session branch, or null. */
export function lastGoalSnapshot(branch: GoalBranchEntry[]): Goal | null {
  return scanGoalState(branch).goal;
}
