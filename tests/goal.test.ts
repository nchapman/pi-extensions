import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  scanGoalBranch,
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
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }
  >();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const activeTools: string[] = ["read", "bash"];
  const sent: Array<{ text: string; opts?: unknown }> = [];
  const sentCustom: Array<{ msg: unknown; opts?: unknown }> = [];
  const messageRenderers = new Map<string, (message: never, options: never, theme: never) => unknown>();
  const pi = {
    registerTool: (t: {
      name: string;
      description?: string;
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
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
    registerMessageRenderer: (type: string, renderer: (message: never, options: never, theme: never) => unknown) => {
      messageRenderers.set(type, renderer);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, activeTools, sent, sentCustom, messageRenderers };
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
function goalSnapshot(g: Goal) {
  return { type: "message", message: { role: "toolResult", toolName: GOAL_TOOL_NAME, details: { goal: g } } };
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

describe("scanGoalBranch / lastGoalSnapshot", () => {
  it("returns the newest valid goal snapshot", () => {
    const branch = [goalSnapshot(goal({ id: 1 })), goalSnapshot(goal({ id: 2, objective: "newer" }))];
    expect(lastGoalSnapshot(branch)).toEqual(goal({ id: 2, objective: "newer" }));
  });
  it("returns null when there is no goal snapshot", () => {
    expect(lastGoalSnapshot([{ type: "message", message: { role: "user", content: "hi" } }])).toBeNull();
    expect(lastGoalSnapshot([])).toBeNull();
  });
  it("skips malformed snapshots, keeping the newest valid one", () => {
    const branch = [
      goalSnapshot(goal({ id: 1 })),
      { type: "message", message: { role: "toolResult", toolName: GOAL_TOOL_NAME, details: { goal: "bad" } } },
      { type: "message", message: { role: "toolResult", toolName: "read", details: { goal: goal({ id: 9 }) } } },
    ];
    expect(lastGoalSnapshot(branch)).toEqual(goal({ id: 1 }));
  });
  it("reports a compaction after the snapshot as hiding the goal", () => {
    const branch = [goalSnapshot(goal({ id: 1 })), { type: "compaction" }];
    expect(scanGoalBranch(branch).hiddenByCompaction).toBe(true);
  });
  it("does not hide the goal when a reminder carrier follows the compaction", () => {
    const branch = [
      goalSnapshot(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
    ];
    expect(scanGoalBranch(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide the goal when a turn-end check carrier follows the compaction", () => {
    // A goal.check message after a compaction restates the objective too, so it
    // is a carrier like the reminder — no redundant re-injection on resume.
    const branch = [
      goalSnapshot(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_CHECK_TYPE, content: "GOAL CHECK" },
    ];
    expect(scanGoalBranch(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide a non-active goal even after compaction", () => {
    const branch = [goalSnapshot(goal({ id: 1, status: "paused" })), { type: "compaction" }];
    expect(scanGoalBranch(branch).hiddenByCompaction).toBe(false);
  });
  it("does not hide the goal when the compaction is before the snapshot", () => {
    const branch = [{ type: "compaction" }, goalSnapshot(goal({ id: 1 }))];
    expect(scanGoalBranch(branch).hiddenByCompaction).toBe(false);
  });
  it("lets only the newest compaction after the snapshot decide", () => {
    // A reminder carrier after the second compaction clears the hide.
    const withCarrier = [
      goalSnapshot(goal({ id: 1 })),
      { type: "compaction" },
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
    ];
    expect(scanGoalBranch(withCarrier).hiddenByCompaction).toBe(false);
    // No carrier after the second compaction: still hidden.
    const noCarrier = [goalSnapshot(goal({ id: 1 })), { type: "compaction" }, { type: "compaction" }];
    expect(scanGoalBranch(noCarrier).hiddenByCompaction).toBe(true);
    // A carrier after only the first compaction does not clear the second.
    const staleCarrier = [
      goalSnapshot(goal({ id: 1 })),
      { type: "compaction" },
      { type: "custom_message", customType: GOAL_REMINDER_TYPE, content: "GOAL REMINDER" },
      { type: "compaction" },
    ];
    expect(scanGoalBranch(staleCarrier).hiddenByCompaction).toBe(true);
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
  it("caps very large output to a tail", async () => {
    const r = await runVerify(`python3 -c "print('x' * 100000)" || node -e "console.log('x'.repeat(100000))"`, {
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(4096 + 20);
    expect(r.output).toContain("(truncated)");
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
    const { goal: scanned } = scanGoalBranch([goalSnapshot(goal({ verify: "npm test" }))]);
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

    fire(events, "session_start", sessionCtx([goalSnapshot(goal({ id: 7, objective: "resumed" }))]));

    // The tool is re-activated for an unfinished goal.
    const tool = tools.get(GOAL_TOOL_NAME)!;
    const next = (await tool.execute("1", { action: "set", objective: "next" })) as { details: GoalDetails };
    expect(next.details.goal!.id).toBe(8); // resumes after the reconstructed id
  });

  it("does not re-activate the tool for a completed goal on resume", async () => {
    const { pi, events, activeTools } = makePi();
    registerGoalTool(pi);
    fire(events, "session_start", sessionCtx([goalSnapshot(goal({ id: 3, status: "complete" }))]));
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
    const branch = [goalSnapshot(goal({ id: 5, objective: "carried over" }))];
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
    const branch = [goalSnapshot(goal({ id: 1, objective: "resumable", verify: "npm test", status: "active" }))];
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
    fire(events, "session_start", sessionCtx([goalSnapshot(goal({ id: 1, objective: "x", verify: "npm test" }))]));

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
    // Passing checks read as summarize-and-complete; missing details degrade to a dim row.
    expect(renderCheckMessage({ ...details, ok: true }, { expanded: false }, THEME)).toContain(
      "verify passed — agent will summarize and complete",
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
    fire(events, "session_start", sessionCtx([goalSnapshot(goal({ id: 1, objective: "x", verify: "npm test" }))]));

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
    expect(notify).toHaveBeenLastCalledWith("No active goal to stop.");
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

    const branch = [goalSnapshot(goal({ id: 1, objective: "persisted" }))];
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
