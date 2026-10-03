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
  renderContinuationPrompt,
  renderGoalCall,
  renderGoalResult,
  renderGoalReminder,
  scanGoalBranch,
  validateCriteria,
  validateObjective,
  type Goal,
  type GoalDetails,
  registerGoalTool,
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
  ...over,
});

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
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, activeTools, sent };
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

describe("renderContinuationPrompt", () => {
  it("restates the objective, criteria, and the continuation count", () => {
    const prompt = renderContinuationPrompt(goal({ id: 2, criteria: ["a", "b"] }), 3, 10);
    expect(prompt).toContain("#2");
    expect(prompt).toContain("fix the failing test");
    expect(prompt).toContain("3/10");
    expect(prompt).toContain("• a");
    expect(prompt).toContain("• b");
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
    expect(result.details.goal).toEqual(
      goal({ objective: "ship the smaller fix first", criteria: ["tests green", "lint clean"] }),
    );
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

  it("keeps the agent going: each settle re-engages the goal with an increasing count", async () => {
    const { pi, tools, events, sent } = makePi();
    registerGoalTool(pi, { maxContinuations: 10 });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "ship it" });

    // Three settles → three re-engagements, numbered 1/10, 2/10, 3/10.
    for (let i = 0; i < 3; i++) fire(events, "agent_settled");
    expect(sent).toHaveLength(3);
    expect(sent[0].text).toContain("1/10");
    expect(sent[1].text).toContain("2/10");
    expect(sent[2].text).toContain("3/10");
    expect(sent[0].text).toContain("ship it");
    expect(sent[0].opts).toEqual({ deliverAs: "followUp" });

    // Complete the goal; the loop stops.
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    fire(events, "agent_settled");
    expect(sent).toHaveLength(3);
  });

  it("a stuck model re-setting the goal cannot defeat the cap", async () => {
    const { pi, tools, events, sent } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 2 });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "stuck goal" });

    fire(events, "agent_settled", ctx); // continuation 1
    // Re-setting the goal mid-loop must NOT reset the continuation budget.
    await tool.execute("2", { action: "set", objective: "stuck goal" });
    fire(events, "agent_settled", ctx); // continuation 2
    fire(events, "agent_settled", ctx); // at cap → stop + notify
    expect(sent).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("2");

    fire(events, "agent_settled", ctx); // still capped
    expect(sent).toHaveLength(2);
  });

  it("a fake completion cannot farm the continuation cap", async () => {
    const { pi, tools, events, sent } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 2 });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "farm" });

    fire(events, "agent_settled", ctx); // continuation 1
    fire(events, "agent_settled", ctx); // continuation 2
    fire(events, "agent_settled", ctx); // at cap → stopped
    expect(sent).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);

    // The model "completes" (the structural gate passes on presence) and sets a
    // new goal. Completion must NOT refund the budget, so the loop stays stopped.
    await tool.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["did it"] });
    await tool.execute("3", { action: "set", objective: "farm again" });
    fire(events, "agent_settled", ctx);
    expect(sent).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("re-arms the continuation loop when an active goal is resumed", async () => {
    const { pi, tools, events, sent } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 1 });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "resumable" });

    // Drive the loop to the cap so it is stopped.
    fire(events, "agent_settled", ctx); // continuation 1
    fire(events, "agent_settled", ctx); // at cap → stopped
    expect(notify).toHaveBeenCalledTimes(1);

    // Resume re-derives the (still active) goal and re-arms the loop.
    const branch = [goalSnapshot(goal({ id: 1, objective: "resumable", status: "active" }))];
    fire(events, "session_start", sessionCtx(branch));
    fire(events, "agent_settled"); // re-engages with a fresh budget
    expect(sent).toHaveLength(2);
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
    const { pi, tools, events, sent } = makePi();
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    registerGoalTool(pi, { maxContinuations: 2 });
    const tool = tools.get(GOAL_TOOL_NAME)!;
    await tool.execute("1", { action: "set", objective: "stuck goal" });

    fire(events, "agent_settled", ctx); // continuation 1
    fire(events, "agent_settled", ctx); // continuation 2
    fire(events, "agent_settled", ctx); // at cap → stop + notify
    expect(sent).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("2");

    // Stopped: no further continuations on more settles.
    fire(events, "agent_settled", ctx);
    expect(sent).toHaveLength(2);
  });

  it("does not auto-continue a non-active goal", async () => {
    const { pi, tools, events, sent } = makePi();
    registerGoalTool(pi);
    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "x" });
    await tools.get(GOAL_TOOL_NAME)!.execute("2", { action: "complete", goalId: 1, summary: "done", evidence: ["ok"] });
    fire(events, "agent_settled");
    expect(sent).toHaveLength(0);
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
    const { pi, tools, commands, events, sent } = makePi();
    registerGoalTool(pi, { maxContinuations: 10 });
    const notify = vi.fn();
    const ctx = { mode: "headless", ui: { notify } };

    await tools.get(GOAL_TOOL_NAME)!.execute("1", { action: "set", objective: "stuck work" });

    // Without stop, settles keep re-engaging the goal.
    fire(events, "agent_settled");
    expect(sent).toHaveLength(1);

    await commands.get("goal")!.handler("stop", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("stopped"));
    // The stop marks the goal blocked session-scoped; the loop halts.
    fire(events, "agent_settled");
    expect(sent).toHaveLength(1);

    // Stopping with no active goal is a no-op.
    await commands.get("goal")!.handler("stop", ctx);
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
