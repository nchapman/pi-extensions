import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTaskRegistry, getSharedTaskRegistry, publishSharedTaskRegistry, type BgTask } from "../lib/superbash";
import {
  checkCompletion,
  checkEvidenceCoverage,
  defaultProgressJudge,
  effectiveCriteria,
  GOAL_CHECK_EVERY_DEFAULT,
  GOAL_MAX_CONTINUATIONS_DEFAULT,
  GOAL_MAX_PROGRESS_RESETS_DEFAULT,
  GOAL_MAX_TURNS_PER_RUN_DEFAULT,
  MAX_BUDGET_OUTPUTS,
  GOAL_REMINDER_TYPE,
  GOAL_TOOL_NAME,
  isContradictorySummary,
  lastGoalSnapshot,
  listenForTerminalInput,
  parseCheckEvery,
  parseMaxContinuations,
  parseMaxProgressResets,
  parseMaxTurnsPerRun,
  recordBudgetOutput,
  parseVerifyTimeoutMs,
  renderCheckPrompt,
  renderCheckMessage,
  renderGoalCall,
  renderGoalFooter,
  renderGoalResult,
  renderGoalReminder,
  runVerify,
  scanGoalState,
  validateCriteria,
  validateObjective,
  validateVerify,
  type Goal,
  type GoalCheckDetails,
  type GoalDetails,
  type ProgressJudge,
  type VerifyResult,
  registerGoalTool,
  formatElapsed,
  GOAL_CHECK_TYPE,
  VERIFY_TIMEOUT_MS_DEFAULT,
} from "../extensions/goal";

const THEME = { fg: (_k: string, s: string) => s, bold: (s: string) => s, dim: (s: string) => s } as never;

function renderPlain(component: { render: (width: number) => string[] }): string {
  return component.render(200).join("\n");
}

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 1,
  objective: "fix the failing test",
  criteria: [],
  status: "active",
  startedAt: 0,
  ...over,
});

/** Shared fake verify results used across the loop and gate tests. */
const okVerify: VerifyResult = { ok: true, exitCode: 0, timedOut: false, output: "all green" };
const failVerify: VerifyResult = { ok: false, exitCode: 1, timedOut: false, output: "FAIL: expected 2 to be 3" };
const timedOutVerify: VerifyResult = { ok: false, exitCode: null, timedOut: true, output: "" };

function makePi() {
  const tools = new Map<
    string,
    {
      description?: string;
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partial: unknown) => void,
      ) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }
  >();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const activeTools: string[] = ["read", "bash"];
  const sent: Array<{ text: string; opts?: unknown }> = [];
  const sentCustom: Array<{ msg: unknown; opts?: unknown }> = [];
  // Custom state entries appended via pi.appendEntry — hand the same array to
  // sessionCtx(entries) to simulate a reload picking them up from the branch.
  const entries: Array<{ type: string; customType: string; data?: unknown }> = [];
  const messageRenderers = new Map<string, (message: never, options: never, theme: never) => unknown>();
  const pi = {
    registerTool: (t: {
      name: string;
      description?: string;
      parameters?: unknown;
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partial: unknown) => void,
      ) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }) => {
      tools.set(t.name, t);
    },
    registerCommand: (
      name: string,
      cmd: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, cmd),
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      events.set(event, handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.length = 0;
      for (const n of names) activeTools.push(n);
    },
    sendUserMessage: (text: string, opts?: unknown) => {
      sent.push({ text, opts });
    },
    sendMessage: (msg: unknown, opts?: unknown) => {
      sentCustom.push({ msg, opts });
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    registerMessageRenderer: (type: string, renderer: (message: never, options: never, theme: never) => unknown) => {
      messageRenderers.set(type, renderer);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, activeTools, sent, sentCustom, messageRenderers, entries };
}

/** Fire a captured event handler (an optional event body overrides the synthesized one). */
function fire(
  events: Map<string, (event?: unknown, ctx?: unknown) => unknown>,
  name: string,
  ctx?: unknown,
  event?: Record<string, unknown>,
) {
  const handler = events.get(name);
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler(event ?? { type: name }, ctx);
}

/** Build a branch where each snapshot is a goal tool result carrying that goal. */
function goalState(g: Goal, stopped?: boolean) {
  return {
    type: "custom",
    customType: "goal.state",
    data: stopped === undefined ? { goal: g } : { goal: g, stopped },
  };
}

function sessionCtx(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

describe("effectiveCriteria", () => {
  it("returns the objective as the single criterion when none are set", () => {
    expect(effectiveCriteria(goal({ criteria: [] }))).toEqual(["fix the failing test"]);
  });
  it("returns the criteria when present", () => {
    expect(effectiveCriteria(goal({ criteria: ["a", "b"] }))).toEqual(["a", "b"]);
  });
});

describe("validateObjective", () => {
  it("trims and accepts a valid objective", () => {
    const { objective, error } = validateObjective("  ship it  ");
    expect(error).toBeUndefined();
    expect(objective).toBe("ship it");
  });
  it("rejects non-strings and empty strings", () => {
    expect(validateObjective(42).error).toBe("objective must be a string");
    expect(validateObjective("   ").error).toBe("objective must be non-empty");
  });
  it("rejects objectives over the length cap", () => {
    const { error } = validateObjective("x".repeat(4001));
    expect(error).toContain("exceeds 4000");
  });
});

describe("validateCriteria", () => {
  it("defaults to an empty list when omitted", () => {
    expect(validateCriteria(undefined)).toEqual({ criteria: [] });
  });
  it("trims and accepts a valid list", () => {
    const { criteria, error } = validateCriteria(["  a  ", "b"]);
    expect(error).toBeUndefined();
    expect(criteria).toEqual(["a", "b"]);
  });
  it("rejects non-arrays", () => {
    expect(validateCriteria("a").error).toBe("criteria must be an array of strings");
  });
  it("rejects empty and non-string entries", () => {
    expect(validateCriteria(["a", "  "]).error).toBe("criteria[1] must be a non-empty string");
    expect(validateCriteria(["a", 7]).error).toBe("criteria[1] must be a non-empty string");
  });
  it("rejects more than the cap", () => {
    expect(validateCriteria(Array.from({ length: 21 }, (_, i) => `c${i}`)).error).toContain("at most 20");
  });
});

describe("isContradictorySummary", () => {
  it("flags explicit not-done language", () => {
    expect(isContradictorySummary("not complete")).toBe(true);
    expect(isContradictorySummary("the tests are still failing")).toBe(true);
    expect(isContradictorySummary("feature is incomplete")).toBe(true);
    expect(isContradictorySummary("doesn't work")).toBe(true);
    expect(isContradictorySummary("not yet implemented")).toBe(true);
  });
  it("does not trip on a legitimate summary that mentions a fixed failure", () => {
    expect(isContradictorySummary("the previously failing test now passes")).toBe(false);
    expect(isContradictorySummary("All tests pass and the feature works")).toBe(false);
  });
});

describe("checkEvidenceCoverage", () => {
  const criteria = ["a", "b", "c"];
  it("passes when every criterion has non-empty evidence", () => {
    expect(checkEvidenceCoverage(criteria, ["e1", "e2", "e3"])).toEqual({ ok: true, missing: [] });
  });
  it("flags missing or empty evidence by index", () => {
    expect(checkEvidenceCoverage(criteria, ["e1", "", "e3"]).missing).toEqual([1]);
    expect(checkEvidenceCoverage(criteria, ["e1"]).missing).toEqual([1, 2]);
  });
  it("flags a non-array as fully missing", () => {
    expect(checkEvidenceCoverage(criteria, "nope")).toEqual({ ok: false, missing: [0, 1, 2] });
  });
});

describe("checkCompletion", () => {
  it("accepts a valid completion", () => {
    const g = goal({ criteria: ["a", "b"] });
    expect(checkCompletion(g, { goalId: 1, summary: "done", evidence: ["p1", "p2"] }).ok).toBe(true);
  });
  it("rejects a non-active goal", () => {
    expect(
      checkCompletion(goal({ status: "paused" }), { goalId: 1, summary: "done", evidence: ["p"] }).reason,
    ).toContain("not active");
  });
  it("rejects a stale or missing goal id", () => {
    const g = goal({ id: 5 });
    expect(checkCompletion(g, { goalId: 1, summary: "done", evidence: ["p"] }).reason).toContain("stale goal id");
    expect(checkCompletion(g, { goalId: "x", summary: "done", evidence: ["p"] }).reason).toContain("integer");
  });
  it("rejects an empty or contradictory summary", () => {
    expect(checkCompletion(goal(), { goalId: 1, summary: "  ", evidence: ["p"] }).reason).toContain("non-empty");
    expect(checkCompletion(goal(), { goalId: 1, summary: "not complete", evidence: ["p"] }).reason).toContain(
      "contradicts",
    );
  });
  it("rejects missing per-criterion evidence", () => {
    const g = goal({ criteria: ["a", "b"] });
    expect(checkCompletion(g, { goalId: 1, summary: "done", evidence: ["p1"] }).reason).toContain('"b"');
  });
});

describe("parseMaxContinuations", () => {
  it("defaults on missing, empty, and invalid values", () => {
    expect(parseMaxContinuations(undefined)).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
    expect(parseMaxContinuations("  ")).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
    expect(parseMaxContinuations("abc")).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
    expect(parseMaxContinuations("0")).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
    expect(parseMaxContinuations("-3")).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
    expect(parseMaxContinuations("999999")).toBe(GOAL_MAX_CONTINUATIONS_DEFAULT);
  });
  it("accepts a valid integer", () => expect(parseMaxContinuations("7")).toBe(7));
});

describe("parseMaxTurnsPerRun", () => {
  it("defaults on missing, empty, and invalid values", () => {
    expect(parseMaxTurnsPerRun(undefined)).toBe(GOAL_MAX_TURNS_PER_RUN_DEFAULT);
    expect(parseMaxTurnsPerRun("  ")).toBe(GOAL_MAX_TURNS_PER_RUN_DEFAULT);
    expect(parseMaxTurnsPerRun("abc")).toBe(GOAL_MAX_TURNS_PER_RUN_DEFAULT);
    expect(parseMaxTurnsPerRun("0")).toBe(GOAL_MAX_TURNS_PER_RUN_DEFAULT);
    expect(parseMaxTurnsPerRun("99999999")).toBe(GOAL_MAX_TURNS_PER_RUN_DEFAULT);
  });
  it("accepts a valid integer", () => expect(parseMaxTurnsPerRun("7")).toBe(7));
});

describe("parseMaxProgressResets", () => {
  it("defaults on missing, empty, and invalid values", () => {
    expect(parseMaxProgressResets(undefined)).toBe(GOAL_MAX_PROGRESS_RESETS_DEFAULT);
    expect(parseMaxProgressResets("")).toBe(GOAL_MAX_PROGRESS_RESETS_DEFAULT);
    expect(parseMaxProgressResets("abc")).toBe(GOAL_MAX_PROGRESS_RESETS_DEFAULT);
    expect(parseMaxProgressResets("-1")).toBe(GOAL_MAX_PROGRESS_RESETS_DEFAULT);
    expect(parseMaxProgressResets("1e9")).toBe(GOAL_MAX_PROGRESS_RESETS_DEFAULT);
  });

  it("accepts a valid integer, including zero (judge resets disabled)", () => {
    expect(parseMaxProgressResets("5")).toBe(5);
    expect(parseMaxProgressResets("0")).toBe(0);
  });
});

describe("recordBudgetOutput", () => {
  it("keeps the oldest entry as the baseline and bounds the window", () => {
    const outputs = ["baseline"];
    for (let i = 0; i < MAX_BUDGET_OUTPUTS + 10; i++) recordBudgetOutput(outputs, `state ${i}`);
    expect(outputs).toHaveLength(MAX_BUDGET_OUTPUTS);
    expect(outputs[0]).toBe("baseline"); // baseline survives
    expect(outputs.at(-1)).toBe(`state ${MAX_BUDGET_OUTPUTS + 9}`); // newest survives
  });
});

describe("defaultProgressJudge", () => {
  it("continues when the measured state changed across the window", () => {
    const v = defaultProgressJudge(goal(), ["coverage 41%", "coverage 41%", "coverage 55%"]);
    expect(v.continueRun).toBe(true);
  });

  it("stops on an unchanged measured state (plateau)", () => {
    const same = "FAIL: expected 2 to be 3";
    const v = defaultProgressJudge(goal(), [same, same, same]);
    expect(v.continueRun).toBe(false);
  });

  it("stops without at least two measured states", () => {
    expect(defaultProgressJudge(goal(), ["coverage 41%"]).continueRun).toBe(false);
    expect(defaultProgressJudge(goal(), []).continueRun).toBe(false);
  });

  it("ignores whitespace-only differences and empty outputs", () => {
    const v = defaultProgressJudge(goal(), ["  coverage 41%\n", "", " \tcoverage 41% \n"]);
    expect(v.continueRun).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("shows seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
  });
  it("shows minutes and seconds under an hour", () => {
    expect(formatElapsed(252_000)).toBe("4m 12s");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59m 59s");
  });
  it("shows hours and minutes beyond an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe("1h 5m");
  });
  it("clamps negative and non-finite input to 0s", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("renderGoalFooter", () => {
  it("shows presence and elapsed time, without the objective or emoji", () => {
    const g = goal({ id: 3, objective: "ship it", startedAt: 0 });
    const footer = renderGoalFooter(g, 252_000); // 4m 12s after start
    expect(footer).toBe("goal · 4m 12s");
  });
});

describe("parseCheckEvery", () => {
  it("defaults to every turn on missing, empty, and invalid values", () => {
    expect(parseCheckEvery(undefined)).toBe(GOAL_CHECK_EVERY_DEFAULT);
    expect(parseCheckEvery("")).toBe(1);
    expect(parseCheckEvery("abc")).toBe(1);
    expect(parseCheckEvery("0")).toBe(1);
    expect(parseCheckEvery("1e6")).toBe(1);
  });

  it("accepts a valid interval", () => expect(parseCheckEvery("3")).toBe(3));
});

describe("renderCheckPrompt", () => {
  const g = goal({ id: 2, criteria: ["a", "b"] });
  it("marks the measured state as stale when the check was not re-run", () => {
    const p = renderCheckPrompt(goal(), failVerify, 4, 25, 2);
    expect(p).toContain("2 continuation(s) ago");
    expect(p).toContain("Measured state");
  });

  it("on a failed check: the measured state, the gap directive, and the count", () => {
    const p = renderCheckPrompt(g, failVerify, 3, 10);
    expect(p).toContain("#2");
    expect(p).toContain("3/10");
    expect(p).toContain("FAIL: expected 2 to be 3");
    expect(p).toContain("did not pass");
    expect(p).toContain("Do not declare the goal done");
    expect(p).toContain("• a");
    expect(p).toContain("• b");
  });
  it("on a passing check: the measured state and the summarize+complete directive", () => {
    const p = renderCheckPrompt(g, okVerify, 1, 10);
    expect(p).toContain("all green");
    expect(p).toContain("passed");
    expect(p).toContain("Summarize the final state");
    expect(p).toContain("complete");
  });
  it("reports a timeout on a failed check", () => {
    const p = renderCheckPrompt(g, timedOutVerify, 1, 10);
    expect(p).toContain("timed out");
  });
});

describe("renderGoalReminder", () => {
  it("includes the objective and each criterion", () => {
    const text = renderGoalReminder(goal({ objective: "ship it", criteria: ["tests green", "lint clean"] }));
    expect(text).toContain("GOAL REMINDER");
    expect(text).toContain("ship it");
    expect(text).toContain("tests green");
    expect(text).toContain("lint clean");
  });
});

describe("renderGoalCall", () => {
  it("shows the objective for set, and the action for terminal calls", () => {
    expect(renderGoalCall({ action: "set", objective: "fix the bug" }, THEME)).toContain("fix the bug");
    expect(renderGoalCall({ action: "complete" }, THEME)).toContain("complete");
    expect(renderGoalCall({ action: "blocked" }, THEME)).toContain("blocked");
    expect(renderGoalCall({}, THEME)).toContain("goal");
  });
});

describe("renderGoalResult", () => {
  it("renders the in-flight check when running is set (onUpdate partial)", () => {
    const d: GoalDetails = { goal: goal({ verify: "npm test" }), running: "baseline check: npm test · 45s" };
    expect(renderGoalResult(d, { expanded: false }, THEME)).toContain("npm test");
    expect(renderGoalResult(d, { expanded: false }, THEME)).toContain("baseline check");
  });
  it("shows status and objective collapsed, criteria when expanded", () => {
    const d: GoalDetails = { goal: goal({ criteria: ["a", "b"] }) };
    const collapsed = renderGoalResult(d, { expanded: false }, THEME);
    expect(collapsed).toContain("goal #1");
    expect(collapsed).toContain("active");
    expect(collapsed).toContain("fix the failing test");
    expect(collapsed).not.toContain("• a");

    const expanded = renderGoalResult(d, { expanded: true }, THEME);
    expect(expanded).toContain("• a");
    expect(expanded).toContain("• b");
  });
  it("renders errors and the no-goal state", () => {
    expect(renderGoalResult({ goal: null, error: "boom" }, { expanded: false }, THEME)).toContain("boom");
    expect(renderGoalResult({ goal: null }, { expanded: false }, THEME)).toContain("no goal");
  });
});

describe("scanGoalState / lastGoalSnapshot", () => {
  it("returns the newest valid goal snapshot", () => {
    const branch = [goalState(goal({ id: 1 })), goalState(goal({ id: 2, objective: "newer" }))];
    expect(lastGoalSnapshot(branch)).toEqual(goal({ id: 2, objective: "newer" }));
  });
  it("returns null when there is no goal state entry", () => {
    expect(lastGoalSnapshot([{ type: "message", message: { role: "user", content: "hi" } }])).toBeNull();
    expect(lastGoalSnapshot([])).toBeNull();
  });
  it("skips malformed state entries, keeping the newest valid one", () => {
    const branch = [
      goalState(goal({ id: 1 })),
      // A goal.state entry with invalid data must fall to the prior state...
      { type: "custom", customType: "goal.state", data: { goal: "bad" } },
      // ...and another extension's custom entry must never be read as goal state.
      { type: "custom", customType: "other.state", data: { goal: goal({ id: 9 }) } },
    ];
    expect(lastGoalSnapshot(branch)).toEqual(goal({ id: 1 }));
  });
  it("derives the loop latch: explicit flag wins, else only paused, else none", () => {
    expect(scanGoalState([goalState(goal({ id: 1, status: "paused" }))]).sessionStopped).toBe(true);
    expect(scanGoalState([goalState(goal({ id: 1, status: "blocked" }))]).sessionStopped).toBe(false);
    expect(scanGoalState([goalState(goal({ id: 1, status: "complete" }))]).sessionStopped).toBe(false);
    expect(scanGoalState([goalState(goal({ id: 1, status: "active" }))]).sessionStopped).toBe(false);
    // An explicit flag overrides the status derivation in both directions.
    expect(scanGoalState([goalState(goal({ id: 1, status: "active" }), true)]).sessionStopped).toBe(true);
    expect(scanGoalState([goalState(goal({ id: 1, status: "blocked" }), false)]).sessionStopped).toBe(false);
    // No state entry at all: nothing derived — adoption falls back to armed.
    expect(scanGoalState([{ type: "compaction" }]).sessionStopped).toBeUndefined();
  });
  it("reports a compaction after the snapshot as hiding the goal", () => {
    const branch = [goalState(goal({ id: 1 })), { type: "compaction" }];
    expect(scanGoalState(branch).hiddenByCompaction).toBe(true);
  });
  it("does not hide the goal when a reminder carrier follows the compaction", () => {
    const branch = [
      goalState(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
    ];
    expect(scanGoalState(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide the goal when a turn-end check carrier follows the compaction", () => {
    // A goal.check message after a compaction restates the objective too, so it
    // is a carrier like the reminder — no redundant re-injection on resume.
    const branch = [
      goalState(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_CHECK_TYPE, content: "GOAL CHECK" },
    ];
    expect(scanGoalState(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide a non-active goal even after compaction", () => {
    const branch = [goalState(goal({ id: 1, status: "paused" })), { type: "compaction" }];
    expect(scanGoalState(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide the goal when the compaction is before the snapshot", () => {
    const branch = [{ type: "compaction" }, goalState(goal({ id: 1 }))];
    expect(scanGoalState(branch).hiddenByCompaction).toBe(false);
  });
  it("lets only the newest compaction after the snapshot decide", () => {
    // A reminder carrier after the second compaction clears the hide.
    const withCarrier = [
      goalState(goal({ id: 1 })),
      { type: "compaction" },
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
    ];
    expect(scanGoalState(withCarrier).hiddenByCompaction).toBe(false);
    // No carrier after the second compaction: still hidden.
    const noCarrier = [goalState(goal({ id: 1 })), { type: "compaction" }, { type: "compaction" }];
    expect(scanGoalState(noCarrier).hiddenByCompaction).toBe(true);
    // A carrier after only the first compaction does not clear the second.
    const staleCarrier = [
      goalState(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
      { type: "compaction" },
    ];
    expect(scanGoalState(staleCarrier).hiddenByCompaction).toBe(true);
  });
});

describe("validateVerify", () => {
  it("accepts a real command and trims it", () => {
    const { verify, error } = validateVerify("  npm test  ");
    expect(error).toBeUndefined();
    expect(verify).toBe("npm test");
  });
  it("accepts a chained command", () => {
    expect(validateVerify("npm run typecheck && npm test").verify).toBe("npm run typecheck && npm test");
  });
  it("returns empty when omitted", () => {
    expect(validateVerify(undefined)).toEqual({});
  });
  it("rejects non-strings and empty/whitespace commands", () => {
    expect(validateVerify(42).error).toContain("string");
    expect(validateVerify("   ").error).toContain("non-empty");
  });
  it("rejects no-op commands that always pass", () => {
    for (const bad of ["true", ":", "exit 0", "true ", "  :  "]) {
      expect(validateVerify(bad).error).toContain("no-op");
    }
  });
  it("rejects oversized commands", () => {
    expect(validateVerify("x".repeat(501)).error).toContain("exceeds");
  });
  it("does not flag legitimate commands that merely contain the word 'true'", () => {
    expect(validateVerify("echo true").error).toBeUndefined();
    expect(validateVerify("npm test --if true").error).toBeUndefined();
  });
});

describe("parseVerifyTimeoutMs", () => {
  it("defaults to fifteen minutes — verify scripts run build+test suites", () => {
    // Pinned: two minutes killed real verifies and made every long check read
    // as a failure. Raise/lower deliberately, with this test in the diff.
    expect(VERIFY_TIMEOUT_MS_DEFAULT).toBe(900_000);
  });
  it("defaults on missing, empty, and invalid values", () => {
    expect(parseVerifyTimeoutMs(undefined)).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
    expect(parseVerifyTimeoutMs("  ")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
    expect(parseVerifyTimeoutMs("abc")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
    expect(parseVerifyTimeoutMs("0")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
    expect(parseVerifyTimeoutMs("-5")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
  });
  it("parses a valid millisecond value", () => {
    expect(parseVerifyTimeoutMs("30000")).toBe(30000);
  });
  it("clamps absurd values to the default", () => {
    expect(parseVerifyTimeoutMs("999999999999")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
    expect(parseVerifyTimeoutMs("999")).toBe(VERIFY_TIMEOUT_MS_DEFAULT);
  });
});

describe("runVerify", () => {
  it("resolves ok on exit 0 with captured output", async () => {
    const r = await runVerify("echo hello", { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("hello");
  });
  it("resolves not ok on a non-zero exit with the exit code and output", async () => {
    const r = await runVerify("echo boom; exit 3", { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("boom");
  });
  it("times out a long command and kills it", async () => {
    const start = Date.now();
    const r = await runVerify("sleep 30", { timeoutMs: 80 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("resolves as aborted without spawning when the signal is already aborted", async () => {
    const start = Date.now();
    const r = await runVerify("sleep 30", { timeoutMs: 5000, signal: AbortSignal.abort() });
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000); // no spawn, no timeout wait
  });
  it("kills a running verify and resolves as aborted when the signal fires", async () => {
    const start = Date.now();
    const ctrl = new AbortController();
    const p = runVerify("sleep 30", { timeoutMs: 5000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000); // the abort, not the timeout, ended it
  });
  it("never passes a verify that backgrounds its work — leftovers are killed and reported", async () => {
    const start = Date.now();
    // The shell exits 0 instantly; the redirected sleep keeps running in the
    // group. A shell-exit verdict would complete a goal whose check never ran.
    const r = await runVerify("sleep 30 >/dev/null 2>&1 &", { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(0); // the shell did exit 0 — and it still doesn't pass
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toContain("background");
    expect(Date.now() - start).toBeLessThan(5000); // reported at shell exit, not at the timeout
  });
  it("never passes a verify that backgrounds work with inherited stdio — the shell's exit is not the work's verdict", async () => {
    // The shell exits 0 instantly; the backgrounded sleep keeps the inherited
    // pipes open, so `close` fires only when it ends — the exit→close gap gives
    // it away and the shell's 0 must not count as the check's result.
    const r = await runVerify("sleep 0.5 &", { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.spawnError).toContain("background");
  });
  it("kills the verify's whole process tree on abort", async () => {
    const marker = `${tmpdir()}/goal-verify-tree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`;
    const ctrl = new AbortController();
    // `$$` is the spawned shell's pid — the leader of the verify's process
    // group; the sleep is a group member that must die with the abort.
    const p = runVerify(`echo $$ > ${marker}; sleep 30`, { timeoutMs: 5000, signal: ctrl.signal });
    let pgid = 0;
    await vi.waitFor(() => {
      pgid = Number(readFileSync(marker, "utf8").trim());
      expect(Number.isInteger(pgid)).toBe(true);
    });
    ctrl.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    await vi.waitFor(() => {
      // ESRCH once every group member (shell + sleep) is gone.
      expect(() => process.kill(-pgid, 0)).toThrow();
    });
  });
  it("caps very large output to a tail", async () => {
    const r = await runVerify(`python3 -c "print('x' * 100000)" || node -e "console.log('x'.repeat(100000))"`, {
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(4096 + 20);
    expect(r.output).toContain("(truncated)");
  });
});

describe("listenForTerminalInput", () => {
  it("forwards every key without consuming it, and detaching stops delivery", () => {
    const handlers = new Set<(data: string) => unknown>();
    const ui = {
      onTerminalInput: (h: (data: string) => unknown) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    };
    const seen: string[] = [];
    const detach = listenForTerminalInput(ui as never, (data) => seen.push(data));
    expect(handlers).toHaveLength(1);
    // Capture what the wrapped handler RETURNS: pi-tui dispatches extension
    // input listeners before the focused component, so a non-undefined result
    // (consume/rewrite) would eat the key pi's own handling expects to see.
    const results = [...handlers].map((h) => h("\x1b"));
    expect(seen).toEqual(["\x1b"]);
    expect(results).toEqual([undefined]); // observe-only — pi still sees the key
    detach();
    expect(handlers).toHaveLength(0);
    [...handlers].map((h) => h("a"));
    expect(seen).toEqual(["\x1b"]); // detached — nothing delivered
  });

  it("is a no-op without an interactive UI", () => {
    const fire = () => {
      throw new Error("must not fire");
    };
    listenForTerminalInput(undefined, fire)();
    listenForTerminalInput({} as never, fire)(); // no onTerminalInput method
  });
});

describe("registerGoalTool — schema", () => {
  it("is a flat root object schema: OpenAI-compatible providers cannot key arguments off a rootless union", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)! as { parameters?: Record<string, unknown> };
    // The observed failure: a top-level anyOf (from Type.Union) made GLM via
    // zai emit empty arguments, which pi parsed to {} — silently.
    expect(tool.parameters?.anyOf).toBeUndefined();
    expect(tool.parameters?.type).toBe("object");
    expect(tool.parameters?.properties).toHaveProperty("action");
    expect(tool.parameters?.properties).toHaveProperty("objective");
  });

  it("errors loudly on a missing action instead of falling through to a status readout", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", {})) as { content: Array<{ type: string; text: string }> };
    expect(r.content[0].text).toContain('action must be one of "set", "complete", or "blocked"');
  });
});

describe("registerGoalTool — verify", () => {
  it("rejects a no-op verify at set time", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", { action: "set", objective: "ship", verify: "true" })) as {
      details: GoalDetails;
      content: Array<{ type: string; text: string }>;
    };
    expect(r.details.goal).toBeNull();
    expect(r.content[0].text).toContain("no-op");
  });

  it("stores the verify command and reports the failing baseline at set", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", { action: "set", objective: "ship", verify: "npm test" })) as {
      details: GoalDetails;
      content: Array<{ type: string; text: string }>;
    };
    expect(r.details.goal!.verify).toBe("npm test");
    expect(r.content[0].text).toContain("exiting 0");
    expect(r.content[0].text).toContain("currently fails");
  });

  it("warns when the verify already passes at set time", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => okVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", { action: "set", objective: "ship", verify: "npm test" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(r.content[0].text).toContain("already passes");
  });

  it("reports a timed-out baseline at set time", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => timedOutVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", { action: "set", objective: "ship", verify: "npm test" })) as {
      details: GoalDetails;
      content: Array<{ type: string; text: string }>;
    };
    expect(r.details.goal?.verify).toBe("npm test");
    expect(r.content[0].text).toContain("the check timed out");
  });

  it("returns immediately when the run's signal is already aborted at set time", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: () => new Promise<VerifyResult>(() => {}) }); // ignores signals
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute(
      "1",
      { action: "set", objective: "ship", verify: "npm test" },
      AbortSignal.abort(),
    )) as { details: GoalDetails; content: Array<{ type: string; text: string }> };
    expect(r.content[0].text).toContain("aborted");
    expect(r.details.goal?.status).toBe("active");
    expect(r.details.goal?.verify).toBe("npm test");
  });

  it("ticks tool-row progress while a slow verify runs", async () => {
    vi.useFakeTimers();
    try {
      const { pi, tools } = makePi();
      let release!: (r: VerifyResult) => void;
      registerGoalTool(pi, { verifyRunner: () => new Promise<VerifyResult>((res) => (release = res)) });
      const updates: Array<{ details?: GoalDetails }> = [];
      const tool = tools.get(GOAL_TOOL_NAME)!;
      const p = tool.execute("1", { action: "set", objective: "ship", verify: "npm test" }, undefined, (u) =>
        updates.push(u as never),
      );
      // Immediate emit at t=0, then one per 5s tick — the "still alive" signal.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates[2]!.details?.running).toContain("npm test");
      release(failVerify);
      const r = (await p) as { content: Array<{ type: string; text: string }> };
      expect(r.content[0].text).toContain("currently fails");
      // Teardown: once the call settles, the ticker stops — no late partials.
      const settledCount = updates.length;
      await vi.advanceTimersByTimeAsync(11_000);
      expect(updates.length).toBe(settledCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams running progress onto the tool row during the set preflight", async () => {
    const { pi, tools } = makePi();
    let release!: (r: VerifyResult) => void;
    registerGoalTool(pi, {
      verifyRunner: () => new Promise<VerifyResult>((res) => (release = res)),
    });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const updates: Array<{ content: Array<{ type: string; text: string }>; details: GoalDetails }> = [];
    const p = tool.execute("1", { action: "set", objective: "ship", verify: "npm test" }, undefined, (u) =>
      updates.push(u as never),
    );
    release(failVerify);
    const r = (await p) as { content: Array<{ type: string; text: string }> };
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].details.running).toContain("npm test");
    expect(updates[0].content[0].text).toContain("baseline check");
    expect(r.content[0].text).toContain("currently fails");
  });

  it("aborts the set preflight promptly even when the runner ignores the signal", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: () => new Promise<VerifyResult>(() => {}) });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const ctrl = new AbortController();
    const p = tool.execute("1", { action: "set", objective: "ship", verify: "npm test" }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 30);
    const r = (await p) as { details: GoalDetails; content: Array<{ type: string; text: string }> };
    // The goal itself stands — only the baseline was cut short.
    expect(r.details.goal?.status).toBe("active");
    expect(r.details.goal?.verify).toBe("npm test");
    expect(r.content[0].text).toContain("aborted");
  });

  it("forwards the abort signal to the verify runner", async () => {
    const { pi, tools } = makePi();
    let captured: { signal?: AbortSignal } | undefined;
    registerGoalTool(pi, {
      verifyRunner: async (_cmd, opts) => {
        captured = opts;
        return failVerify;
      },
    });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const ctrl = new AbortController();
    await tool.execute("1", { action: "set", objective: "ship", verify: "npm test" }, ctrl.signal);
    expect(captured?.signal).toBe(ctrl.signal);
  });

  it("aborts the completion check, leaving the goal active", async () => {
    const { pi, tools } = makePi();
    let call = 0;
    registerGoalTool(pi, {
      verifyRunner: () => (call++ === 0 ? Promise.resolve(failVerify) : new Promise<VerifyResult>(() => {})),
    });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix", criteria: ["x"], verify: "npm test" });
    const ctrl = new AbortController();
    const p = tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 30);
    const r = (await p) as { details: GoalDetails; content: Array<{ type: string; text: string }> };
    expect(r.details.goal?.status).toBe("active");
    expect(r.content[0].text).toContain("NOT completed");
    expect(r.content[0].text).toContain("aborted");
  });

  it("rejects complete when the verify fails, returning its output", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix", criteria: ["tests green"], verify: "npm test" });
    const r = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "fixed it",
      evidence: ["green"],
    })) as { details: GoalDetails; content: Array<{ type: string; text: string }> };
    expect(r.details.goal!.status).toBe("active");
    expect(r.details.error).toContain("verify exited 1");
    expect(r.content[0].text).toContain("expected 2 to be 3");
  });

  it("completes when the verify passes", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => okVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix", criteria: ["tests green"], verify: "npm test" });
    const r = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "fixed it",
      evidence: ["green"],
    })) as {
      details: GoalDetails;
    };
    expect(r.details.goal!.status).toBe("complete");
  });

  it("rejects complete when the verify times out", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => timedOutVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix", criteria: ["x"], verify: "npm test" });
    const r = (await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] })) as {
      details: GoalDetails;
    };
    expect(r.details.goal!.status).toBe("active");
    expect(r.details.error).toContain("timed out");
  });

  it("completes a goal with no verify on the structural gate alone", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix", criteria: ["x"] });
    const r = (await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] })) as {
      details: GoalDetails;
    };
    expect(r.details.goal!.status).toBe("complete");
  });

  it("carries verify through the branch snapshot", () => {
    const { goal: scanned } = scanGoalState([goalState(goal({ verify: "npm test" }))]);
    expect(scanned!.verify).toBe("npm test");
  });
});

describe("registerGoalTool", () => {
  it("sets a goal, snapshots it into details, and activates the tool", async () => {
    const { pi, tools, activeTools } = makePi();
    registerGoalTool(pi);

    expect(activeTools).not.toContain(GOAL_TOOL_NAME);
    const result = (await tools.get(GOAL_TOOL_NAME)!.execute("1", {
      action: "set",
      objective: "ship the smaller fix first",
      criteria: ["tests green", "lint clean"],
    })) as { content: Array<{ type: string; text: string }>; details: GoalDetails };

    expect(result.content[0].text).toContain("Goal #1 set");
    expect(result.details.goal).toMatchObject({
      id: 1,
      objective: "ship the smaller fix first",
      criteria: ["tests green", "lint clean"],
      status: "active",
    });
    expect(typeof result.details.goal!.startedAt).toBe("number");
    expect(activeTools).toContain(GOAL_TOOL_NAME);
  });

  it("completes a goal only with valid per-criterion evidence", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix bug", criteria: ["tests green", "lint clean"] });

    // Missing evidence for the second criterion is rejected; state is unchanged.
    const rejected = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "done",
      evidence: ["tests passed"],
    })) as { details: GoalDetails };
    expect(rejected.details.error).toContain('"lint clean"');
    expect(rejected.details.goal!.status).toBe("active");

    // A stale id is rejected even with full evidence.
    const stale = (await tool.execute("3", {
      action: "complete",
      goalId: 99,
      summary: "done",
      evidence: ["t", "l"],
    })) as { details: GoalDetails };
    expect(stale.details.error).toContain("stale goal id");

    // Valid completion marks the goal complete.
    const ok = (await tool.execute("4", {
      action: "complete",
      goalId: 1,
      summary: "fixed the bug",
      evidence: ["test suite green", "eslint clean"],
    })) as { details: GoalDetails };
    expect(ok.details.goal!.status).toBe("complete");
  });

  it("blocks a goal with a reason and rejects blocking a stale or non-active goal", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "migrate db" });

    const blocked = (await tool.execute("2", { action: "blocked", goalId: 1, reason: "needs prod credentials" })) as {
      details: GoalDetails;
    };
    expect(blocked.details.goal!.status).toBe("blocked");
    expect(blocked.details.goal!.blockedReason).toBe("needs prod credentials");

    // A blocked goal cannot be completed.
    const complete = (await tool.execute("3", {
      action: "complete",
      goalId: 1,
      summary: "done",
      evidence: ["migrated"],
    })) as { details: GoalDetails };
    expect(complete.details.error).toContain("not active");
  });

  it("reconstructs the goal from the session branch and resumes the id sequence", async () => {
    const { pi, tools, events } = makePi();
    registerGoalTool(pi);

    fire(events, "session_start", sessionCtx([goalState(goal({ id: 7, objective: "resumed" }))]));

    // The tool is re-activated for an unfinished goal.
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const next = (await tool.execute("1", { action: "set", objective: "next" })) as { details: GoalDetails };
    expect(next.details.goal!.id).toBe(8); // resumes after the reconstructed id
  });

  it("does not re-activate the tool for a completed goal on resume", async () => {
    const { pi, events, activeTools } = makePi();
    registerGoalTool(pi);
    fire(events, "session_start", sessionCtx([goalState(goal({ id: 3, status: "complete" }))]));
    expect(activeTools).not.toContain(GOAL_TOOL_NAME);
  });

  it("reminds on the next turn after a compaction hid the goal", async () => {
    const { pi, tools, events } = makePi();
    registerGoalTool(pi);
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "fix bug" });

    fire(events, "session_compact");
    const reminder = fire(events, "before_agent_start") as { message: { customType: string; content: string } };
    expect(reminder.message.customType).toBe(GOAL_REMINDER_TYPE);
    expect(reminder.message.content).toContain("fix bug");
    // Consumed: the next turn is quiet again.
    expect(fire(events, "before_agent_start")).toBeUndefined();
  });

  it("re-injects mid-turn via steer when a compaction hides the goal in an active run", async () => {
    const { pi, tools, events } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "ship it" });

    const sendMessage = vi.fn();
    pi.sendMessage = sendMessage;

    // Compaction during an active (non-idle) turn re-injects immediately, no new turn.
    fire(events, "session_compact", { isIdle: () => false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as unknown as [
      { customType: string; content: string; display: boolean },
      { deliverAs: string; triggerTurn: boolean },
    ];
    expect(msg.customType).toBe(GOAL_REMINDER_TYPE);
    expect(msg.content).toContain("GOAL REMINDER");
    expect(msg.content).toContain("ship it");
    expect(msg.display).toBe(false);
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: false });

    // Already re-injected this turn: no redundant reminder on the next turn.
    expect(fire(events, "before_agent_start")).toBeUndefined();
  });

  it("does not re-arm a reminder on compaction for a non-active goal", async () => {
    const { pi, tools, events } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "ship it" });
    await tool.execute("2", { action: "blocked", goalId: 1, reason: "stuck" });

    fire(events, "session_compact", { isIdle: () => true });
    expect(fire(events, "before_agent_start")).toBeUndefined();
  });

  it("re-adopts goal state from the branch on session_tree, not only session_start", async () => {
    const { pi, tools, events } = makePi();
    registerGoalTool(pi);
    const branch = [goalState(goal({ id: 5, objective: "carried over" }))];
    fire(events, "session_tree", sessionCtx(branch));

    const result = (await tools.get(GOAL_TOOL_NAME)!.execute("1", {
      action: "complete",
      goalId: 5,
      summary: "done",
      evidence: ["ok"],
    })) as { details: GoalDetails };
    expect(result.details.goal?.id).toBe(5);
    expect(result.details.goal?.status).toBe("complete");
  });

  it("the turn-end check re-engages with the measured state and continues", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let check = failVerify;
    registerGoalTool(pi, { maxContinuations: 10, verifyRunner: async () => check });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    // Three settles → three hidden re-engagements, numbered 1/10, 2/10, 3/10.
    for (let i = 0; i < 3; i++) {
      expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    }
    expect(sentCustom).toHaveLength(3);
    const first = sentCustom[0] as { msg: { customType: string; content: string; display: boolean }; opts: unknown };
    expect(first.msg.customType).toBe(GOAL_CHECK_TYPE);
    expect(first.msg.content).toContain("1/10");
    expect((sentCustom[1] as { msg: { content: string } }).msg.content).toContain("2/10");
    expect((sentCustom[2] as { msg: { content: string } }).msg.content).toContain("3/10");
    expect(first.msg.content).toContain("ship it");
    expect(first.msg.content).toContain("did not pass");
    expect(first.msg.content).toContain("FAIL: expected 2 to be 3"); // the check's measured output
    expect(first.msg.display).toBe(true);
    expect(first.opts).toEqual({ deliverAs: "followUp" });

    // Once the check passes and the goal is completed, the loop stops.
    check = okVerify;
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(3);
  });

  it("defers the settle check while background tasks run, then checks at the first calm settle", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    const gpu: BgTask = { id: "t-1", name: "needle 9B", kind: "bash", state: "running", startedAt: 0 };
    const agent: BgTask = { id: "t-2", name: "reviewer", kind: "subagent", state: "running", startedAt: 1 };
    let running: BgTask[] = [gpu, agent];
    let calls = 0;
    registerGoalTool(pi, {
      maxContinuations: 10,
      runningTasks: () => running,
      verifyRunner: async () => {
        calls += 1;
        return failVerify;
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });
    expect(calls).toBe(1); // the set-time preflight still runs — tasks defer only the settle check

    // Settles while tasks run: the turn is only temporarily done (each
    // completion wake re-engages the agent), so no check, no continuation,
    // no follow-up — just a footer saying why, announced once per park.
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("check held"));
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1); // once per park, not per settle
    expect(calls).toBe(1);
    expect(sentCustom).toHaveLength(0);
    expect(setStatus).toHaveBeenCalledWith("goal", "goal · holding check — 2 background tasks running");

    // One task left: singular footer.
    running = [gpu];
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith("goal", "goal · holding check — 1 background task running");

    // Last wake re-engaged the agent; its settle is calm — the check runs,
    // and the deferrals burned no budget (numbered 1/10, not 4/10).
    running = [];
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(calls).toBe(2);
    expect(sentCustom).toHaveLength(1);
    expect((sentCustom[0] as { msg: { content: string } }).msg.content).toContain("1/10");

    // A fresh park (a check ran in between) announces again.
    running = [gpu];
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);

    // A model-set goal while still parked re-announces too: setGoal must
    // clear the flag, or goal #2's whole park would ride goal #1's notice.
    running = [gpu, agent];
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "set", objective: "ship v2", verify: "npm test" });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("a deferral at the continuation cap defers too — no budget burned, no judge consulted", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    const gpu: BgTask = { id: "t-1", name: "gate", kind: "bash", state: "running", startedAt: 0 };
    let running: BgTask[] = [];
    const assess = vi.fn(() => undefined);
    registerGoalTool(pi, {
      maxContinuations: 1,
      progressJudge: { assess },
      runningTasks: () => running,
      verifyRunner: async () => failVerify,
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    // Calm settle: continuation 1/1 — the budget is now spent.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);

    // At the cap, but a task is running: defer (the cap decision belongs to a
    // calm settle — the judge would read a half-finished state otherwise).
    running = [gpu];
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(assess).not.toHaveBeenCalled();
    expect(sentCustom).toHaveLength(1);

    // Calm again: the judge decides now (no opinion → fail closed to the stop).
    running = [];
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(assess).toHaveBeenCalledTimes(1);
    expect(ctx.ui!.notify).toHaveBeenCalledWith(expect.stringContaining("stopping"));
  });

  it("reads the real shared superbash registry through the default seam", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    // No runningTasks injected: the default resolution must find the registry
    // the subagents extension publishes — the production wiring.
    publishSharedTaskRegistry(createTaskRegistry());
    try {
      registerGoalTool(pi, { maxContinuations: 10, verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

      const id = getSharedTaskRegistry()!.adopt({ name: "gpu battery", kind: "bash", kill: () => {} });
      expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // deferred via the real registry
      expect(sentCustom).toHaveLength(0);

      getSharedTaskRegistry()!.complete(id, { ok: true, text: "exited 0" }); // the wake re-engages the agent
      expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // check runs
      expect(sentCustom).toHaveLength(1);

      // The default seam reads the registry per event, not at registration:
      // a re-published registry (reload) must gate the very next settle.
      publishSharedTaskRegistry(createTaskRegistry());
      const fresh = getSharedTaskRegistry()!;
      const freshId = fresh.adopt({ name: "reviewer", kind: "subagent", kill: () => {} });
      expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // deferred on the fresh registry
      fresh.complete(freshId, { ok: true, text: "done" });
      expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
      expect(sentCustom).toHaveLength(2);
    } finally {
      // Reset for later tests in this file that use the default seam.
      publishSharedTaskRegistry(createTaskRegistry());
    }
  });

  it("resolves (does not reject) when the runner throws at set or complete", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, {
      verifyRunner: async () => {
        throw new Error("boom");
      },
    });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const set = (await tool.execute("1", { action: "set", objective: "ship", verify: "npm test" })) as {
      details: GoalDetails;
      content: Array<{ type: string; text: string }>;
    };
    expect(set.details.goal?.verify).toBe("npm test");
    expect(set.content[0].text).toContain("could not run");
    expect(set.content[0].text).toContain("boom");

    const done = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "done",
      evidence: ["ok"],
    })) as { details: GoalDetails; content: Array<{ type: string; text: string }> };
    expect(done.details.goal?.status).toBe("active");
    expect(done.content[0].text).toContain("could not run: boom");
  });

  it("the kill key (alt+x) aborts the settle check; Esc and editing keys do not", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    // Production shape: no ctx.signal at this boundary — only the raw-input hook.
    const handlers = new Set<(data: string) => unknown>();
    const ctx = {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        onTerminalInput: (h: (data: string) => unknown) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
      },
    } as unknown as ExtensionContext;
    const press = (data: string) => {
      for (const h of [...handlers]) h(data);
    };
    let settleSignal: AbortSignal | undefined;
    let started!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let call = 0;
    registerGoalTool(pi, {
      maxContinuations: 10,
      verifyRunner: (_cmd, opts) => {
        call += 1;
        if (call === 1) return Promise.resolve(failVerify); // set preflight
        if (call === 2) {
          // Honor the signal like the real runner does — resolve as aborted on kill.
          settleSignal = opts?.signal;
          started();
          return new Promise<VerifyResult>((resolve) => {
            opts?.signal?.addEventListener(
              "abort",
              () => resolve({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" }),
              { once: true },
            );
          });
        }
        return Promise.resolve(okVerify);
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    const settled = fire(events, "agent_before_settle", ctx);
    await checkStarted; // listener is attached before the runner is called
    expect(handlers).toHaveLength(1);
    // The spinner advertises the escape hatch.
    const setWidget = (ctx.ui as unknown as { setWidget: ReturnType<typeof vi.fn> }).setWidget;
    const factory = setWidget.mock.calls[0]![1] as (
      tui: { requestRender(): void },
      theme: unknown,
    ) => { render(width: number): string[] };
    expect(
      factory({ requestRender: () => {} }, THEME)
        .render(80)
        .join("\n"),
    ).toContain("alt+x aborts");
    // None of the polluted gestures may kill: an arrow key (an escape
    // SEQUENCE), typing, and bare Esc presses — pi's own interrupt and its
    // double-Esc action both live there, and popup dismissals emit Esc too.
    press("\x1b[A");
    press("a");
    press("\x1b");
    press("\x1b"); // pi's double-escape gesture — not ours to interpret
    expect(settleSignal?.aborted).toBe(false);
    press("\x1bx"); // alt+x — the dedicated kill key
    // A deliberate kill re-engages with a notice instead of parking the turn
    // (a real pi-side abort drops the continuation queue anyway).
    expect(await settled).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);
    const notice = sentCustom[0] as { msg: { content: string; details: GoalCheckDetails } };
    expect(notice.msg.content).toContain("aborted before it finished");
    expect(notice.msg.details.aborted).toBe(true);
    expect(notice.msg.details.ok).toBe(false);
    expect(notice.msg.details.exitCode).toBeNull();
    expect(handlers).toHaveLength(0); // detached once the check ends

    // The aborted check burned no budget: the next calm settle runs 1/10.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect((sentCustom[1] as { msg: { content: string } }).msg.content).toContain("1/10");
  });

  it("a live run signal, when pi wires one, still cuts the settle check short", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctrl = new AbortController();
    const handlers = new Set<(data: string) => unknown>();
    const ctx = {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        onTerminalInput: (h: (data: string) => unknown) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
      },
      signal: ctrl.signal,
    } as unknown as ExtensionContext;
    let settleSignal: AbortSignal | undefined;
    let started!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let call = 0;
    registerGoalTool(pi, {
      maxContinuations: 10,
      verifyRunner: (_cmd, opts) => {
        call += 1;
        if (call === 1) return Promise.resolve(failVerify); // set preflight
        settleSignal = opts?.signal;
        started();
        return new Promise<VerifyResult>((resolve) => {
          opts?.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" }),
            { once: true },
          );
        });
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    const settled = fire(events, "agent_before_settle", ctx);
    await checkStarted;
    expect(settleSignal).toBeDefined();
    ctrl.abort(); // pi-side abort, no terminal Esc pressed
    expect(await settled).toEqual({ continue: true }); // notice queued; pi drops it on the real abort
    expect((sentCustom[0] as { msg: { content: string } }).msg.content).toContain("aborted before it finished");
    expect(handlers).toHaveLength(0);
  });

  it("session_shutdown aborts a running verify as an abort, not a fabricated failure", async () => {
    const { pi, events } = makePi();
    registerGoalTool(pi);
    const p = runVerify("sleep 30", { timeoutMs: 5000 });
    fire(events, "session_shutdown"); // reload mid-check
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("an aborted settle check is not cached — the next settle re-measures", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = {
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    } as unknown as ExtensionContext;
    const abortedVerify: VerifyResult = { ok: false, exitCode: null, timedOut: false, aborted: true, output: "" };
    let check: VerifyResult = abortedVerify;
    let calls = 0;
    registerGoalTool(pi, {
      maxContinuations: 10,
      checkEvery: 3, // settle 2 would REUSE a cached check if one survived the abort
      verifyRunner: async () => {
        calls++;
        return check;
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" }); // preflight: call 1

    // Settle 1: fresh (call 2), aborted — re-engages with a cut-short notice.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    check = failVerify;
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // settle 2
    expect(calls).toBe(3); // re-measured — a cached aborted result would leave this at 2
    expect(sentCustom).toHaveLength(2);
    expect((sentCustom[1] as { msg: { content: string } }).msg.content).toContain("1/10"); // no budget burned
  });

  it("/goal stop kills an in-flight verify (the settle-boundary escape hatch)", async () => {
    const { pi, tools, commands } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "ship it", verify: "echo hi" });
    // A live check (the settle loop's verifyRunner is runVerify in production).
    const p = runVerify("sleep 30", { timeoutMs: 5000 });
    await commands.get("goal")!.handler("stop", { ui: { notify: vi.fn() }, mode: "tui" });
    const r = await p;
    expect(r.aborted).toBe(true);
  });

  it("/goal pause also kills an in-flight verify", async () => {
    const { pi, tools, commands } = makePi();
    registerGoalTool(pi);
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "echo hi" });
    const p = runVerify("sleep 30", { timeoutMs: 5000 });
    await commands.get("goal")!.handler("pause", { ui: { notify: vi.fn() }, mode: "tui" });
    const r = await p;
    expect(r.aborted).toBe(true);
  });

  it("/goal stop and /goal pause during a settle check halt the loop — no continuation, no notice", async () => {
    const { pi, tools, events, commands, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    // Re-armed per pending check: the settle fires it, the test then issues
    // the halt and resolves the runner as aborted (what the liveVerifyAborts
    // drain does to a real runVerify).
    let release!: (r: VerifyResult) => void;
    let started!: () => void;
    let checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hangNext = false;
    registerGoalTool(pi, {
      maxContinuations: 10,
      verifyRunner: (_cmd, opts) => {
        if (!hangNext) return Promise.resolve(failVerify); // set preflight etc.
        hangNext = false;
        started();
        return new Promise<VerifyResult>((res) => {
          release = res;
          opts?.signal?.addEventListener(
            "abort",
            () => res({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" }),
            { once: true },
          );
        });
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    // /goal pause while the settle check is pending: the settle must respect
    // the halt — the pre-fix re-engage here would burn one more model turn
    // (carrying a notice that is false while paused) after the user paused.
    hangNext = true;
    let settled = fire(events, "agent_before_settle", ctx);
    await checkStarted;
    await commands.get("goal")!.handler("pause", { ui: { notify: vi.fn() }, mode: "tui" });
    release({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" });
    expect(await settled).toBeUndefined();
    expect(sentCustom).toHaveLength(0);

    // Same for /goal stop, after resuming (stop then blocks the goal; resume
    // re-arms the loop, so stop gets a clean armed state to halt).
    await commands.get("goal")!.handler("resume", { ui: { notify: vi.fn() }, mode: "tui" });
    checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    hangNext = true;
    settled = fire(events, "agent_before_settle", ctx);
    await checkStarted;
    await commands.get("goal")!.handler("stop", { ui: { notify: vi.fn() }, mode: "tui" });
    release({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" });
    expect(await settled).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("session_shutdown during a settle check resolves silently — no continuation outlives the teardown", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let release!: (r: VerifyResult) => void;
    let started!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hangNext = false;
    registerGoalTool(pi, {
      maxContinuations: 10,
      verifyRunner: (_cmd, opts) => {
        if (!hangNext) return Promise.resolve(failVerify); // set preflight
        hangNext = false;
        started();
        return new Promise<VerifyResult>((res) => {
          release = res;
          opts?.signal?.addEventListener(
            "abort",
            () => res({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" }),
            { once: true },
          );
        });
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    // Reload/quit emit session_shutdown without session.abort(), so pi would
    // honor a queued continue — the shutdown drain must suppress it.
    hangNext = true;
    const settled = fire(events, "agent_before_settle", ctx);
    await checkStarted;
    fire(events, "session_shutdown"); // reload mid-check
    release({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" });
    expect(await settled).toBeUndefined();
    expect(sentCustom).toHaveLength(0);

    // The latch must not outlive the teardown: extension closures survive
    // session replacement (new/resume/fork re-run session_start), so an
    // aborted check in the NEXT session must still re-engage.
    fire(events, "session_start", {
      sessionManager: { getBranch: () => [goalState(goal({ id: 1, verify: "npm test" }))] },
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    } as unknown as ExtensionContext);
    hangNext = true;
    const settled2 = fire(events, "agent_before_settle", ctx);
    await checkStarted;
    release({ ok: false, exitCode: null, timedOut: false, aborted: true, output: "" });
    expect(await settled2).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);
    expect((sentCustom[0] as { msg: { content: string } }).msg.content).toContain("aborted before it finished");
  });

  it("shows the checking footer while a tool-call verify runs", async () => {
    const { pi, tools, events } = makePi();
    const setStatus = vi.fn();
    let release!: (r: VerifyResult) => void;
    registerGoalTool(pi, { verifyRunner: () => new Promise<VerifyResult>((res) => (release = res)) });
    fire(events, "session_start", {
      ...sessionCtx([]),
      ui: { notify: vi.fn(), setStatus, setWidget: vi.fn() },
    });
    const p = tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship", verify: "npm test" });
    release(failVerify);
    await p;
    const texts = setStatus.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("checking") && t.includes("npm test"))).toBe(true);
  });

  it("a passing check prompts the agent to summarize and complete", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 10, verifyRunner: async () => okVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    const msg = sentCustom[0] as { msg: { content: string } };
    expect(msg.msg.content).toContain("passed");
    expect(msg.msg.content).toContain("Summarize the final state");
    expect(msg.msg.content).toContain("all green"); // the check's measured output
  });

  it("a goal with no verify does not auto-continue (user-driven)", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it" }); // no verify

    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("a stuck model re-setting the goal cannot defeat the cap", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 2, verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "stuck goal", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // continuation 1
    // Re-setting the goal mid-loop must NOT reset the continuation budget.
    await tool.execute("2", { action: "set", objective: "stuck goal", verify: "npm test" });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // continuation 2
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // at cap → stop + notify
    expect(sentCustom).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("2");

    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // still capped
    expect(sentCustom).toHaveLength(2);
  });

  it("re-arms the continuation loop when an active goal is resumed", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 1, verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "resumable", verify: "npm test" });

    // Drive the loop to the cap so it is stopped.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // continuation 1
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // at cap → stopped
    expect(notify).toHaveBeenCalledTimes(1);

    // Resume re-derives the (still active) goal and re-arms the loop.
    const branch = [goalState(goal({ id: 1, objective: "resumable", verify: "npm test", status: "active" }))];
    fire(events, "session_start", sessionCtx(branch));
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // re-engages with a fresh budget
    expect(sentCustom).toHaveLength(2);
  });

  it("bounds a within-run busy-loop by steering a settle once per run", async () => {
    const { pi, tools, events } = makePi();
    const sendMessage = vi.fn();
    pi.sendMessage = sendMessage;
    registerGoalTool(pi, { maxTurnsPerRun: 3 });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "spin" });

    fire(events, "agent_start");
    fire(events, "turn_end"); // 1
    fire(events, "turn_end"); // 2
    expect(sendMessage).not.toHaveBeenCalled();
    fire(events, "turn_end"); // 3 → steer a settle
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as unknown as [
      { content: string },
      { deliverAs: string; triggerTurn: boolean },
    ];
    expect(msg.content).toContain("Summarize your progress");
    expect(msg.content).toContain("re-engage you with the goal");
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: false });
    fire(events, "turn_end"); // 4 → no second steer this run
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A new run re-arms the per-run bound.
    fire(events, "agent_start");
    fire(events, "turn_end");
    fire(events, "turn_end");
    fire(events, "turn_end"); // 3 → steer again
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("stops auto-continuing at the cap and notifies", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 2, verifyRunner: async () => failVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "stuck goal", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // at cap → stop + notify
    expect(sentCustom).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("2");

    // Stopped: no further continuations on more settles.
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(2);
  });

  it("resets the budget at the cap when the measured state is still progressing", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    // Each check reports a different measured state — the run is visibly moving.
    let calls = 0;
    const outputs = ["geomean 0.33", "geomean 0.47", "geomean 0.55", "geomean 0.62", "geomean 0.71"];
    registerGoalTool(pi, {
      maxContinuations: 2,
      verifyRunner: async () => ({ ...failVerify, output: outputs[Math.min(calls++, outputs.length - 1)] }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "bench goal", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 1/2
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 2/2
    // At the cap the judge sees a changed measured state → reset, not stop.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 1/2 (reset)
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("still progressing");
    expect(notify.mock.calls[0]![0]).toContain("1/3");
    expect(sentCustom).toHaveLength(3);
    // The reset prompt's counter restarts from the new budget.
    const last = sentCustom.at(-1)!.msg as { content: string };
    expect(last.content).toContain("continuation 1/2");
  });

  it("stops for good once the judge resets are exhausted", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let calls = 0;
    registerGoalTool(pi, {
      maxContinuations: 2,
      maxProgressResets: 1,
      verifyRunner: async () => ({ ...failVerify, output: `coverage ${40 + calls++}%` }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 1/2
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 2/2
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // judge reset 1/1
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 2/2 again
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // resets exhausted → stop
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toContain("resets exhausted");
    // Stopped stays stopped even though the measured state keeps changing.
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("stops at the cap when the judge has no opinion (fail closed)", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    const noOpinion: ProgressJudge = { assess: () => undefined };
    registerGoalTool(pi, {
      maxContinuations: 2,
      progressJudge: noOpinion,
      verifyRunner: async () => ({ ...failVerify, output: `coverage ${Date.now()}%` }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // no opinion → stop
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sentCustom).toHaveLength(2);
  });

  it("a throwing progress judge fails closed to the stop", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, {
      maxContinuations: 1,
      progressJudge: {
        assess: () => {
          throw new Error("judge offline");
        },
      },
      verifyRunner: async () => ({ ...failVerify, output: `coverage ${Date.now()}%` }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // throw → stop, not crash
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an async (LLM-style) judge is awaited; its rejection fails closed to the stop", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let mode: "ok" | "reject" = "ok";
    const asyncJudge: ProgressJudge = {
      assess: async (_g, outputs) => {
        if (mode === "reject") throw new Error("llm down");
        return outputs.length >= 2 ? { continueRun: true, reason: "async ok" } : { continueRun: false };
      },
    };
    registerGoalTool(pi, {
      maxContinuations: 2,
      progressJudge: asyncJudge,
      verifyRunner: async () => failVerify,
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    // Async judge approved → the budget resets and the run continues.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(notify.mock.calls[0]![0]).toContain("async ok");

    // A rejecting async judge must fail closed (stop), not crash or dangle a rejection.
    mode = "reject";
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(notify.mock.calls.at(-1)![0]).toContain("progress judge unavailable");
  });

  it("re-setting the goal mid-window cannot buy a reset with a differently-printing verify", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    // Goal A's verify prints one thing forever; goal B's prints another forever.
    let which = "A";
    registerGoalTool(pi, {
      maxContinuations: 2,
      verifyRunner: async () => ({ ...failVerify, output: which === "A" ? "state A" : "state B" }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "A", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 1/2
    // Re-set to goal B: the window is re-scoped to B's baseline, so B's static
    // verify reads as a plateau — no free reset from the A/B output difference.
    which = "B";
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "set", objective: "B", verify: "npm test" });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 2/2 (cap not raised)
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // plateau → stop
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("seeds the budget window with the set-time baseline, so a tiny cap still judges two states", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let calls = 0;
    registerGoalTool(pi, {
      maxContinuations: 1,
      verifyRunner: async () => ({ ...failVerify, output: `coverage ${40 + calls++}%` }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // 1/1
    // Baseline (set preflight) + one continuation ⇒ the judge sees movement.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // reset, continue
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("still progressing");
  });

  it("the cap path does not throw when the settle ctx has no ui (headless)", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = {} as unknown as ExtensionContext; // no ui, as in print mode
    registerGoalTool(pi, { maxContinuations: 1, verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck goal", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // continuation 1
    // At the cap with no ui: the notify must be a no-op, not a throw at the settle boundary.
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined(); // still stopped
    expect(sentCustom).toHaveLength(1);
  });

  it("keeps the footer's elapsed time current after the cap trips", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const uiCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 1, verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck goal", verify: "npm test" });

    // Continuation 1 (also primes uiRef from the settle ctx), then the cap: the
    // cap branch refreshes the footer.
    expect(await fire(events, "agent_before_settle", uiCtx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", uiCtx)).toBeUndefined(); // at cap

    // The goal is still active after the cap, so turn_end keeps the timer ticking.
    fire(events, "turn_end");
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("goal ·"));
  });

  it("checkEvery > 1 reuses the last measured state between fresh checks", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    const runs: string[] = [];
    registerGoalTool(pi, {
      maxContinuations: 10,
      checkEvery: 3,
      verifyRunner: async () => {
        const out = `state ${runs.length}`;
        runs.push(out);
        return { ...failVerify, output: out };
      },
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
    const preflightRuns = runs.length; // the set-time baseline run

    await fire(events, "agent_before_settle", ctx); // 1: fresh (also set preflight ran once)
    await fire(events, "agent_before_settle", ctx); // 2: reused
    await fire(events, "agent_before_settle", ctx); // 3: fresh
    expect(runs.length).toBe(preflightRuns + 2);
    // The reused prompt is marked stale with the measured state's age.
    expect((sentCustom[1]!.msg as { content: string }).content).toContain("1 continuation(s) ago");
    expect((sentCustom[2]!.msg as { content: string }).content).not.toContain("continuation(s) ago");
  });

  it("shows a chat spinner widget while the verify runs, then removes it", async () => {
    const { pi, tools, events } = makePi();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ctx = { ui: { notify: vi.fn(), setStatus, setWidget } } as unknown as ExtensionContext;
    let calls = 0;
    let release: (() => void) | undefined;
    registerGoalTool(pi, {
      // First call is the set-time preflight (resolves immediately); the settle
      // check hangs until released so the spinner state is observable.
      verifyRunner: () =>
        new Promise<VerifyResult>((resolve) => {
          calls += 1;
          if (calls === 1) return resolve(failVerify);
          release = () => resolve(failVerify);
        }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    const settle = fire(events, "agent_before_settle", ctx);
    await new Promise((r) => setTimeout(r, 0)); // let the handler reach the pending verify
    expect(setWidget).toHaveBeenCalledWith("goal-check", expect.any(Function));
    release!();
    expect(await settle).toEqual({ continue: true });
    expect(setWidget).toHaveBeenLastCalledWith("goal-check", undefined);
    expect(setStatus.mock.calls.at(-1)![1]).toMatch(/^goal · /);
  });

  it("a reused (throttled) check never flashes the spinner", async () => {
    const { pi, tools, events } = makePi();
    const setWidget = vi.fn();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 10, checkEvery: 3, verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
    setWidget.mockClear();

    await fire(events, "agent_before_settle", ctx); // fresh
    await fire(events, "agent_before_settle", ctx); // reused
    // Spinner shown and removed once (the fresh check); the reused settle touched it zero times.
    expect(setWidget).toHaveBeenCalledTimes(2);
  });

  it("a throwing verify runner still removes the spinner and restores the footer", async () => {
    const { pi, events } = makePi();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ctx = { ui: { notify: vi.fn(), setStatus, setWidget } } as unknown as ExtensionContext;
    registerGoalTool(pi, {
      verifyRunner: async () => {
        throw new Error("boom");
      },
    });
    // Seed the goal via resume (bypasses the set-time preflight, which would
    // surface the injected throw directly) — the house pattern.
    fire(events, "session_start", sessionCtx([goalState(goal({ id: 1, objective: "x", verify: "npm test" }))]));

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(setWidget).toHaveBeenCalledWith("goal-check", expect.any(Function));
    expect(setWidget).toHaveBeenLastCalledWith("goal-check", undefined);
    expect(setStatus.mock.calls.at(-1)![1]).toMatch(/^goal · /);
  });

  it("re-asserts the footer at run boundaries after pi clears extension statuses", async () => {
    const { pi, tools, events } = makePi();
    const setStatus = vi.fn();
    const ctx = { ui: { notify: vi.fn(), setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    // Prime uiRef from a session ctx (tool execute gets no ctx), as in a real session.
    fire(events, "session_start", {
      ui: { notify: vi.fn(), setStatus },
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext);
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
    expect(setStatus).toHaveBeenCalled();

    setStatus.mockClear();
    // Simulate pi's rebind clearing statuses (resetExtensionUI): nothing re-sets
    // it until the next run boundary — where the extension re-asserts it.
    fire(events, "agent_start", ctx);
    fire(events, "before_agent_start", ctx);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus.mock.calls[0]![1]).toMatch(/^goal · /);
  });

  it("a model-set goal continues the loop in a fresh (goalless) session", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    // A fresh session starts with no goal on the branch — this must NOT disarm
    // the loop for a goal the model sets afterwards (a model set never re-arms).
    fire(events, "session_start", sessionCtx([]));
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);
  });

  it("a re-set invalidates the cached check — goal 2 never sees goal 1's passing state", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let passes = true;
    registerGoalTool(pi, {
      maxContinuations: 10,
      checkEvery: 5, // the modulo would happily serve the stale cached check
      verifyRunner: async () => (passes ? okVerify : failVerify),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "A", verify: "npm test" });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect((sentCustom[0]!.msg as { content: string }).content).toContain("passed");

    // Re-set to a goal whose verify fails: the cache must be dropped, not reused.
    passes = false;
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "set", objective: "B", verify: "npm test" });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect((sentCustom[1]!.msg as { content: string }).content).toContain("did not pass");
  });

  it("a judge-approved reset drops the cached check so window 2 opens with a fresh baseline", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    let n = 0;
    registerGoalTool(pi, {
      maxContinuations: 3,
      checkEvery: 3,
      verifyRunner: async () => ({ ...failVerify, output: `state ${n++}` }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    // Window 1: fresh at 1 (no cache) and 3 (modulo), reused at 2. Cap hits on settle 4.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true }); // cap → judge reset
    expect(notify).toHaveBeenCalledTimes(1); // reset granted
    // Window 2 must run a FRESH check at its first continuation (cache dropped),
    // not reuse window 1's last output — else the judge starves at the next cap.
    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    expect(notify).toHaveBeenCalledTimes(1); // no stop
  });

  it("the turn-end check message is visible and carries structured details for the renderer", async () => {
    const { pi, tools, events, sentCustom, messageRenderers } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
    await fire(events, "agent_before_settle", ctx);

    const msg = sentCustom[0]!.msg as { display: boolean; details: GoalCheckDetails };
    expect(msg.display).toBe(true);
    expect(msg.details.continuation).toBe(1);
    expect(msg.details.ok).toBe(false);
    expect(msg.details.exitCode).toBe(1);
    expect(messageRenderers.has(GOAL_CHECK_TYPE)).toBe(true);
  });

  it("renderCheckMessage: compact row collapsed, measured state expanded", () => {
    const details: GoalCheckDetails = {
      continuation: 15,
      max: 25,
      ok: false,
      exitCode: 1,
      timedOut: false,
      staleContinuations: 2,
      output: "geomean ratio: 0.553",
    };
    const collapsed = renderCheckMessage(details, { expanded: false }, THEME);
    expect(collapsed).toContain("goal check 15/25");
    expect(collapsed).toContain("verify failed (exit 1) — continuing");
    expect(collapsed).toContain("measured 2 turn(s) ago");
    expect(collapsed).not.toContain("geomean");
    const expanded = renderCheckMessage(details, { expanded: true }, THEME);
    expect(expanded).toContain("geomean ratio: 0.553");
    // Passing checks read as summarize-and-complete; aborted checks read as a
    // re-measure notice; missing details degrade to a dim row.
    expect(renderCheckMessage({ ...details, ok: true }, { expanded: false }, THEME)).toContain(
      "verify passed — agent will summarize and complete",
    );
    expect(renderCheckMessage({ ...details, aborted: true }, { expanded: false }, THEME)).toContain(
      "verify aborted — re-measuring next settle",
    );
    expect(renderCheckMessage(undefined, { expanded: false }, THEME)).toContain("goal check");
  });

  it("does not auto-continue a non-active goal", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => okVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "x", verify: "npm test" });
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("does not re-engage after an errored or aborted run", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

    expect(
      await fire(events, "agent_before_settle", ctx, { type: "agent_before_settle", outcome: "error" }),
    ).toBeUndefined();
    expect(
      await fire(events, "agent_before_settle", ctx, { type: "agent_before_settle", outcome: "aborted" }),
    ).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("a throwing verify runner degrades to a failed check instead of rejecting the boundary", async () => {
    const { pi, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, {
      verifyRunner: async () => {
        throw new Error("boom");
      },
    });

    // Seed the goal via resume (bypasses the set-time preflight).
    fire(events, "session_start", sessionCtx([goalState(goal({ id: 1, objective: "x", verify: "npm test" }))]));

    expect(await fire(events, "agent_before_settle", ctx)).toEqual({ continue: true });
    const msg = sentCustom[0] as { msg: { content: string } };
    expect(msg.msg.content).toContain("could not run");
    expect(msg.msg.content).toContain("boom");
  });

  it("shows the footer while active and clears it on completion or block", async () => {
    const { pi, tools, events } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const uiCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => okVerify });

    // Prime uiRef the way a real session does.
    fire(events, "session_start", {
      sessionManager: { getBranch: () => [] },
      ui: { notify, setStatus },
    } as unknown as ExtensionContext);

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("goal ·"));

    // turn_end keeps the timer current during a long run; a settle refreshes it too.
    fire(events, "turn_end");
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("goal ·"));
    await fire(events, "agent_before_settle", uiCtx);
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("goal ·"));

    // Completion clears the footer.
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(setStatus).toHaveBeenLastCalledWith("goal", undefined);
  });

  it("clears the footer when the goal is blocked", async () => {
    const { pi, tools, events } = makePi();
    const setStatus = vi.fn();
    const uiCtx = { ui: { notify: vi.fn(), setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi);
    fire(events, "session_start", {
      sessionManager: { getBranch: () => [] },
      ui: uiCtx.ui,
    } as unknown as ExtensionContext);

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "migrate db" });
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("goal ·"));

    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "blocked", goalId: 1, reason: "stuck" });
    expect(setStatus).toHaveBeenLastCalledWith("goal", undefined);
  });

  it("stays quiet when there is no active goal", () => {
    const { pi, events } = makePi();
    registerGoalTool(pi);
    for (let i = 0; i < 5; i++) expect(fire(events, "before_agent_start")).toBeUndefined();
  });

  it("consults an injected judge and rejects completion it disagrees with", async () => {
    const { pi, tools } = makePi();
    const evaluate = vi.fn(() => ({ complete: false, reason: "no evidence the tests actually ran" }));
    registerGoalTool(pi, { judge: { evaluate } });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix bug", criteria: ["tests green"] });

    const result = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "fixed it",
      evidence: ["ran the tests"],
    })) as { details: GoalDetails };
    expect(evaluate).toHaveBeenCalled();
    expect(result.details.error).toContain("judge");
    expect(result.details.goal!.status).toBe("active");
  });

  it("renders call and result rows from the registered tool", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;

    const call = tool.renderCall!({ action: "set", objective: "fix the bug" } as never, THEME, {} as never);
    expect(renderPlain(call as never)).toContain("fix the bug");

    const result = await tool.execute("1", { action: "set", objective: "fix the bug" });
    const rendered = tool.renderResult!(result as never, { expanded: true } as never, THEME, {} as never);
    expect(renderPlain(rendered as never)).toContain("goal #1");
  });

  it("a kickoff does not resurrect a terminal goal and durably releases its latch", async () => {
    const { pi, tools, commands, entries, sent } = makePi();
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    registerGoalTool(pi, {
      verifyRunner: async () => ({ ok: true, exitCode: 0, timedOut: false, output: "PASS" }),
    });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
    await tools.get(GOAL_TOOL_NAME)!.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "done",
      evidence: ["PASS"],
    });

    // /goal <objective> routes the new goal through the model; it must not
    // resurrect the completed one (re-running its verify, ticking its footer)
    // before the replacement exists — but it DOES durably release the latch so
    // a reload before the set lands cannot re-instate a superseded stop.
    await commands.get("goal")!.handler("next thing", { mode: "headless", ui });
    expect(entries.at(-1)).toMatchObject({
      customType: "goal.state",
      data: { goal: { status: "complete" }, stopped: false },
    });
    expect(sent.at(-1)?.text).toContain("next thing");
    await commands.get("goal")!.handler("status", { mode: "headless", ui });
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("(complete)"));

    // Stop → kickoff: the objective stays blocked (not resurrected), but the
    // latch is released on the branch — the reload-window regression.
    const second = makePi();
    registerGoalTool(second.pi, { verifyRunner: async () => failVerify });
    const sui = { notify: vi.fn(), setStatus: vi.fn() };
    await second.tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "y", verify: "npm test" });
    await second.commands.get("goal")!.handler("stop", { mode: "headless", ui: sui });
    await second.commands.get("goal")!.handler("replacement", { mode: "headless", ui: sui });
    expect(second.entries.at(-1)).toMatchObject({
      customType: "goal.state",
      data: { goal: { status: "blocked" }, stopped: false },
    });

    // Reload before the model's set lands, then set: the new goal must be
    // unlatched (previously the stop re-instated and poisoned the set).
    const fresh = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    registerGoalTool(fresh.pi, { verifyRunner: async () => failVerify });
    const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    fire(fresh.events, "session_start", { ...sessionCtx(second.entries), ui: settleCtx.ui });
    const r = (await fresh.tools.get(GOAL_TOOL_NAME)!.execute("3", {
      action: "set",
      objective: "replacement",
      verify: "npm test",
    })) as { content: Array<{ type: string; text: string }> };
    expect(r.content[0].text).not.toContain("loop is STOPPED");
    expect(await fire(fresh.events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
  });

  it("registers /goal: status view and a model-routed kickoff", async () => {
    const { pi, commands, sent, activeTools } = makePi();
    registerGoalTool(pi);
    const cmd = commands.get("goal")!;
    expect(cmd.description).toContain("goal");

    const notify = vi.fn();
    const ctx = { mode: "headless", ui: { notify } };

    // Status before any goal.
    await cmd.handler("status", ctx);
    expect(notify).toHaveBeenLastCalledWith("No goal.");

    // Starting a goal activates the tool and routes it through the model — the
    // goal is created (and persisted) by the goal tool, not by the command.
    await cmd.handler("implement the retry queue", ctx);
    expect(activeTools).toContain(GOAL_TOOL_NAME);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("implement the retry queue");
    expect(sent[0].text).toContain("goal tool");
    expect(sent[0].opts).toEqual({ deliverAs: "followUp" });

    // The command itself creates no in-memory state: status is still empty until
    // the model sets the goal via the tool.
    await cmd.handler("status", ctx);
    expect(notify).toHaveBeenLastCalledWith("No goal.");
  });

  it("/goal stop halts the loop on an active goal and does nothing without one", async () => {
    const { pi, tools, commands, events, sentCustom } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const cmdCtx = { mode: "headless", ui: { notify, setStatus } };
    const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 10, verifyRunner: async () => failVerify });

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck work", verify: "npm test" });

    // Without stop, settles keep re-engaging the goal.
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);

    await commands.get("goal")!.handler("stop", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("stopped"));
    // The stop marks the goal blocked session-scoped, clears the footer, and halts the loop.
    expect(setStatus).toHaveBeenLastCalledWith("goal", undefined);
    expect(await fire(events, "agent_before_settle", settleCtx)).toBeUndefined();
    expect(sentCustom).toHaveLength(1);

    // Stopping with no active goal is a no-op.
    await commands.get("goal")!.handler("stop", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith("No active or paused goal to stop.");
  });

  it("/goal pause halts the loop, shows a paused footer, and /goal resume re-engages", async () => {
    const { pi, tools, commands, events, sentCustom } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const cmdCtx = { mode: "headless", ui: { notify, setStatus } };
    const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 10, verifyRunner: async () => failVerify });

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck work", verify: "npm test" });

    // One settle binds the UI (uiRef) and shows the loop is live.
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(1);

    // Pause: no further continuations, and the footer says paused (not cleared).
    await commands.get("goal")!.handler("pause", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("paused"));
    expect(setStatus).toHaveBeenLastCalledWith("goal", "goal · paused");
    expect(await fire(events, "agent_before_settle", settleCtx)).toBeUndefined();
    expect(sentCustom).toHaveLength(1);

    // Pausing with no active goal is a no-op.
    await commands.get("goal")!.handler("pause", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith("No active goal to pause.");

    // Resume: the loop runs again and the model is re-engaged with a followUp.
    await commands.get("goal")!.handler("resume", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("resumed"));
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
    expect(sentCustom).toHaveLength(2);

    // Resuming with no paused or stopped goal is a no-op.
    await commands.get("goal")!.handler("resume", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith("No paused or stopped goal to resume.");
  });

  it("the model cannot set, stop, or work a paused goal away from the user", async () => {
    const { pi, tools, commands } = makePi();
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "mine", verify: "npm test" });
    await commands.get("goal")!.handler("pause", { mode: "headless", ui });

    // set is gated like complete/blocked: an unguarded call would replace the
    // paused goal, persist a new snapshot, and wedge /goal resume.
    const r = (await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "set", objective: "sneaky" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(r.content[0].text).toContain("paused by the user");

    // /goal stop accepts a paused goal (strictly stronger than pause).
    await commands.get("goal")!.handler("stop", { mode: "headless", ui });
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("stopped"));
  });

  it("a set while the loop is stopped warns instead of trapping — and /goal resume re-arms the active goal", async () => {
    const { pi, tools, commands, events, sentCustom } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const cmdCtx = { mode: "headless", ui: { notify, setStatus } };
    const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 1, verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "first", verify: "npm test" });

    // Burn the 1-continuation budget and trip the cap: stopped = true, the
    // goal itself stays active — the production trap shape from warp3090.
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", settleCtx)).toBeUndefined();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("still active after"));

    // A model set re-activates a NEW goal (allowed — the cap says "adjust it")
    // but the loop stays dead: both sides must be told, not trapped silently.
    const r = (await tools.get(GOAL_TOOL_NAME)!.execute("2", {
      action: "set",
      objective: "second",
      verify: "npm test",
    })) as { content: Array<{ type: string; text: string }> };
    expect(r.content[0].text).toContain("loop is STOPPED");
    expect(r.content[0].text).toContain("/goal resume");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("loop is stopped"));
    expect(await fire(events, "agent_before_settle", settleCtx)).toBeUndefined(); // still dead
    expect(sentCustom).toHaveLength(1);

    // Recovery: resume accepts an ACTIVE-but-stopped goal (the old guard only
    // took paused, leaving this state unrecoverable short of a new kickoff).
    await commands.get("goal")!.handler("resume", cmdCtx);
    expect(notify).toHaveBeenLastCalledWith("Goal #2 resumed.");
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true }); // re-armed
    expect(sentCustom).toHaveLength(2);
  });

  describe("state persistence across reload", () => {
    // True round trips: mutations land in a fake branch via appendEntry, and a
    // FRESH registration (empty memory) must reconstruct everything from that
    // branch alone — remove the writes or the adoption and these fail.
    const reloadWith = (entries: unknown[]) => {
      const fresh = makePi();
      const notify = vi.fn();
      const setStatus = vi.fn();
      registerGoalTool(fresh.pi, { verifyRunner: async () => failVerify });
      const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
      fire(fresh.events, "session_start", { ...sessionCtx(entries), ui: settleCtx.ui });
      return { fresh, notify, setStatus, settleCtx };
    };

    it("stop survives a reload: the goal stays blocked, no footer, loop down", async () => {
      const { pi, tools, commands, entries } = makePi();
      const ui = { notify: vi.fn(), setStatus: vi.fn() };
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
      await commands.get("goal")!.handler("stop", { mode: "headless", ui });
      expect(ui.notify).toHaveBeenLastCalledWith("Goal #1 stopped.");
      // The durable write: an explicit latch on a blocked goal.
      expect(entries.at(-1)).toMatchObject({
        customType: "goal.state",
        data: { goal: { status: "blocked" }, stopped: true },
      });

      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toBeUndefined();
      expect(re.setStatus).toHaveBeenLastCalledWith("goal", undefined);
      // Adopted, not merely absent: the status command sees the blocked goal.
      await re.fresh.commands.get("goal")!.handler("status", { mode: "headless", ui: re.settleCtx.ui });
      expect(re.notify).toHaveBeenLastCalledWith(expect.stringContaining("(blocked)"));
    });

    it("pause survives a reload and /goal resume re-arms after it", async () => {
      const { pi, tools, commands, entries } = makePi();
      const ui = { notify: vi.fn(), setStatus: vi.fn() };
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
      await commands.get("goal")!.handler("pause", { mode: "headless", ui });

      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toBeUndefined(); // still paused
      await re.fresh.commands.get("goal")!.handler("resume", { mode: "headless", ui: re.settleCtx.ui });
      expect(re.notify).toHaveBeenLastCalledWith("Goal #1 resumed.");
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toEqual({ continue: true });
      expect(re.fresh.sentCustom).toHaveLength(1);
    });

    it("an active goal survives a reload with its loop armed", async () => {
      const { pi, tools, entries } = makePi();
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });

      // Empty memory + this branch must yield a running loop (a broken scan
      // leaves no goal and a silent settle instead).
      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toEqual({ continue: true });
      expect(re.fresh.sentCustom).toHaveLength(1);
    });

    it("a model set while the loop is stopped keeps the latch across a reload", async () => {
      const { pi, tools, commands, entries } = makePi();
      const ui = { notify: vi.fn(), setStatus: vi.fn() };
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "first", verify: "npm test" });
      await commands.get("goal")!.handler("stop", { mode: "headless", ui });

      // The warp3090 shape: the model sets a new goal while the loop is down —
      // the set persists {goal: active #2, stopped: true}.
      const r = (await tools.get(GOAL_TOOL_NAME)!.execute("2", {
        action: "set",
        objective: "second",
        verify: "npm test",
      })) as { content: Array<{ type: string; text: string }> };
      expect(r.content[0].text).toContain("loop is STOPPED");
      expect(entries.at(-1)).toMatchObject({
        customType: "goal.state",
        data: { goal: { id: 2, status: "active" }, stopped: true },
      });

      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toBeUndefined(); // latch survived
      expect(re.setStatus).toHaveBeenLastCalledWith("goal", "goal · halted — /goal resume re-arms");
      await re.fresh.commands.get("goal")!.handler("resume", { mode: "headless", ui: re.settleCtx.ui });
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toEqual({ continue: true });
    });

    it("a terminal goal (model blocked) derives no latch — a later set runs free", async () => {
      // The blocked action persists {goal: blocked} with NO latch. A fresh
      // registration must reconstruct blocked-but-unlatched, so the model's
      // next set behaves exactly as it would without the reload (previously
      // the derived latch poisoned the new goal's state entry).
      const { pi, tools, entries } = makePi();
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "first", verify: "npm test" });
      await tools.get(GOAL_TOOL_NAME)!.execute("2", {
        action: "blocked",
        goalId: 1,
        reason: "user pivoted",
      });
      expect(entries.at(-1)).toMatchObject({ data: { goal: { status: "blocked" } } });
      expect((entries.at(-1) as { data: { stopped?: unknown } }).data.stopped).toBeUndefined();

      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toBeUndefined(); // terminal guard
      // Adoption identity: the blocked goal really was reconstructed (goalSeq
      // resumed from it — the set below creates goal #2, not #1 again).
      await re.fresh.commands.get("goal")!.handler("status", { mode: "headless", ui: re.settleCtx.ui });
      expect(re.notify).toHaveBeenLastCalledWith(expect.stringContaining("(blocked)"));
      const r = (await re.fresh.tools.get(GOAL_TOOL_NAME)!.execute("3", {
        action: "set",
        objective: "second",
        verify: "npm test",
      })) as { content: Array<{ type: string; text: string }> };
      expect(r.content[0].text).toContain("Goal #2 set");
      expect(r.content[0].text).not.toContain("loop is STOPPED");
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toEqual({ continue: true });
    });

    it("blocked and complete survive a reload as terminal states", async () => {
      const { pi, tools, entries } = makePi();
      registerGoalTool(pi, { verifyRunner: async () => failVerify });
      await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
      await tools.get(GOAL_TOOL_NAME)!.execute("2", {
        action: "blocked",
        goalId: 1,
        reason: "user pivoted",
      });

      // Blocked: loop down via the status guard, but the goal tool stays
      // active (blocked ≠ complete) and the state reports terminal.
      const re = reloadWith(entries);
      expect(await fire(re.fresh.events, "agent_before_settle", re.settleCtx)).toBeUndefined();
      expect(re.fresh.activeTools).toContain(GOAL_TOOL_NAME);
      await re.fresh.commands.get("goal")!.handler("status", { mode: "headless", ui: re.settleCtx.ui });
      expect(re.notify).toHaveBeenLastCalledWith(expect.stringContaining("(blocked)"));

      // Complete: same loop-down, but the goal tool is NOT re-activated.
      const done = makePi();
      registerGoalTool(done.pi, {
        verifyRunner: async () => ({ ok: true, exitCode: 0, timedOut: false, output: "PASS" }),
      });
      await done.tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x", verify: "npm test" });
      await done.tools.get(GOAL_TOOL_NAME)!.execute("2", {
        action: "complete",
        goalId: 1,
        summary: "done",
        evidence: ["PASS"],
      });
      const rd = reloadWith(done.entries);
      expect(await fire(rd.fresh.events, "agent_before_settle", rd.settleCtx)).toBeUndefined();
      expect(rd.fresh.activeTools).not.toContain(GOAL_TOOL_NAME);
      await rd.fresh.commands.get("goal")!.handler("status", { mode: "headless", ui: rd.settleCtx.ui });
      expect(rd.notify).toHaveBeenLastCalledWith(expect.stringContaining("(complete)"));
    });
  });

  it("resume re-arms the continuation budget", async () => {
    const { pi, tools, commands, events } = makePi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const cmdCtx = { mode: "headless", ui: { notify, setStatus } };
    const settleCtx = { ui: { notify, setStatus, setWidget: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 1, verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck work", verify: "npm test" });

    // The first settle continues (budget 1/1); the second trips the cap.
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
    expect(await fire(events, "agent_before_settle", settleCtx)).toBeUndefined();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("still active after"));

    // Pause, then resume: the budget was re-armed, so the loop continues.
    await commands.get("goal")!.handler("pause", cmdCtx);
    await commands.get("goal")!.handler("resume", cmdCtx);
    expect(await fire(events, "agent_before_settle", settleCtx)).toEqual({ continue: true });
  });

  it("errors loudly on an unrecognized action string", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi);
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const r = (await tool.execute("1", { action: "pause" })) as {
      content: Array<{ type: string; text: string }>;
      details: { error?: string };
    };
    expect(r.content[0].text).toContain('got "pause"');
    expect(r.details.error).toBe("invalid action");
  });

  it("a paused goal steers every turn away from goal work until resumed", async () => {
    const { pi, tools, commands, events } = makePi();
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck work", verify: "npm test" });
    await commands.get("goal")!.handler("pause", { mode: "headless", ui: { notify: vi.fn(), setStatus: vi.fn() } });

    // While paused: every agent start carries a do-not-work-on-it steer —
    // the model's context still holds the original "work toward it" instruction.
    const paused = fire(events, "before_agent_start") as { message: { customType: string; content: string } };
    // Its own type, not goal.reminder: scanGoalState treats post-compaction
    // goal.reminder messages as proof the goal is in context, and a paused
    // steer masquerading as one would mask compaction of the real reminder.
    expect(paused.message.customType).toBe("goal.paused");
    expect(paused.message.content).toContain("Do NOT work toward it this turn");

    // Once resumed, the steer is gone.
    await commands.get("goal")!.handler("resume", { mode: "headless", ui: { notify: vi.fn(), setStatus: vi.fn() } });
    expect(fire(events, "before_agent_start")).toBeUndefined();
  });

  it("resume re-derives goal state from the branch and a view command does not corrupt it", async () => {
    const { pi, tools, commands, events } = makePi();
    registerGoalTool(pi);
    const notify = vi.fn();
    const ctx = { mode: "headless", ui: { notify } };

    // The model sets a goal; it is the only writer of goal state.
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "persisted" });
    // A view-only status command must leave the branch (and thus resume) intact.
    await commands.get("goal")!.handler("status", ctx);

    const branch = [goalState(goal({ id: 1, objective: "persisted" }))];
    fire(events, "session_start", sessionCtx(branch));
    // After resume the goal is #1 and active: a stale-id complete is rejected
    // naming #1, proving the state was re-adopted from the branch.
    const probe = (await tools.get(GOAL_TOOL_NAME)!.execute("2", {
      action: "complete",
      goalId: 999,
      summary: "x",
      evidence: ["y"],
    })) as { details: GoalDetails };
    expect(probe.details.error).toContain("current goal is #1");
    expect(probe.details.goal!.status).toBe("active");
  });

  it("consults an injected judge and accepts completion it endorses", async () => {
    const { pi, tools } = makePi();
    const evaluate = vi.fn(() => ({ complete: true }));
    registerGoalTool(pi, { judge: { evaluate } });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix bug", criteria: ["tests green"] });

    const result = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "fixed it",
      evidence: ["tests pass"],
    })) as { details: GoalDetails };
    expect(evaluate).toHaveBeenCalled();
    expect(result.details.error).toBeUndefined();
    expect(result.details.goal!.status).toBe("complete");
  });

  it("treats a judge that defers (undefined) as a pass", async () => {
    const { pi, tools } = makePi();
    registerGoalTool(pi, { judge: { evaluate: () => undefined } });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "fix bug" });

    const result = (await tool.execute("2", {
      action: "complete",
      goalId: 1,
      summary: "fixed it",
      evidence: ["tests pass"],
    })) as { details: GoalDetails };
    expect(result.details.goal!.status).toBe("complete");
  });

  it("shows the goal full-screen in TUI mode", async () => {
    const { pi, tools, commands, activeTools } = makePi();
    registerGoalTool(pi);
    // The model sets the goal (the only state writer); the command is a view.
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it" });
    expect(activeTools).toContain(GOAL_TOOL_NAME);

    let component: { render: (width: number) => string[]; handleInput: (data: string) => void } | undefined;
    let closed = false;
    const ctx = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
          component = factory({}, THEME, {}, () => {
            closed = true;
          }) as typeof component;
        },
      },
    };
    await commands.get("goal")!.handler("", ctx);
    expect(component!.render(80).join("\n")).toContain("ship it");
    component!.handleInput("\x1b");
    expect(closed).toBe(true);
  });
});
