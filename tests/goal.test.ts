import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  checkCompletion,
  checkEvidenceCoverage,
  effectiveCriteria,
  GOAL_MAX_CONTINUATIONS_DEFAULT,
  GOAL_MAX_TURNS_PER_RUN_DEFAULT,
  GOAL_REMINDER_TYPE,
  GOAL_TOOL_NAME,
  isContradictorySummary,
  lastGoalSnapshot,
  parseMaxContinuations,
  parseMaxTurnsPerRun,
  parseVerifyTimeoutMs,
  renderCheckPrompt,
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
  type GoalDetails,
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
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, activeTools, sent, sentCustom };
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
  it("shows the objective, id, and elapsed time", () => {
    const g = goal({ id: 3, objective: "ship it", startedAt: 0 });
    const footer = renderGoalFooter(g, 252_000); // 4m 12s after start
    expect(footer).toContain("🎯 #3");
    expect(footer).toContain("ship it");
    expect(footer).toContain("4m 12s");
  });
});

describe("renderCheckPrompt", () => {
  const g = goal({ id: 2, criteria: ["a", "b"] });
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
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    expect(first.msg.display).toBe(false);
    expect(first.opts).toEqual({ deliverAs: "followUp" });

    // Once the check passes and the goal is completed, the loop stops.
    check = okVerify;
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(3);
  });

  it("a passing check prompts the agent to summarize and complete", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => failVerify });
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it" }); // no verify

    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("a stuck model re-setting the goal cannot defeat the cap", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify, setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    const ctx = { ui: { notify, setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    const ctx = { ui: { notify, setStatus: vi.fn() } } as unknown as ExtensionContext;
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

  it("does not auto-continue a non-active goal", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => okVerify });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "x", verify: "npm test" });
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(await fire(events, "agent_before_settle", ctx)).toBeUndefined();
    expect(sentCustom).toHaveLength(0);
  });

  it("does not re-engage after an errored or aborted run", async () => {
    const { pi, tools, events, sentCustom } = makePi();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
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
    const uiCtx = { ui: { notify, setStatus } } as unknown as ExtensionContext;
    registerGoalTool(pi, { verifyRunner: async () => okVerify });

    // Prime uiRef the way a real session does.
    fire(events, "session_start", {
      sessionManager: { getBranch: () => [] },
      ui: { notify, setStatus },
    } as unknown as ExtensionContext);

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "ship it", verify: "npm test" });
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("🎯 #1: ship it"));

    // turn_end keeps the timer current during a long run; a settle refreshes it too.
    fire(events, "turn_end");
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("🎯 #1: ship it"));
    await fire(events, "agent_before_settle", uiCtx);
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("🎯 #1: ship it"));

    // Completion clears the footer.
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    expect(setStatus).toHaveBeenLastCalledWith("goal", undefined);
  });

  it("clears the footer when the goal is blocked", async () => {
    const { pi, tools, events } = makePi();
    const setStatus = vi.fn();
    const uiCtx = { ui: { notify: vi.fn(), setStatus } } as unknown as ExtensionContext;
    registerGoalTool(pi);
    fire(events, "session_start", {
      sessionManager: { getBranch: () => [] },
      ui: uiCtx.ui,
    } as unknown as ExtensionContext);

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "migrate db" });
    expect(setStatus).toHaveBeenLastCalledWith("goal", expect.stringContaining("🎯 #1: migrate db"));

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
    const settleCtx = { ui: { notify, setStatus } } as unknown as ExtensionContext;
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
