/** Environment knobs for the goal loop: parsed through small pure helpers;
 * invalid values fall back to documented defaults (range-clamped), never
 * throw. Kept separate from the wiring so tests cover parsing directly. */

export const GOAL_TOOL_NAME = "goal";
/** Per-session cap on auto-continuations for a still-active goal (PI_GOAL_MAX_CONTINUATIONS). */
export const GOAL_MAX_CONTINUATIONS_DEFAULT = 25;
export const GOAL_MAX_CONTINUATIONS_ENV = "PI_GOAL_MAX_CONTINUATIONS";

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
export const GOAL_MAX_TURNS_PER_RUN_ENV = "PI_GOAL_MAX_TURNS_PER_RUN";

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
export const GOAL_MAX_PROGRESS_RESETS_ENV = "PI_GOAL_MAX_PROGRESS_RESETS";

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
export const GOAL_CHECK_EVERY_ENV = "PI_GOAL_CHECK_EVERY";

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
 * verify can't stall the loop or blow up context. The timeout is a hang bound,
 * not an expected runtime: real verify scripts run build+test suites that
 * routinely exceed two minutes, and a default that kills them makes the settle
 * boundary adversarial — every long verify "fails" and the model gets re-engaged
 * to fix a timeout that was never a real failure.
 */
export const VERIFY_TIMEOUT_MS_DEFAULT = 900_000;
export const VERIFY_TIMEOUT_ENV = "PI_GOAL_VERIFY_TIMEOUT_MS";
/** Parse PI_GOAL_VERIFY_TIMEOUT_MS (ms). Invalid values fall back to the default. */
export function parseVerifyTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return VERIFY_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) return VERIFY_TIMEOUT_MS_DEFAULT;
  return n;
}
