/**
 * Goal extension — a single session-scoped objective with a verifiable
 * completion gate.
 *
 * Design (a deliberate cut of pi-goal, keeping the parent context small):
 * - one active goal per session, thread-owned (not a global per-directory
 *   goal). State — the goal plus the session loop latch — is persisted as
 *   `goal.state` custom entries via pi.appendEntry on every mutation (tool
 *   actions and user commands alike) and reconstructed on session_start /
 *   session_tree by scanning the branch: durable, invisible to the model, and
 *   correct across reload/rewind/resume. Tool-result `details` are render-only
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
 *   failed run is rejected with its output to fix the real cause. The set-time
 *   preflight and complete-time verify run inside the tool call, so they stream
 *   live progress onto the tool row (onUpdate partials — a multi-minute verify
 *   behind pi's generic working spinner reads as wedged) and honor the run's
 *   abort signal: Esc kills the verify's whole process tree and unblocks the
 *   call instead of forcing a pi restart. The settle-boundary check gets no
 *   signal from pi (agent.signal is cleared before the boundary fires, and
 *   session.abort() then blocks until the handler returns — and a bare Esc
 *   is pi's own interrupt at this boundary, plus popup-dismiss noise), so
 *   the kill is a dedicated chord instead: alt+x, bound by nothing in pi's
 *   defaults and never an editing gesture, observed on raw terminal input
 *   for the check's duration. A kill re-engages with a notice rather than
 *   parking the turn; a pi-side abort drops the queued continuation anyway;
 *   and the administrative drains (/goal pause, /goal stop, session_shutdown)
 *   stay silent — no extra turn after a halt.
 *   A semantic
 *   second opinion (a Jev-style classifier) is a later pass behind the
 *   injectable GoalJudge seam; v1 ships no completion judge (fail-open floor
 *   — the milestone judge below judges progress, not completion)
 * - an agent_before_settle continuation loop drives the goal turn by turn:
 *   when the goal carries a `verify` command, the settle triage
 *   (PI_GOAL_TRIAGE, default on) runs FIRST — a cheap tool-less child judge
 *   over the work digest decides whether the agent claims done; mid-work →
 *   continue without measuring (the script can run minutes and hold locks
 *   the agent's own background work needs), claims-done/doubt/error → run the
 *   script (fail-open: a broken triage degrades to always-measuring, never to
 *   a skipped gate). Unmeasured turns add no evidence to the progress window,
 *   so a measurement-starved run trips the continuation cap. At each measured
 *   settle, if the goal is active, the extension runs it (bounded), reads the
 *   measured state, and queues a
 *   follow-up (display:true with a compact registered message renderer, so the
 *   user sees a one-line "goal check N/M · verify failed — continuing" heartbeat
 *   instead of an invisible hand-off) — "close these measured gaps" when the
 *   check fails, "the check passed, summarize and call complete" when it
 *   passes. The check is graded, not boolean: it prints the measured state
 *   (coverage %, test summary) and exits 0 only when the objective is met, so
 *   the agent measures, narrates the gap, and works until it closes. Superbash
 *   background tasks still running get a judge's call, not a blanket skip:
 *   the turn may be only temporarily done (each completion wake re-engages
 *   the agent as a fresh run), so measuring now could read a half-finished
 *   state or block on a lock the running work holds — but a never-ending
 *   task (a dev server) never wakes, and a blanket defer would park the
 *   loop until the next user prompt. So the settle triage / milestone judge
 *   also receives the live task list and answers "hold" (defer to the first
 *   calm settle — the pre-judge behavior: no budget burned, nothing cached,
 *   announced once per park) or lets the check proceed while the tasks run.
 *   A hold at the continuation cap defers the breaker to a calm settle; a
 *   proceed meets it like any calm settle would.
 *   A verify goal without the triage (PI_GOAL_TRIAGE=0), and a triage that
 *   errors or returns no opinion while tasks run, keep the unconditional
 *   deferral; a milestone judge failure still fails open (its contract). A
 *   task killed while idle gets no wake — the park notice names the recovery:
 *   kill the task, and the next prompt's calm settle runs the check. While the
 *   verify runs, an animated chat-area spinner widget shows the check in flight
 *   (pi clears its own working spinner at agent_end, so the settle boundary
 *   would otherwise render as a dead pause), and an expensive verify can be
 *   throttled via PI_GOAL_CHECK_EVERY (every Nth continuation; the in-between
 *   turns reuse the last measured state, marked stale in the prompt — keep
 *   checkEvery ≤ maxContinuations − 1 so each judge window still holds ≥ 2
 *   fresh outputs). A footer status (elapsed time) keeps the goal in view the
 *   whole time. A goal without a verify is milestone-driven instead of
 *   script-driven: the SettleJudge seam — by default a tool-less child model
 *   (runChild, bounded + abortable like the verify) — reads the goal plus a
 *   capped digest of the agent's recent work at each turn end and answers
 *   working | complete | blocked; the loop re-engages on all three (complete
 *   steers "summarize + call complete", blocked steers "confirm the impasse
 *   or refute it"), and a missing or throwing judge fails OPEN to a generic
 *   continuation — the cap stays the breaker, because a silently parked
 *   milestone goal was the observed production failure. With no judge
 *   configured (PI_GOAL_JUDGE=0) the goal is user-driven and both the set
 *   result and adoption say so loudly. Two
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
 *   completion); the budget re-arms only when the user resumes or starts a
 *   goal via /goal — and the full loop accounting (window counters, lifetime
 *   continuations, pursuit spend, the judge's trajectory tail) persists in
 *   goal.state and is RESTORED on reload/rewind, so a reload mid-budget no
 *   longer re-grants it silently (the warp3090 F1 trap); /goal resume
 *   re-authorizes loudly, showing the lifetime numbers first, and /goal stop
 *   halts the loop (persisted — a reload cannot resurrect a stopped goal)
 * - a before_agent_start reminder re-injects the objective + criteria when a
 *   compaction hid it (summaries never carry the goal); a compaction mid-turn
 *   additionally re-injects immediately by steering the in-progress run (no new
 *   turn), since before_agent_start won't re-fire until the next user prompt
 * - /goal is a view + kickoff: it shows the goal, starts one by routing the
 *   objective through the model (the goal tool creates and persists it), or
 *   halts the loop with /goal stop / pause. State — goal plus loop latch —
 *   lives in goal.state branch entries (pi.appendEntry, shared pattern from
 *   lib/branchstate.ts), written by tool actions and user commands alike: the
 *   single source of truth across reload/rewind/resume, invisible to the model
 */

/**
 * Module map (pure layers below the wiring; this file owns registration,
 * the /goal command, and the settle state machine):
 * - config.ts   env knobs, parsed by small pure helpers (fail-open defaults)
 * - format.ts   clip + formatElapsed
 * - input.ts    raw terminal input (the alt+x kill key)
 * - verify.ts   the verify boundary: bounded command execution + capping
 * - state.ts    the goal model, goal.state persistence, loop accounting
 * - completion.ts  the structural completion gate + tool-param validation
 * - judge.ts    the child judges: settle, triage, progress (cap) — verdicts only
 * - prompts.ts  the loop's messages to the main agent
 * - render.ts   what the user sees: footer, spinner, transcript rows, /goal view
 */

import { matchesKey, Text } from "@earendil-works/pi-tui";
import { getSharedTaskRegistry, type BgTask } from "../../lib/superbash";
import { emitGoalCompleted } from "../../lib/goal-events";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  GOAL_CHECK_EVERY_ENV,
  GOAL_MAX_CONTINUATIONS_ENV,
  GOAL_MAX_PROGRESS_RESETS_ENV,
  GOAL_MAX_TURNS_PER_RUN_ENV,
  GOAL_MAX_PIVOTS_ENV,
  GOAL_TOOL_NAME,
  VERIFY_TIMEOUT_ENV,
  parseCheckEvery,
  parseMaxContinuations,
  parseMaxProgressResets,
  parseMaxTurnsPerRun,
  parseMaxPivots,
  parseVerifyTimeoutMs,
} from "./config";
import type { VerifyResult, VerifyRunner } from "./verify";
import { capVerifyOutput, liveCheckAborts, runVerify } from "./verify";
import { GOAL_KILL_KEY, listenForTerminalInput } from "./input";
import type { Goal, GoalBranchEntry, GoalDetails, GoalLoopState, ParkPacket } from "./state";
import {
  GOAL_CHECK_TYPE,
  GOAL_PAUSED_STEER_TYPE,
  GOAL_REMINDER_TYPE,
  GOAL_STATE_TYPE,
  MAX_PERSISTED_TRAJECTORY,
  recordBudgetOutput,
  scanGoalState,
} from "./state";
import type { GoalJudge } from "./completion";
import {
  GoalParams,
  checkCompletion,
  effectiveCriteria,
  validateCriteria,
  validateObjective,
  validateVerify,
} from "./completion";
import type {
  ImpasseVerdict,
  JudgeChildRunner,
  MilestoneKind,
  ProgressJudge,
  ProgressVerdict,
  SettleJudge,
  SettleTriage,
  SettleVerdict,
  TriageVerdict,
} from "./judge";
import {
  GOAL_JUDGE_ENV,
  GOAL_JUDGE_MODEL_ENV,
  GOAL_JUDGE_TIMEOUT_ENV,
  GOAL_TRIAGE_ENV,
  GOAL_TRIAGE_TIMEOUT_ENV,
  buildWorkDigest,
  createLlmSettleJudge,
  createLlmSettleTriage,
  defaultProgressJudge,
  describeBgTasks,
  milestoneKind,
  parseJudgeEnabled,
  parseJudgeModel,
  parseJudgeTimeoutMs,
  parseTriageTimeoutMs,
} from "./judge";
import {
  renderCheckPrompt,
  renderGoalReminder,
  renderMilestonePrompt,
  renderReframePrompt,
  renderTriagePrompt,
} from "./prompts";
import { parkResumeRequires, MAX_PARK_CASE_CHARS } from "./state";
import { emitGoalParked } from "../../lib/goal-events";
import type { GoalCheckDetails } from "./render";
import {
  CheckSpinnerComponent,
  GOAL_CHECK_WIDGET_KEY,
  GoalStatusComponent,
  renderCheckMessage,
  renderGoalCall,
  renderGoalFooter,
  renderGoalResult,
  reuseText,
} from "./render";
import { clip, formatElapsed } from "./format";

export * from "./config";
export * from "./projection";
export * from "./format";
export * from "./verify";
export * from "./input";
export * from "./state";
export * from "./completion";
export * from "./judge";
export * from "./prompts";
export * from "./render";

export interface RegisterGoalOptions {
  /** Optional semantic judge (Jev-style). v1 leaves this unset; the structural gate is the floor. */
  judge?: GoalJudge;
  /** Optional progress judge consulted at the continuation cap. Defaults to the
   *  deterministic defaultProgressJudge (verify output changed ⇒ progressing).
   *  CONTRACT: the live window holds up to MAX_BUDGET_OUTPUTS (32) entries,
   *  but a RELOADED window restores only the persisted tail (baseline + last
   *  MAX_PERSISTED_TRAJECTORY−1 = 7). Judges must treat anything beyond
   *  first-vs-last as advisory — deciding on the middle of the window makes
   *  the cap verdict reload-dependent. */
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
  /** Cap on system-granted pivots per goal (the procedural reframe). Defaults
   *  to PI_GOAL_MAX_PIVOTS, then 1; 0 disables pivots entirely. */
  maxPivots?: number;
  /** Verifier run on `complete` (and prefetched on `set`). Inject a fake in tests. */
  verifyRunner?: VerifyRunner;
  /** Settle judge for verify-less (milestone) goals: decides
   * working | complete | blocked at each turn end. Defaults to the LLM
   * milestone judge (one bounded child model call) while PI_GOAL_JUDGE is on
   * (its default); PI_GOAL_JUDGE=0 leaves verify-less goals user-driven. */
  settleJudge?: SettleJudge;
  /** Settle triage for verify goals (judge-first: skip the script while the
   *  agent is visibly mid-work, run it when it claims done). Inject a fake in
   *  tests; `null` disables even when PI_GOAL_TRIAGE is set. Defaults to the
   *  LLM triage when PI_GOAL_TRIAGE is enabled. */
  triage?: SettleTriage | null;
  /** Child-runner boundary for the default triage; injectable for tests. */
  triageRunChildFn?: JudgeChildRunner;
  /** Pinned model for the default judge (PI_GOAL_JUDGE_MODEL); unset inherits
   *  the session model per call, like a subagent child. */
  judgeModel?: string;
  /** Timeout (ms) for one default-judge child run
   *  (PI_GOAL_JUDGE_TIMEOUT_MS). */
  judgeTimeoutMs?: number;
  /** Child-runner boundary for the default judge — inject a fake in tests so
   *  the registration-path wiring (model inheritance, signal, timeout) is
   *  assertable without spawning pi. */
  judgeRunChildFn?: JudgeChildRunner;
  /** Live background tasks at settle time; while any run, the settle's
   *  judge (triage / milestone judge) decides hold-vs-proceed — without one
   *  in the loop, the check defers unconditionally. Defaults to the shared
   *  superbash registry — absent registry means no background work
   *  (fail-open: the loop must not stall on a missing writer). Inject a fake
   *  in tests. */
  runningTasks?: () => BgTask[];
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
  // Session branch accessor captured from event contexts (the tool's execute
  // has no ctx): at worst it is the outgoing session's branch — the digest it
  // feeds is advisory judge input, and the replacement session's own events
  // re-capture it.
  let branchRef: { getBranch(): unknown[] } | undefined;
  const maxContinuations = options.maxContinuations ?? parseMaxContinuations(process.env[GOAL_MAX_CONTINUATIONS_ENV]);
  const maxTurnsPerRun = options.maxTurnsPerRun ?? parseMaxTurnsPerRun(process.env[GOAL_MAX_TURNS_PER_RUN_ENV]);
  const maxPivots = options.maxPivots ?? parseMaxPivots(process.env[GOAL_MAX_PIVOTS_ENV]);
  const maxProgressResets =
    options.maxProgressResets ?? parseMaxProgressResets(process.env[GOAL_MAX_PROGRESS_RESETS_ENV]);
  const progressJudge: ProgressJudge = options.progressJudge ?? { assess: defaultProgressJudge };
  const judge = options.judge;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? parseVerifyTimeoutMs(process.env[VERIFY_TIMEOUT_ENV]);
  const verifyRunner: VerifyRunner = options.verifyRunner ?? runVerify;
  const judgeModel = options.judgeModel ?? parseJudgeModel(process.env[GOAL_JUDGE_MODEL_ENV]);
  const judgeTimeoutMs = options.judgeTimeoutMs ?? parseJudgeTimeoutMs(process.env[GOAL_JUDGE_TIMEOUT_ENV]);
  // Live session model for the default judge's child (inheritance per call);
  // captured from event contexts alongside uiRef.
  let sessionModelRef: ExtensionContext["model"] = undefined;
  const settleJudge: SettleJudge | undefined =
    options.settleJudge ??
    (parseJudgeEnabled(process.env[GOAL_JUDGE_ENV])
      ? createLlmSettleJudge({
          ...(judgeModel ? { model: judgeModel } : {}),
          timeoutMs: judgeTimeoutMs,
          sessionModel: () => sessionModelRef,
          ...(options.judgeRunChildFn ? { runChildFn: options.judgeRunChildFn } : {}),
        })
      : undefined);
  // The settle triage for verify goals (PI_GOAL_TRIAGE): opt-in like the
  // judge — every LLM call at the settle boundary is deliberate configuration.
  const triage: SettleTriage | undefined =
    options.triage === null
      ? undefined
      : (options.triage ??
        (parseJudgeEnabled(process.env[GOAL_TRIAGE_ENV])
          ? createLlmSettleTriage({
              ...(judgeModel ? { model: judgeModel } : {}),
              timeoutMs: parseTriageTimeoutMs(process.env[GOAL_TRIAGE_TIMEOUT_ENV]),
              sessionModel: () => sessionModelRef,
              ...(options.triageRunChildFn ? { runChildFn: options.triageRunChildFn } : {}),
            })
          : undefined));
  // Read per event, not captured at registration: a /reload rebuilds the
  // superbash registry, and a registration-time capture would keep deferring
  // on a dead registry (or miss the fresh one) after every reload.
  const runningTasks: () => BgTask[] = options.runningTasks ?? (() => getSharedTaskRegistry()?.running() ?? []);
  // Verify outputs observed during the current budget window (oldest first) —
  // the evidence the progress judge reads at the cap. Cleared with the budget.
  let budgetOutputs: string[] = [];
  let resetsUsed = 0;
  // Pivots consumed this goal (PI_GOAL_MAX_PIVOTS). A pivot refreshes ONLY
  // the continuation window — never spend, never met criteria, never the
  // trajectory baseline: the new epoch is judged against the same gap.
  let pivotsUsed = 0;
  // Lifetime accounting (per session, crosses goals): every auto-continuation
  // ever granted, and wall-clock pursuit time. Monotonic — never reset by the
  // budget re-arm — so a loud resume can say what the goal has truly consumed.
  let totalContinuations = 0;
  let spendMs = 0;
  // Per-goal pursuit clock feeding the footer: a NEW goal must not inherit
  // its predecessor's hours. Lifetime spendMs stays untouched for the loud
  // resume/restore lines; this one resets in setGoal.
  let goalSpendMs = 0;
  // Dedup memo for persistGoalState — the last appended goal.state payload.
  let lastPersistedJson: string | undefined;
  // Ticking pursuit clock: set only while the loop is actually armed (active
  // goal, latch up). Paused conversations and halted loops accrue nothing.
  let armedAt: number | undefined;
  const checkEvery = options.checkEvery ?? parseCheckEvery(process.env[GOAL_CHECK_EVERY_ENV]);
  // Last verify result + how many continuations ago it ran. With checkEvery > 1
  // most turns reuse it instead of re-running an expensive verify. The same
  // cache carries milestone-judge assessments (ok = verdict complete, output =
  // the reason), so throttling and staleness marking work identically.
  let lastCheck: VerifyResult | undefined;
  let lastCheckAge = 0;
  // Judge-path companions to lastCheck: the verdict label and remaining work
  // (for prompt wording), and the last reason (fed back as previousReason so
  // the next assessment can tell movement from repetition).
  let lastCheckKind: MilestoneKind | undefined;
  let lastJudgeRemaining: string[] = [];
  let lastJudgeReason: string | undefined;
  // True while the loop is parked on background tasks; re-announced only
  // after a check runs in between (the notify fires once per park).
  let parkedForTasks = false;
  // Set by session_shutdown: the in-flight settle (if any) must resolve
  // without queueing anything — its continuation would outlive the teardown.
  let shuttingDown = false;

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
  const updateFooter = (checking?: string) => {
    if (goal && goal.status === "active") {
      uiRef?.setStatus(
        "goal",
        checking
          ? `goal · checking (${clip(checking, 30)})`
          : stopped
            ? // An active-but-latched goal must not look like live work: the
              // ticking clock read as pursuit during the warp3090 incident.
              "goal · halted — /goal resume re-arms"
            : renderGoalFooter(accruedGoalSpendMs()),
      );
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
    lastCheckKind = undefined;
    lastJudgeRemaining = [];
    lastJudgeReason = undefined;
    parkedForTasks = false; // a re-armed loop re-announces its next park
    // Lifetime counters (totalContinuations, spendMs) deliberately survive the
    // re-arm: the window is what the user re-authorizes, not the history.
  };

  const pursuitArmed = () => !!goal && goal.status === "active" && !stopped;
  const accruedSpendMs = () => spendMs + (armedAt !== undefined ? Date.now() - armedAt : 0);
  const accruedGoalSpendMs = () => goalSpendMs + (armedAt !== undefined ? Date.now() - armedAt : 0);
  // Fold the ticking clock into the durable total at every persist — keeps
  // ticking while armed, stops (and clears) when pursuit is down. Centralizing
  // it here means no state-change site can forget the clock.
  const foldSpend = () => {
    if (armedAt !== undefined) {
      // Math.max: wall clocks are not monotonic (NTP, VM adjustments) — a
      // backwards step must never drive the total negative, where it would
      // poison the persisted accounting.
      const delta = Math.max(0, Date.now() - armedAt);
      spendMs += delta;
      goalSpendMs += delta;
      armedAt = pursuitArmed() ? Date.now() : undefined;
    } else if (pursuitArmed()) {
      armedAt = Date.now();
    }
  };
  const currentLoopState = (): GoalLoopState => {
    // The budget window's FIRST entry is its baseline — recordBudgetOutput
    // never evicts index 0, because the progress judge diffs first-vs-last.
    // Persist [baseline + tail] so a restored window keeps that comparison;
    // a tail-only slice would quietly change the cap decision across a reload.
    const rest = budgetOutputs.slice(1).map((t) => capVerifyOutput(t));
    return {
      continuations,
      resetsUsed,
      pivotsUsed,
      totalContinuations,
      spendMs: Math.max(0, accruedSpendMs()),
      goalSpendMs: Math.max(0, accruedGoalSpendMs()),
      trajectory:
        budgetOutputs.length === 0
          ? []
          : [capVerifyOutput(budgetOutputs[0]), ...rest.slice(-(MAX_PERSISTED_TRAJECTORY - 1))],
    };
  };

  const adoptBranchState = (ctx: ExtensionContext) => {
    if (ctx.ui) uiRef = ctx.ui;
    sessionModelRef = ctx.model;
    if (ctx.sessionManager) branchRef = ctx.sessionManager;
    const {
      goal: g,
      sessionStopped,
      hiddenByCompaction,
      loop,
      loopDropped,
    } = scanGoalState(ctx.sessionManager.getBranch() as GoalBranchEntry[]);
    goal = g;
    if (g) goalSeq = g.id;
    // The dedup memo is per-branch: an adoption may have rewound to a branch
    // whose newest entry differs from our last in-process write — a stale
    // memo could then suppress a required durable write (rewind + resume
    // reproducing a byte-identical payload while the branch still records
    // the old latch).
    lastPersistedJson = undefined;
    compactedSinceUpdate = hiddenByCompaction;
    // Restore the loop accounting, don't re-grant it: the budget window,
    // lifetime totals, and the judge's trajectory tail live in goal.state, so
    // a reload mid-budget resumes where it left off (F1: the silent zeroing
    // here was the budget reset the warp3090 run walked through). Measured
    // state is still re-established by the next check — only the accounting
    // and the evidence window carry over.
    continuations = loop?.continuations ?? 0;
    resetsUsed = loop?.resetsUsed ?? 0;
    pivotsUsed = loop?.pivotsUsed ?? 0;
    totalContinuations = loop?.totalContinuations ?? 0;
    spendMs = loop?.spendMs ?? 0;
    // Legacy entries predate the per-goal clock — the lifetime spend is the
    // exact value for the single-goal sessions that dominate, and the best
    // available estimate otherwise.
    goalSpendMs = loop?.goalSpendMs ?? loop?.spendMs ?? 0;
    budgetOutputs = loop ? [...loop.trajectory] : [];
    lastCheck = undefined;
    lastCheckAge = 0;
    lastCheckKind = undefined;
    lastJudgeRemaining = [];
    lastJudgeReason = undefined;
    parkedForTasks = false; // branch adoption re-announces a park
    shuttingDown = false; // a new session in this process re-arms everything —
    // the latch must apply only to the in-flight settle of the teardown itself
    // (extension closures survive session replacement: new/resume/fork)
    // Re-arm the continuation loop unless the persisted latch says otherwise
    // (stop/pause, or a model set while stopped). Terminal goals keep the loop
    // down through the status guards; only an explicit flag (or a legacy
    // paused entry) yields a latch. A branch with NO goal stays armed —
    // disarming there would kill the loop for a goal the model sets later in
    // the same session, since a model set never re-arms.
    stopped = sessionStopped ?? false;
    // The pursuit clock starts iff the adopted branch is live; a re-adopted
    // mid-budget goal resumes accruing from now (its prior spend arrived via
    // the restored accounting, not the clock).
    armedAt = pursuitArmed() ? Date.now() : undefined;
    if (g && g.status !== "complete") activateTool();
    // Adoption loudness for the verify-less trap: an active, un-stopped goal
    // with neither a verify nor a judge ticks the footer from behind a dead
    // loop — no settle event will ever say so (the no-verify guard returns
    // silently), so the reload/resume that re-adopts it must.
    if (g && g.status === "active" && !g.verify && !settleJudge && !stopped) {
      ctx.ui?.notify(
        `Goal #${g.id} has no verify command and no milestone judge — no auto-check loop; it advances only on your prompts.`,
      );
    }
    // Loud restore: a mid-budget reload must not read as a fresh start. One
    // line, only when there is consumed budget to report — the first session_start
    // of a fresh goal stays quiet.
    if (g && g.status === "active" && !stopped && (continuations > 0 || spendMs > 0)) {
      ctx.ui?.notify(
        `Goal #${g.id} loop restored mid-budget: ${continuations}/${maxContinuations} continuations used ` +
          `(${totalContinuations} lifetime, ${formatElapsed(spendMs)} of pursuit).`,
      );
    }
    // A present-but-unreadable accounting is the F1 shape wearing a new mask:
    // the entry (and its latch) survived, but the budget restarted at full —
    // that re-grant must be said out loud, not inferred from zeroed counters.
    if (g && g.status === "active" && !stopped && loopDropped) {
      ctx.ui?.notify(`Goal #${g.id} accounting unreadable — continuation budget restarted at ${maxContinuations}.`);
    }
    updateFooter();
  };

  // Persist goal + loop latch AND the loop accounting to the branch:
  // goal.state entries are the single source of truth across
  // reload/rewind/resume. An explicit stopped flag is required exactly when
  // memory and goal status disagree (a model set while the loop is stopped
  // persists an ACTIVE goal that must stay latched). foldSpend keeps the
  // pursuit clock honest at every durable write — no site can forget it.
  const persistGoalState = (stoppedFlag?: boolean) => {
    foldSpend();
    const payload = {
      goal: goal ? { ...goal } : null,
      ...(stoppedFlag !== undefined ? { stopped: stoppedFlag } : {}),
      loop: currentLoopState(),
    };
    // Byte-identical writes are skipped (e.g. a shutdown persist immediately
    // after a settle persist with no elapsed pursuit): duplicate entries buy
    // nothing — the scan takes the newest — and each carries the full
    // trajectory tail. Non-identical per-settle redundancy is accepted:
    // newest-entry-wins keeps restore O(1); a merge-on-read dedup would trade
    // that for complexity the two budget bounds already cap.
    const serialized = JSON.stringify(payload);
    if (serialized === lastPersistedJson) return;
    lastPersistedJson = serialized;
    pi.appendEntry(GOAL_STATE_TYPE, payload);
  };

  const setGoal = (objective: string, criteria: string[], verify?: string): Goal => {
    goalSeq += 1;
    goal = { id: goalSeq, objective, criteria, status: "active", startedAt: Date.now(), ...(verify ? { verify } : {}) };
    compactedSinceUpdate = false;
    // The per-goal pursuit clock starts at zero with the goal — the footer
    // must answer "how long has THIS goal run", while the lifetime spend
    // (for loud resumes) crosses goals untouched. Bank the predecessor's
    // running tick first, else it lands in the new goal's first entry.
    foldSpend();
    goalSpendMs = 0;
    // A pivot budget is per goal too: a fresh objective must not inherit the
    // predecessor's consumed pivots — the bet was on THAT goal's non-linearity.
    pivotsUsed = 0;
    // Scope the judge's evidence to THIS goal: a window mixing goal A's outputs
    // with goal B's would let a re-set with any differently-printing verify buy
    // a "progressing" reset without moving the current goal. Clearing only the
    // evidence (not continuations/resetsUsed) is strictly tightening — a fresh
    // window with <2 outputs fails closed to the stop.
    budgetOutputs = [];
    lastCheck = undefined; // a new verify command invalidates the cached state
    lastCheckAge = 0;
    lastCheckKind = undefined;
    lastJudgeRemaining = [];
    lastJudgeReason = undefined;
    parkedForTasks = false; // a new goal re-announces its park
    // A model-set goal does NOT reset the continuation budget: re-setting the goal
    // must not farm fresh auto-continuations and defeat the cap. The budget
    // re-arms only at resume, a gated completion, or a user /goal kickoff.
    activateTool();
    updateFooter();
    return goal;
  };

  // Nothing outlives the session: a live verify is aborted on shutdown/reload
  // — its timeout timer dies with the host process, so without this a reload
  // mid-check would orphan the whole tree.
  pi.on("session_shutdown", () => {
    // A shutdown drain (reload, quit, session replacement) must not just kill
    // the verify — a re-engage notice queued here would outlive the teardown
    // (reload does not run session.abort(), so pi would honor the continue).
    shuttingDown = true;
    for (const abort of [...liveCheckAborts]) abort();
    // Fold the pursuit clock before teardown: without this, everything since
    // the last persist (up to a whole turn) is lost from the lifetime spend.
    // The explicit latch mirrors the set-site pattern — an unflagged persist
    // of an active-but-latched goal would derive `stopped: false` on reload.
    if (goal && goal.status === "active") persistGoalState(stopped ? true : undefined);
  });

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
    sessionModelRef = ctx.model;
    // Only re-engage after a clean completion — not after an errored or aborted
    // run, where re-engaging would just re-run the failure.
    if (event.outcome === "error" || event.outcome === "aborted") return;
    if (!goal || goal.status !== "active" || stopped) return;
    // Milestone path: a goal with no verify command is judge-driven — the
    // judge re-engages the agent on its verdict instead of a script's exit
    // code. Without a judge there is no loop at all (user-driven); the set
    // result and branch adoption both said so loudly when this goal was created.
    const judged = !goal.verify;
    if (judged && !settleJudge) return;
    // Background tasks in flight (superbash bash/subagent adoption): the
    // turn may be only temporarily done — every completion wake re-engages
    // the agent as a fresh run — so a check now could measure a half-finished
    // state (or block for hours on a lock the running work holds, e.g. a gate
    // script). But a blanket defer parks forever on never-ending tasks (a
    // dev server never wakes — the observed production failure), so the
    // judge owns the call whenever one is in the loop: the settle triage
    // (verify goals) / milestone judge receives the live task list and
    // answers "hold" — defer to the first calm settle, exactly the
    // pre-judge behavior — or lets the check proceed while the tasks run.
    // A verify goal without the triage (PI_GOAL_TRIAGE=0), and a triage
    // that errors or returns no opinion while tasks run, keep the
    // unconditional deferral; a milestone judge failure still fails open to
    // the continuation (its established contract). No registry wired (goal
    // registered standalone) reads as zero tasks — fail-open.
    const running = runningTasks();
    const holding = running.length > 0;
    const activeGoal = goal; // narrowed for the closures — `goal`'s narrowing doesn't cross them
    const park = (): undefined => {
      uiRef?.setStatus(
        "goal",
        `goal · holding check — ${running.length} background task${running.length === 1 ? "" : "s"} running`,
      );
      // Announce the park once per park (not per settle): the footer alone
      // reads as "a check is in flight", and the cases where no wake will
      // ever re-engage the loop — a task killed while idle (killed tasks
      // never wake) and a never-ending task the judge keeps holding for —
      // would otherwise park silently until the next user prompt.
      if (!parkedForTasks) {
        parkedForTasks = true;
        ctx.ui?.notify(
          `Goal #${activeGoal.id} check held while ${running.length} background task${running.length === 1 ? "" : "s"} run — ` +
            "it runs when they finish. If one never finishes, kill it (/tasks or task_kill): " +
            "the check then runs on your next prompt.",
        );
      }
      return undefined;
    };
    // The continuation-cap gate: true when the loop must halt (the notify and
    // footer already said so). On a calm settle it runs before any judge call
    // (a stop must not spend a triage/judge pass) — its old position. On a
    // holding settle it must wait for the hold decision: parking at the cap
    // is the pre-judge invariant ("the cap decision belongs to a calm
    // settle" — the breaker must not read a parked run as a plateau), so it
    // is re-invoked after the triage/judge declines to hold and gates every
    // budget-burning action from there down.
    const applyCap = async (): Promise<boolean> => {
      if (continuations < maxContinuations) return false;
      // At the cap, a progress judge decides: still moving → reset the budget
      // and continue (itself capped, so the judge can't defeat the breaker);
      // plateaued or no opinion → stop. Fail-closed on ambiguity.
      let verdict: ProgressVerdict | undefined;
      try {
        // Awaited so an async (LLM) judge needs no adapter; its rejection lands
        // in this catch and fails closed.
        verdict = await progressJudge.assess(activeGoal, budgetOutputs);
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
          `Goal #${activeGoal.id} hit the continuation cap but is still progressing (${verdict.reason ?? "judge approved"}) — ` +
            `resetting the budget (reset ${resetsUsed}/${maxProgressResets}).`,
        );
        return false;
      }
      stopped = true;
      // Persist the latch: without this, a reload after the cap resurrects the
      // loop (the derived latch reads the last pre-cap entry). The restored
      // accounting would re-trip the cap at the next settle anyway — persisting
      // makes the halt immediate and durable instead of eventual.
      persistGoalState(true);
      const why = verdict?.continueRun
        ? `progress-judge resets exhausted (${resetsUsed}/${maxProgressResets})`
        : verdict
          ? (verdict.reason ?? "no progress signal")
          : "progress judge unavailable — failing closed";
      ctx.ui?.notify(
        `Goal #${activeGoal.id} still active after ${maxContinuations} auto-continuations — stopping (${why}). ` +
          "Complete it via the goal tool, adjust it, or /goal stop.",
      );
      updateFooter();
      return true;
    };
    if (holding && !judged && !triage) return park();
    if (!holding) {
      parkedForTasks = false;
      if (await applyCap()) return;
    }
    let check: VerifyResult;
    // Throttle: with checkEvery > 1 only every Nth continuation re-runs the
    // check (verify or judge); the others reuse the last measured state
    // (aged) so the settle is instant instead of a silent multi-minute
    // benchmark. (`due` reads the would-be post-increment counter; the
    // increment happens once the check survives the abort path below, so an
    // aborted check never burns budget.) A holding settle is always due:
    // the judge owns the park decision there, and a throttled turn would
    // otherwise re-engage on the stale check without asking whether the
    // agent is just waiting on the running tasks — the park the hold
    // verdict exists for. The triage still gates the expensive part.
    const due = holding || (continuations + 1) % checkEvery === 0 || !lastCheck;
    const verifyCommand = goal.verify; // captured for the closure: narrowing of `goal` doesn't cross it
    if (due) {
      // Settle triage for verify goals (PI_GOAL_TRIAGE / options.triage): a
      // judge-first gate. The verify can run minutes and hold locks the
      // agent's own background work needs; when the digest shows the agent
      // mid-work, the loop continues without measuring, and the script runs
      // only when the agent claims done. No opinion or error fails OPEN to
      // measuring — a broken triage degrades to the old behavior, never to a
      // gate that silently stops verifying — except while background tasks
      // run, where it defers instead: measuring against work still in flight
      // is what the deferral exists to avoid, and a broken judge degrades to
      // the pre-judge deferral rather than bypassing it.
      if (!judged && triage) {
        uiRef?.setWidget(
          GOAL_CHECK_WIDGET_KEY,
          (tui: { requestRender(): void }, theme: Pick<Theme, "fg">) =>
            new CheckSpinnerComponent(
              tui,
              theme,
              "triaging settle: measuring only if the agent claims done · alt+x aborts",
            ),
        );
        const tKill = new AbortController();
        const tDetach = listenForTerminalInput(uiRef, (data) => {
          if (matchesKey(data, GOAL_KILL_KEY)) tKill.abort();
        });
        // Tied to the same drains as the milestone judge: nothing outlives the
        // boundary that owned it.
        const tDrainAbort = new AbortController();
        const tDrain = () => tDrainAbort.abort();
        liveCheckAborts.add(tDrain);
        let triaged: TriageVerdict | undefined;
        let triageError = "";
        let tAborted = false;
        try {
          const tSignal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), tKill.signal, tDrainAbort.signal]);
          const tKilled = new Promise<null>((resolve) => {
            const onAbort = () => resolve(null);
            if (tSignal.aborted) {
              onAbort();
              return;
            }
            tSignal.addEventListener("abort", onAbort, { once: true });
          });
          const tAssessed = (async () => {
            try {
              triaged = await triage.triage(goal, {
                workDigest: buildWorkDigest((ctx.sessionManager?.getBranch?.() ?? []) as GoalBranchEntry[]),
                continuation: continuations + 1,
                maxContinuations,
                signal: tSignal,
                // The live tasks the hold decision needs: without them the
                // judge cannot tell in-flight work from an ambient server.
                ...(holding ? { runningTasks: describeBgTasks(running) } : {}),
              });
            } catch (e) {
              triageError = e instanceof Error ? e.message : String(e);
            }
          })();
          await Promise.race([tAssessed, tKilled]);
          tAborted = tSignal.aborted;
        } finally {
          liveCheckAborts.delete(tDrain);
          tDetach(); // the listener lives exactly as long as the triage
        }
        uiRef?.setWidget(GOAL_CHECK_WIDGET_KEY, undefined);
        if (tAborted) {
          // Same contract as the aborted check below: re-engage with a notice,
          // burn no budget, keep the next settle honest (re-triage). The halt
          // guards re-checked — a pause/stop/shutdown drain may have fired.
          if (shuttingDown || stopped || !goal || goal.status !== "active") {
            updateFooter();
            return undefined;
          }
          updateFooter();
          parkedForTasks = false; // the abort re-engages with a notice — the park episode ends
          pi.sendMessage(
            {
              customType: GOAL_CHECK_TYPE,
              content:
                "The settle triage was aborted before it finished; nothing was decided. " +
                "Do not run the verify command yourself — end your turn, and the next settle re-triages automatically.",
              display: true,
              details: {
                continuation: continuations + 1,
                max: maxContinuations,
                ok: false,
                aborted: true,
                exitCode: null,
                timedOut: false,
                staleContinuations: 0, // nothing was decided — no age to report
                output: "",
                triage: "aborted",
              } satisfies GoalCheckDetails,
            },
            { deliverAs: "followUp" },
          );
          return { continue: true };
        }
        // The judge read the running tasks and chose to wait for them: park
        // — no budget, nothing cached, first calm settle (or the next user
        // prompt) re-triages. A calm "hold" (no tasks running) is drift —
        // the option is offered only with tasks in flight — and falls
        // through to the measure path below.
        if (triaged?.action === "hold" && holding) return park();
        // No opinion or an error while tasks run: defer like the triage-less
        // path — measuring against work still in flight (or on a lock it
        // holds) is what the deferral exists to avoid, and a broken triage
        // degrades to the pre-judge behavior rather than bypassing it. Said
        // out loud when it was an error — silent degradation reads as a hang.
        if (!triaged && holding) {
          if (triageError !== "") {
            uiRef?.notify(
              `Goal #${goal.id} settle triage failed (${triageError}) — holding the check while background tasks run.`,
            );
          }
          return park();
        }
        // A decided settle (continue or measure) ends any park episode.
        parkedForTasks = false;
        // The cap still gates every budget-burning action — but only now,
        // after the hold decision declined to park (a parked run at the cap
        // defers the breaker to a calm settle; a proceeding one meets it).
        if (holding && (await applyCap())) return;
        if (triaged?.action === "continue") {
          // Mid-work: continue without measuring. It is a real auto-continuation
          // (budget burns) but contributes NO evidence to the progress window —
          // a marker would mix with real measurements and read as movement
          // (the set-time baseline differs from any marker). A window starved
          // of measurements fails the cap judge closed: endless skips must trip
          // the breaker, not launder it.
          continuations += 1;
          totalContinuations += 1;
          // The cached measurement (if any) aged by this unmeasured turn —
          // a frozen age would keep reporting "just measured" across a long
          // run of skips.
          if (lastCheck) lastCheckAge += 1;
          updateFooter();
          pi.sendMessage(
            {
              customType: GOAL_CHECK_TYPE,
              content: renderTriagePrompt(
                goal,
                triaged.reason,
                continuations,
                maxContinuations,
                lastCheck ? lastCheckAge : 0,
              ),
              display: true,
              details: {
                continuation: continuations,
                max: maxContinuations,
                ok: false,
                exitCode: null,
                timedOut: false,
                staleContinuations: lastCheck ? lastCheckAge : 0,
                output: clip(triaged.reason ?? "", 2000),
                triage: "continue",
              } satisfies GoalCheckDetails,
            },
            { deliverAs: "followUp" },
          );
          // Durable accounting per settle: an unexpected reload mid-budget must
          // restore this turn's consumed continuation, not re-grant it.
          persistGoalState();
          return { continue: true };
        }
        // "verify" or an error on a calm settle: fall through and measure. A
        // triage failure is said out loud — silent degradation reads as a hang.
        if (triageError !== "" && !triaged) {
          uiRef?.notify(`Goal #${goal.id} settle triage failed (${triageError}) — running the verify.`);
        }
      }
      // Animated chat-area spinner while the (possibly minutes-long) check
      // runs — pi clears its own working spinner at agent_end, so without this
      // the settle boundary renders as a dead pause.
      const spinnerLabel = judged
        ? `running milestone judge${judgeModel ? `: ${clip(judgeModel, 40)}` : ""} · alt+x aborts`
        : `running goal check: ${clip(verifyCommand ?? "", 60)} · alt+x aborts`;
      uiRef?.setWidget(
        GOAL_CHECK_WIDGET_KEY,
        (tui: { requestRender(): void }, theme: Pick<Theme, "fg">) =>
          new CheckSpinnerComponent(tui, theme, spinnerLabel),
      );
      // Esc for this boundary cannot be built from Esc itself: pi binds a
      // bare Esc to app.interrupt (aborting the run pi-side at this boundary)
      // and its editor has a double-Esc action, while popup dismissals also
      // emit Esc — none of those are addressed at the check. So the kill key
      // is the dedicated GOAL_KILL_KEY (alt+x): unbound in pi's defaults and
      // never an editing gesture, so observing it is attribution enough.
      // ctx.signal is still folded in for the day pi wires one.
      const killAbort = new AbortController();
      const detachKillKey = listenForTerminalInput(uiRef, (data) => {
        if (matchesKey(data, GOAL_KILL_KEY)) killAbort.abort();
      });
      // The judge child is tied to the same shutdown/pause/stop drain as the
      // verify's process tree: nothing outlives the boundary that owned it.
      const drainAbort = new AbortController();
      const drain = () => drainAbort.abort();
      if (judged) liveCheckAborts.add(drain);
      let verdict: SettleVerdict | undefined;
      let judgeError = "";
      let aborted = false;
      try {
        if (judged) {
          // One kill switch for the assessment — the chord, the administrative
          // drain, and (the day pi wires one) ctx.signal — chained into the
          // seam so the real child tree dies the moment any fires.
          const judgeSignal = AbortSignal.any([
            ...(ctx.signal ? [ctx.signal] : []),
            killAbort.signal,
            drainAbort.signal,
          ]);
          // Race the assessment against the kill switch: a judge that ignores
          // (or never sees) the signal must not wedge the settle boundary
          // until the timeout — the same contract runGatedVerify gives the
          // tool-call path. Assessment errors are caught here (fail open),
          // not in the outer catch, which serves the verify runner alone.
          const killed = new Promise<null>((resolve) => {
            const onAbort = () => resolve(null);
            if (judgeSignal.aborted) {
              onAbort();
              return;
            }
            judgeSignal.addEventListener("abort", onAbort, { once: true });
          });
          const assessed = (async () => {
            try {
              verdict = await settleJudge!.assess(goal, {
                workDigest: buildWorkDigest(ctx.sessionManager.getBranch() as GoalBranchEntry[]),
                continuation: continuations + 1,
                maxContinuations,
                ...(lastJudgeReason ? { previousReason: lastJudgeReason } : {}),
                signal: judgeSignal,
                // The live tasks the hold decision needs: without them the
                // judge cannot tell in-flight work from an ambient server.
                ...(holding ? { runningTasks: describeBgTasks(running) } : {}),
              });
            } catch (e) {
              judgeError = e instanceof Error ? e.message : String(e);
            }
          })();
          await Promise.race([assessed, killed]);
          aborted = judgeSignal.aborted;
          check = { ok: false, exitCode: null, timedOut: false, output: "" };
        } else {
          check = await verifyRunner(verifyCommand!, {
            timeoutMs: verifyTimeoutMs,
            signal: ctx.signal ? AbortSignal.any([ctx.signal, killAbort.signal]) : killAbort.signal,
          });
          aborted = check.aborted === true;
        }
      } catch (e) {
        // The built-in verify runner never rejects; an injected one might. A
        // throw must not escape the settle boundary — treat it as a failed
        // check and re-engage with the error so the model can fix the check
        // itself. (Judge-path errors are caught inside `assessed` above.)
        check = {
          ok: false,
          exitCode: null,
          timedOut: false,
          spawnError: e instanceof Error ? e.message : String(e),
          output: "",
        };
      } finally {
        if (judged) liveCheckAborts.delete(drain);
        detachKillKey(); // the listener lives exactly as long as the check
      }
      uiRef?.setWidget(GOAL_CHECK_WIDGET_KEY, undefined); // spinner lives only for the check's duration
      if (aborted) {
        // The abort is one of: the kill key (deliberate), a pi-side run abort
        // (ctx.signal, the day pi wires one), or an administrative drain
        // (/goal pause, /goal stop, session_shutdown) — the drains change
        // state after this handler's guards ran, so re-check before
        // re-engaging: a halted or tearing-down loop must not take one more
        // turn, and the notice below would be false in that state.
        if (shuttingDown || stopped || !goal || goal.status !== "active") {
          updateFooter();
          return undefined;
        }
        // A deliberate kill re-engages with a notice instead of parking the
        // turn silently; on a real pi-side abort pi drops the queued
        // continuation anyway (clearQueue on abort). lastCheck stays unset —
        // the next settle re-measures rather than acting on a check that never
        // finished — and no budget is burned.
        updateFooter();
        parkedForTasks = false; // the abort re-engages with a notice — the park episode ends
        pi.sendMessage(
          {
            customType: GOAL_CHECK_TYPE,
            content: judged
              ? "The milestone judge was aborted before it finished; nothing was assessed. " +
                "End your turn — the next settle re-assesses automatically."
              : "The goal check was aborted before it finished; nothing was measured. " +
                "Do not run the verify command yourself — end your turn, and the next settle re-measures automatically.",
            display: true,
            details: {
              continuation: continuations + 1,
              max: maxContinuations,
              ok: false,
              aborted: true,
              exitCode: null,
              timedOut: false,
              staleContinuations: 0, // nothing was measured — no age to report
              output: "",
              ...(judged ? { judge: "unavailable" } : {}),
            } satisfies GoalCheckDetails,
          },
          { deliverAs: "followUp" },
        );
        return { continue: true };
      }
      if (judged) {
        // The judge read the running tasks and chose to wait for them: park —
        // no budget, nothing cached. A calm "hold" (no tasks running) is
        // drift the park gate never offers; milestoneKind below maps it to
        // the fail-open "unavailable" continuation instead.
        if (verdict?.verdict === "hold" && holding) return park();
        parkedForTasks = false; // a decided settle ends any park episode
        // The cap gates the re-engagement — after the hold decision, not
        // before it (same ordering as the triage path above).
        if (holding && (await applyCap())) return;
        const note = verdict?.reason ?? "the judge returned no opinion";
        check = {
          ok: verdict?.verdict === "complete",
          exitCode: null,
          timedOut: false,
          ...(judgeError !== "" && !verdict ? { spawnError: judgeError } : {}),
          output: judgeError !== "" && !verdict ? `the judge could not run: ${judgeError}` : note,
        };
        lastJudgeReason = verdict?.reason; // undefined on failure — the next assessment starts clean
      }
      lastCheck = check;
      lastCheckAge = 0;
      lastCheckKind = judged ? milestoneKind(verdict) : undefined;
      lastJudgeRemaining = judged ? (verdict?.remaining ?? []) : [];
    } else {
      check = lastCheck!;
      lastCheckAge += 1;
    }
    continuations += 1;
    totalContinuations += 1;
    updateFooter();
    // The budget window needs a STABLE measured state, not prose: the judge's
    // reason rewords itself every turn even at a plateau, so feeding it here
    // would let the default progress judge read any rewording as movement and
    // multiply the cap on exactly the goals the judge drives. Verdict + the
    // sorted remaining set is stable: same assessment ⇒ identical string.
    if (due)
      recordBudgetOutput(
        budgetOutputs,
        judged ? `${lastCheckKind ?? "unavailable"}:[${[...lastJudgeRemaining].sort().join("|")}]` : check.output,
      );
    pi.sendMessage(
      {
        customType: GOAL_CHECK_TYPE,
        content: judged
          ? renderMilestonePrompt(
              goal,
              lastCheckKind ?? "unavailable",
              check.output,
              lastJudgeRemaining,
              continuations,
              maxContinuations,
              lastCheckAge,
            )
          : renderCheckPrompt(goal, check, continuations, maxContinuations, lastCheckAge),
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
          ...(judged ? { judge: lastCheckKind ?? "unavailable" } : {}),
        } satisfies GoalCheckDetails,
      },
      { deliverAs: "followUp" },
    );
    // Durable accounting per settle (same rationale as the triage path above).
    persistGoalState();
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

  /** Cadence for the tool-row progress partials while a verify runs (ms). */
  const VERIFY_UPDATE_MS = 5_000;
  /** Sentinel for the abort race — runVerify (or the runner) still finishes its
   * own cleanup; this only unblocks the tool call. */
  const ABORTED_VERIFY: VerifyResult = { ok: false, exitCode: null, timedOut: false, aborted: true, output: "" };

  const throwToVerifyResult = (e: unknown): VerifyResult => ({
    ok: false,
    exitCode: null,
    timedOut: false,
    spawnError: e instanceof Error ? e.message : String(e),
    output: "",
  });

  /**
   * Run a verify inside a tool call (set-preflight or completion gate) with a
   * live progress row and a real abort path. pi keeps the tool row rendered
   * while execute is pending, so onUpdate partials ("running baseline check ·
   * 45s") make a multi-minute verify legible instead of a dead "working"
   * spinner. The abort race bounds the call even if an injected runner ignores
   * the signal: Esc resolves immediately while runVerify kills the child tree.
   */
  const runGatedVerify = async (
    g: Goal,
    verifyCommand: string,
    phase: "baseline" | "completion",
    signal: AbortSignal | undefined,
    onUpdate: ((partial: AgentToolResult<GoalDetails>) => void) | undefined,
  ): Promise<VerifyResult> => {
    updateFooter(`${phase}: ${verifyCommand}`);
    const startedAt = Date.now();
    const elapsed = () => formatElapsed(Date.now() - startedAt);
    const emit = () =>
      onUpdate?.({
        content: [
          { type: "text" as const, text: `running ${phase} check \`${verifyCommand}\` — ${elapsed()} elapsed` },
        ],
        details: { goal: g, running: `${phase} check: ${verifyCommand} · ${elapsed()}` },
      });
    emit();
    const ticker = setInterval(emit, VERIFY_UPDATE_MS);
    ticker.unref?.();
    const raced = (async () => {
      try {
        return await verifyRunner(verifyCommand, { timeoutMs: verifyTimeoutMs, signal });
      } catch (e) {
        return throwToVerifyResult(e);
      }
    })();
    try {
      if (!signal) return await raced;
      if (signal.aborted) return ABORTED_VERIFY; // aborted during the runner call — raced may still be running
      return await new Promise<VerifyResult>((resolve) => {
        const onAbort = () => resolve(ABORTED_VERIFY);
        signal.addEventListener("abort", onAbort, { once: true });
        raced.then(
          (r) => {
            signal.removeEventListener("abort", onAbort);
            resolve(r);
          },
          // raced never rejects (throwToVerifyResult converts), but a rejected
          // chained runner must not wedge the race either
          () => resolve(ABORTED_VERIFY),
        );
      });
    } finally {
      clearInterval(ticker);
      updateFooter();
    }
  };

  pi.registerTool({
    name: GOAL_TOOL_NAME,
    label: "Goal",
    description:
      'Track a single high-level objective that must be finished and verified. Use it to commit to a goal and to gate its completion: set a goal (optionally with checkable criteria and a `verify` check, e.g. `npm test` or a coverage report, that prints the measured state and exits 0 only when the objective is met — the extension runs it at the end of every turn, reads the output to see what is still missing, and re-engages you to close the gaps, so it must genuinely exit 0, not just be claimed), then work toward it, then call it again with action "complete" and per-criterion evidence (evidence[i] proves criteria[i]) — a free-text \'done\' without proof is rejected, as is a summary that names a failure. Call it with action "blocked" only for a true impasse — a second-opinion judge scrutinizes the claim (2+ clean-window measured datapoints, the mechanism refuted, component impossibility rather than lever exhaustion), and an unmet standard keeps the goal active. Do not use it to organize steps (that is the todo tool) or for work that finishes in a couple of tool calls.',
    parameters: GoalParams,
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
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
        // Persist the new goal with the latch exactly as it stands in memory:
        // when the loop is stopped (a /goal stop or the cap), an ACTIVE goal
        // must be recorded as latched or a reload would silently re-arm it.
        persistGoalState(stopped ? true : undefined);
        // setGoal deliberately does NOT re-arm a stopped loop (a model set
        // must not farm continuations past a stop) — but an active goal with
        // a dead loop is a silent trap observed in production: the footer
        // ticks "goal · Nh", nothing ever checks, and stop/resume both
        // refuse it. Say so to the model and the user instead.
        const stoppedSuffix = stopped
          ? " NOTE: the auto-check loop is STOPPED for this session (a /goal stop or the continuation cap); the verify will NOT re-run at turn end until the user re-arms it with /goal resume — tell them."
          : "";
        if (stopped) {
          uiRef?.notify(
            `Goal #${g.id} set, but the auto-check loop is stopped for this session — /goal resume re-arms it.`,
          );
        }
        // The verify-less dead-loop shape, made loud at the moment it is
        // created (observed live: an objective whose text said "I have to
        // reboot", so the model set the goal verify-less, ended its turn, and
        // nothing ever re-engaged it). With a judge configured the loop lives
        // and the note is informational; without one it is the trap warning.
        const noVerifySuffix = g.verify
          ? ""
          : settleJudge
            ? " NOTE: no verify command was set — the milestone judge (a second model) assesses progress at each turn end and re-engages you; completion still requires per-criterion evidence."
            : " NOTE: no verify command was set and no milestone judge is configured — there is no turn-end auto-check for this goal, so nothing will re-engage you between turns; keep working in this turn and on the user's later prompts.";
        if (!g.verify && !settleJudge) {
          uiRef?.notify(
            `Goal #${g.id} set without a verify command or milestone judge — no auto-check loop; it advances only on your prompts.`,
          );
        }
        const criteriaLine =
          g.criteria.length > 0 ? ` Criteria: ${g.criteria.map((cr, i) => `${i + 1}. ${cr}`).join("; ")}.` : "";
        if (!g.verify) {
          return finish(
            g,
            `Goal #${g.id} set: ${g.objective}.${criteriaLine}${noVerifySuffix}${stoppedSuffix} Call goal with action "complete" and per-criterion evidence when done.`,
          );
        }
        // Preflight: run the verify now to establish the baseline. A verify that
        // already passes means the goal is likely already met or mis-specified,
        // so surface it before the model starts (and before it can "complete" trivially).
        // Progress streams onto the tool row and Esc aborts — a heavyweight
        // verify (full gate suites run minutes) must never read as wedged.
        const pre = await runGatedVerify(g, g.verify, "baseline", signal, onUpdate);
        if (pre.aborted) {
          // The goal stands (already persisted above); only the baseline is lost,
          // and the settle loop re-measures at the end of the next turn anyway.
          return finish(
            g,
            `Goal #${g.id} set: ${g.objective}.${criteriaLine} The baseline check was aborted before finishing — no baseline recorded; the verify re-runs at the end of each turn.${stoppedSuffix}`,
            "baseline check aborted",
          );
        }
        // Seed the budget window with the baseline so the judge has a first
        // measured state even for tiny caps (PI_GOAL_MAX_CONTINUATIONS=1).
        recordBudgetOutput(budgetOutputs, pre.output);
        // Re-persist now that the baseline exists: the pre-verify persist above
        // guarantees the goal survives an abort, but its trajectory is empty —
        // without this, a reload before the first settle loses the baseline the
        // judge's first-vs-last diff depends on.
        persistGoalState(stopped ? true : undefined);
        const failWhy = pre.spawnError
          ? ` — the check could not run: ${pre.spawnError}`
          : pre.timedOut
            ? " — the check timed out"
            : "";
        const baseline = pre.ok
          ? ` NOTE: the verify command already passes — confirm the goal isn't already met or the check is too weak, and refine it if so.`
          : ` It currently fails${failWhy}, as expected for an unmet goal; completion is gated on it passing.`;
        return finish(
          g,
          `Goal #${g.id} set: ${g.objective}.${criteriaLine} Completion is gated on the verify command \`${g.verify}\` exiting 0${baseline}${stoppedSuffix} Call goal with action "complete" when done.`,
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
          const res = await runGatedVerify(goal, goal.verify, "completion", signal, onUpdate);
          if (res.aborted) {
            // An aborted check proves nothing — the goal stays active and the
            // completion must be retried (with fresh evidence) after the abort.
            return finish(
              goal,
              `Goal #${goal.id} NOT completed — the completion check was aborted. Call complete again once the run resumes.`,
              "completion check aborted",
            );
          }
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
        persistGoalState();
        clearFooter();
        // Lifecycle gossip for out-of-band consumers (pushover et al.): fired
        // after the state change is durable, never awaited, and safe with zero
        // listeners — see lib/goal-events.ts for the contract.
        emitGoalCompleted({
          id: goal.id,
          objective: goal.objective,
          summary: summary.trim(),
          criteriaCount: effectiveCriteria(goal).length,
          cwd: process.cwd(),
          at: Date.now(),
        });
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
      // A REQUEST, not an action: the agent's own history is premature bail
      // (F2 — it parked on difficulty that later work solved), so the claim
      // gets a second opinion behind the judge seam. Failure table BY CALLER:
      //   verdict impasse=false → NOT blocked, stay active, steer on the basis;
      //   verdict impasse=true  → park, flavor "impasse", packet + event;
      //   judge absent / no opinion / throw → park anyway, packet flagged
      //   unverified — a dead judge must never force a grind (nor silently
      //   veto the agent's own read of its work).
      // (A rejected request becoming a reframe-or-contested-park rides the
      // pivot counter, which arrives with slice 3; until then rejection
      // simply keeps the goal active.)
      const targetId = goal.id;
      let impasse: ImpasseVerdict | undefined;
      let impasseError = "";
      // Raced like every sibling boundary: an injected judge that ignores the
      // signal must not wedge the tool call until its own (possibly absent)
      // timeout, and the /goal pause|stop drains must be able to cancel it.
      // Tied to the same drains as the settle judges — nothing outlives the
      // boundary that owned it.
      const judgeKill = new AbortController();
      const judgeDrain = () => judgeKill.abort();
      liveCheckAborts.add(judgeDrain);
      const judgeSignal = AbortSignal.any([...(signal ? [signal] : []), judgeKill.signal]);
      try {
        const killed = new Promise<null>((resolve) => {
          const onAbort = () => resolve(null);
          if (judgeSignal.aborted) {
            onAbort();
            return;
          }
          judgeSignal.addEventListener("abort", onAbort, { once: true });
        });
        const assessed = (async () => {
          if (!settleJudge?.assessBlocked) return;
          try {
            impasse = await settleJudge.assessBlocked(
              goal,
              {
                workDigest: buildWorkDigest((branchRef?.getBranch() ?? []) as GoalBranchEntry[]),
                continuation: continuations + 1,
                maxContinuations,
                signal: judgeSignal,
              },
              reason,
            );
          } catch (e) {
            impasseError = e instanceof Error ? e.message : String(e);
          }
        })();
        await Promise.race([assessed, killed]);
      } finally {
        liveCheckAborts.delete(judgeDrain);
      }
      // Post-await guards, mirroring the settle handler's ("the drains change
      // state after this handler's guards ran"): the judge can take minutes,
      // and a pause/stop/shutdown that landed mid-assessment must not be
      // overwritten by this park — nor fire its out-of-band notification.
      // An abort (Esc) is the user cancelling THIS call: nothing changed.
      if (judgeSignal.aborted) {
        return finish(goal, "Goal NOT blocked: the impasse check was aborted — nothing changed.", "aborted");
      }
      if (shuttingDown || stopped || !goal || goal.status !== "active" || goal.id !== targetId) {
        const now = goal ? `goal is now ${stopped ? "stopped" : goal.status}` : "goal is gone";
        return finish(
          goal,
          `Goal NOT blocked: ${now} while the impasse check ran — the user's action wins; nothing parked.`,
          "state changed during check",
        );
      }
      if (impasse !== undefined && !impasse.impasse) {
        const basis = impasse.reason ?? "the impasse standard was not met";
        // Rejected → reframe if a pivot remains, else park with the contested
        // case (the initiator rule: the judge alone never stops a run — a
        // false rejection burns one bounded pivot, whose first rung — the
        // clean re-measure — generates exactly the data that corrects it).
        if (pivotsUsed < maxPivots) {
          pivotsUsed += 1;
          // The pivot refresh: ONLY the continuation window. Spend, met
          // criteria, resets, measured state, and the trajectory baseline all
          // carry over — the new epoch is judged against the same gap.
          continuations = 0;
          persistGoalState();
          return finish(
            goal,
            `${renderReframePrompt(goal, `blocked request rejected — ${basis}`, pivotsUsed, maxPivots)}\n\nThe goal stays ACTIVE; the reframe is a mandate to produce evidence, not a decision to stop.`,
            "reframed",
          );
        }
        const contested = clip(
          `CONTESTED — agent: ${reason} · judge rejected: ${basis}. Parked with the contested case: no pivots remained for a reframe.`,
          MAX_PARK_CASE_CHARS,
        );
        const park: ParkPacket = {
          flavor: "impasse",
          caseText: contested,
          resumeRequires: parkResumeRequires("impasse"),
          spendMs: accruedGoalSpendMs(),
        };
        goal = { ...goal, status: "blocked", blockedReason: reason, park };
        persistGoalState();
        clearFooter();
        emitGoalParked({
          id: goal.id,
          objective: goal.objective,
          flavor: park.flavor,
          reason: park.caseText,
          resumeRequires: park.resumeRequires,
          spendMs: park.spendMs,
          cwd: process.cwd(),
          at: Date.now(),
        });
        return finish(
          goal,
          `Goal #${goal.id} parked with the CONTESTED case (no pivots remained). Decision packet — case: ${contested} · resume requires: ${park.resumeRequires} · spend so far: ${formatElapsed(park.spendMs)}. Tell the user both sides are on record; /goal resume re-arms it.`,
        );
      }
      const unverified = impasse === undefined;
      const judgeNote = unverified
        ? impasseError
          ? ` (impasse judge errored: ${impasseError}; park rests on the request alone)`
          : " (no impasse judge available; park rests on the request alone)"
        : " (impasse judge concurred)";
      const caseText = unverified ? reason : `${reason} — judge: ${impasse!.reason ?? "concurred"}`;
      const park: ParkPacket = {
        flavor: "impasse",
        caseText: clip(caseText, MAX_PARK_CASE_CHARS),
        resumeRequires: parkResumeRequires("impasse"),
        spendMs: accruedGoalSpendMs(),
        ...(unverified ? { unverified: true } : {}),
      };
      goal = { ...goal, status: "blocked", blockedReason: reason, park };
      // Deliberately NO loop latch: an agent-initiated blocked is terminal by
      // status (the same guards that hold for complete stop the checks), and a
      // derived-or-explicit latch here would poison a later set after reload
      // (pinned by the "derives no latch" regression). The judge-verdict Stop
      // — which parks the latch because its goal stays ACTIVE — arrives with
      // the merged judge.
      persistGoalState();
      clearFooter();
      emitGoalParked({
        id: goal.id,
        objective: goal.objective,
        flavor: park.flavor,
        reason: park.caseText,
        resumeRequires: park.resumeRequires,
        spendMs: park.spendMs,
        cwd: process.cwd(),
        at: Date.now(),
        ...(unverified ? { unverified: true } : {}),
      });
      return finish(
        goal,
        `Goal #${goal.id} parked as blocked${judgeNote}. ` +
          `Decision packet — case: ${park.caseText} · flavor: ${park.flavor} · resume requires: ${park.resumeRequires} · spend so far: ${formatElapsed(park.spendMs)}. ` +
          "Tell the user: the loop is stopped and waiting on them; /goal resume re-arms it once they act on the packet.",
      );

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
    const park = goal.park
      ? `\nParked (${goal.park.flavor}${goal.park.unverified ? ", unverified" : ""}) — resume requires: ${goal.park.resumeRequires} · spend: ${formatElapsed(goal.park.spendMs)}`
      : "";
    return `Goal #${goal.id} (${goal.status}): ${goal.objective}\n${criteria}${extra}${park}`;
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
        // Escape hatch: pi exposes no abort signal at the settle boundary, so an
        // in-flight turn-end check cannot see Esc — /goal pause kills it here.
        for (const abort of [...liveCheckAborts]) abort();
        // Paused is persisted (a goal.state entry): a reload must not resume
        // the pursuit under the user. Unlike stop, the goal stays pursuing
        // (not blocked) and all progress is retained for /goal resume.
        stopped = true;
        goal = { ...goal, status: "paused" };
        persistGoalState(true);
        updateFooter();
        ctx.ui.notify(`Goal #${goal.id} paused — talk freely; /goal resume when ready.`);
        return;
      }

      if (trimmed === "resume") {
        // An active goal can also be loop-stopped: a /goal stop or the
        // continuation cap, then a later model set — set re-activates the goal
        // but deliberately never re-arms the loop, and without this arm that
        // goal would tick its footer forever with a dead loop and no recovery
        // (stop refuses it as already-stopped, resume as not-paused).
        const resumableGoal =
          goal && (goal.status === "paused" || (goal.status === "active" && stopped) || goal.park) ? goal : undefined;
        if (!resumableGoal) {
          ctx.ui.notify("No paused or stopped goal to resume.");
          return;
        }
        const wasPaused = resumableGoal.status === "paused";
        // A user resuming is a deliberate engagement: re-arm the continuation
        // budget, exactly like a user (re)starting a goal — and say out loud
        // what the goal has already consumed before re-authorizing more (F1:
        // the re-arm used to be silent, so a pause/resume quietly bought a
        // fresh window). Lifetime numbers, not window — the window is what's
        // being re-granted.
        const lifetime = `${totalContinuations} continuations, ${formatElapsed(accruedSpendMs())} of pursuit`;
        // Resuming clears the park packet: the user acted on resumeRequires,
        // and the goal that continues is active — the packet survives in the
        // branch history for the trail, not on the live goal.
        goal =
          resumableGoal.park && resumableGoal.status === "blocked"
            ? { ...resumableGoal, status: "active", park: undefined, blockedReason: undefined }
            : { ...resumableGoal, status: "active" };
        stopped = false;
        resetContinuationBudget();
        persistGoalState(false);
        ctx.ui.notify(
          `Goal #${goal.id} resumed — lifetime: ${lifetime}; budget re-armed (fresh ${maxContinuations} continuations).`,
        );
        pi.sendUserMessage(
          wasPaused
            ? `The user paused goal #${goal.id} to have a conversation; that conversation is over and the goal is active again. Continue working toward it — the goal is: ${goal.objective}`
            : `The user re-armed goal #${goal.id} — its auto-check loop was stopped (a /goal stop or the continuation cap); the turn-end verify runs again from the next turn. Continue working toward it — the goal is: ${goal.objective}`,
          { deliverAs: "followUp" },
        );
        return;
      }

      if (trimmed === "stop") {
        if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
          ctx.ui.notify("No active or paused goal to stop.");
          return;
        }
        // Escape hatch, as with pause: kill an in-flight settle-boundary check
        // (unreachable by Esc — pi exposes no abort signal at that boundary).
        for (const abort of [...liveCheckAborts]) abort();
        // Kill switch, persisted as a goal.state entry: the goal is marked
        // not-pursuing (blocked) and the loop latch set, so a reload can no
        // longer resurrect a goal the user stopped.
        stopped = true;
        goal = { ...goal, status: "blocked", blockedReason: "stopped by user" };
        persistGoalState(true);
        clearFooter();
        ctx.ui.notify(`Goal #${goal.id} stopped.`);
        return;
      }

      // Start a goal by routing it through the model: the goal is created by the
      // goal tool, which persists the goal.state entry — the branch stays the
      // single source of truth. If a goal already exists, the kickoff is a
      // deliberate re-engagement: re-arm it in memory AND on the branch.
      const o = validateObjective(trimmed);
      if (o.error) {
        ctx.ui.notify(o.error, "error");
        return;
      }
      activateTool();
      if (goal) {
        // A kickoff is a deliberate engagement: release the loop latch durably
        // so a reload between here and the model's set cannot re-instate a
        // superseded stop onto the goal the user is replacing. Only a paused
        // goal is resurrected to active; terminal goals keep their status —
        // the model's set persists the replacement goal (and its own state).
        goal = goal.status === "paused" ? { ...goal, status: "active" } : goal;
        stopped = false;
      }
      // A user (re)starting a goal re-arms the loop budget — a deliberate
      // engagement, distinct from the model's autonomous set (which can't re-arm).
      resetContinuationBudget();
      // Persist AFTER the re-arm: an existing goal's entry must carry the fresh
      // budget, not the consumed one it replaces (a fresh kickoff has no goal
      // to persist yet — the model's set writes the first entry).
      if (goal) persistGoalState(false);
      pi.sendUserMessage(
        `Set the goal "${trimmed}" using the goal tool (action "set"). If the objective is measurable, give it a verify command that prints the current state and exits 0 only when the objective is met — the extension re-runs it at the end of every turn and only lets you complete when it passes. If it is milestone-style or otherwise not script-checkable, omit verify — a milestone judge (a second model) assesses progress at each turn end and re-engages you. Then start working toward the goal immediately in this same turn — do not stop after setting it unless the objective itself says to wait — and when it is genuinely met, call the goal tool with action "complete" and per-criterion evidence that cites the real command and its output.`,
        { deliverAs: "followUp" },
      );
      ctx.ui.notify("Goal started; the agent will set it via the goal tool.");
    },
  });
}

export default registerGoalTool;
