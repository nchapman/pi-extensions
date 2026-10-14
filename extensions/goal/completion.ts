/** The completion gate: tool-parameter validation and the deterministic,
 * free (no-model) check that a `complete` action must survive. Structural —
 * evidence indexed to criteria, contradiction scan, and the optional
 * injectable GoalJudge second opinion. */

import { Type } from "typebox";
import type { Goal } from "./state";

export const MAX_OBJECTIVE_CHARS = 4000;
export const MAX_CRITERIA = 20;

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

/**
 * One flat object schema, not a discriminated union. A top-level Type.Union
 * serializes to a rootless anyOf with no `properties` for OpenAI-compatible
 * providers to key arguments off — GLM via zai answered such a schema with
 * empty arguments, and the tool silently fell through to "No goal." Every
 * action-specific field is optional here and validated per-branch in execute.
 */
export const GoalParams = Type.Object({
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
