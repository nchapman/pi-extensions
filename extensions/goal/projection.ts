/**
 * Feasibility projection — the PLUMBING half of the merged judge's flat
 * detection (goal-loop design, payload contract). Pure and conservative: it
 * extracts only clear-polarity numeric metrics from the trajectory's verify
 * outputs, computes the observed closure rate per continuation, and projects
 * whether the remaining continuation budget can close the remaining gap.
 *
 * Deliberate limits, so "flat" stops being a vibe without becoming a lie:
 * - ≥2 measured points with the SAME metric in first and last are required;
 *   anything else is "insufficient-data" (the judge decides, unaided).
 * - Ambiguous metrics (a bare percent with no polarity keyword) are skipped,
 *   never guessed: a wrong-polarity projection would steer real runs.
 * - Extrapolation is wrong on plateau-then-breakthrough curves — that is
 *   precisely what the pivot is. The projection is a citation the judge may
 *   overrule, never a gate.
 */

export type CompletionProjection = "projects-complete" | "cannot-close-by-budget" | "insufficient-data";

export interface ProjectionInput {
  /** Oldest→newest measured states (the persisted trajectory tail: capped
   * verify outputs, one per measured settle). Untrusted text — only the
   * well-known metric shapes below are ever read. */
  trajectory: readonly string[];
  /** Continuations consumed across the trajectory's span (rate denominator;
   * clamped to ≥1 so a mid-first-window call cannot divide by zero). */
  continuationsUsed: number;
  /** Continuations left before the breaker (the budget being projected
   * against). */
  continuationsRemaining: number;
}

/** A metric with known polarity and known target. */
interface Metric {
  name: string;
  value: number;
  /** true when the target is 0 (failures/remaining counts). */
  lowerIsBetter: boolean;
  /** The value that would mean "this metric is closed". */
  target: number;
}

const MAX_OUTPUT_CHARS = 4_000;

/** Extract clear-polarity metrics from one verify output. Keyword-anchored,
 * case-insensitive, first-match-per-family — a verify prints a handful of
 * lines; the first coverage/failure line is the signal, later ones noise. */
export function extractMetrics(output: string): Metric[] {
  const text = output.slice(0, MAX_OUTPUT_CHARS).toLowerCase();
  const metrics: Metric[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: number, lowerIsBetter: boolean, target: number) => {
    if (!Number.isFinite(value) || value < 0 || seen.has(name)) return;
    seen.add(name);
    metrics.push({ name, value, lowerIsBetter, target });
  };
  // Failure-family counts: lower is better, closed at 0.
  for (const [m, name] of [
    [/(\d+)\s+(?:tests?|checks?)\s+failed\b/, "failed"],
    [/(\d+)\s+failures?\b/, "failed"],
    [/(\d+)\s+failed\b/, "failed"],
    [/(\d+)\s+failing\b/, "failing"],
    [/(\d+)\s+errors?\b/, "errors"],
    [/(\d+)\s+(?:unmet|remaining|todo|outstanding)\b/, "remaining"],
  ] as const) {
    const hit = m.exec(text);
    if (hit) add(name, Number(hit[1]), true, 0);
  }
  // Pass-family counts: higher is better, target unknown here (the suite size
  // is not printed reliably) — projected only against coverage-style targets,
  // so they carry target=Infinity and never project-complete on their own.
  const passed = /(\d+)\s+(?:passed|passing)\b/.exec(text);
  if (passed) add("passed", Number(passed[1]), false, Number.POSITIVE_INFINITY);
  // Coverage-style percents: higher is better, closed at 100 — anchored on a
  // polarity keyword so a bare "12%" is skipped rather than guessed.
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct && /\b(coverage|statements?|branches?|lines?|functions?|score|accuracy)\b/.test(text)) {
    add("percent", Number(pct[1]), false, 100);
  }
  return metrics;
}

/**
 * Project completion. See the module header for the contract; the return is
 * one of:
 * - "projects-complete": every tracked metric either already meets its target
 *   or closes it at the observed rate within the remaining budget.
 * - "cannot-close-by-budget": at least one tracked metric with an open gap is
 *   flat (rate ≤ 0) or projects to miss — the F1 signature.
 * - "insufficient-data": fewer than two comparable points, or no clear
 *   metrics at all.
 */
export function projectCompletion(input: ProjectionInput): CompletionProjection {
  const { trajectory } = input;
  if (trajectory.length < 2) return "insufficient-data";
  const used = Math.max(1, Math.floor(input.continuationsUsed));
  const remaining = Math.max(0, Math.floor(input.continuationsRemaining));

  const first = extractMetrics(trajectory[0]);
  const last = extractMetrics(trajectory[trajectory.length - 1]);
  if (first.length === 0 || last.length === 0) return "insufficient-data";

  let projected: CompletionProjection | undefined;
  let comparable = 0;
  for (const begin of first) {
    const end = last.find((m) => m.name === begin.name);
    if (end === undefined) continue; // metric vanished between prints — no basis
    comparable += 1;
    const improvement = begin.lowerIsBetter ? begin.value - end.value : end.value - begin.value;
    const gap = begin.lowerIsBetter ? end.value - end.target : end.target - end.value;
    if (gap <= 0) continue; // already closed: no constraint
    if (!Number.isFinite(end.target)) continue; // unknown target: not projectable
    const rate = improvement / used;
    const projectedValue = end.lowerIsBetter ? end.value - rate * remaining : end.value + rate * remaining;
    const meets = end.lowerIsBetter ? projectedValue <= end.target : projectedValue >= end.target;
    if (rate <= 0 || !meets) {
      // First open, projectable, and missing is the answer — but keep scanning
      // so a later already-closed metric cannot flip it to complete.
      projected = "cannot-close-by-budget";
      continue;
    }
    if (projected === undefined) projected = "projects-complete";
  }
  // No comparable pair at all → no basis; every comparable metric closed →
  // the projection affirms (it tracks what the verify prints, nothing else).
  if (comparable === 0) return "insufficient-data";
  return projected ?? "projects-complete";
}
