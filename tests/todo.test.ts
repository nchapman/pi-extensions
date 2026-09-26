import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  REMINDER_MIN_TURNS,
  renderPlainList,
  renderReminder,
  renderTodoCall,
  renderTodoResult,
  shouldRemind,
  summarizeTodos,
  TODO_TOOL_NAME,
  validateTodoList,
  type TodoDetails,
  type TodoItem,
  registerTodoTool,
  droppedUnfinishedItems,
} from "../extensions/todo";

const THEME = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

function renderPlain(component: { render: (width: number) => string[] }): string {
  return component.render(200).join("\n");
}

const item = (content: string, status: TodoItem["status"] = "pending"): TodoItem => ({ content, status });

function makePi() {
  const tools = new Map<
    string,
    {
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }
  >();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const pi = {
    registerTool: (t: {
      name: string;
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }) => tools.set(t.name, t),
    registerCommand: (
      name: string,
      cmd: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, cmd),
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      events.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events };
}

/** Fire a captured event handler and return whatever it returned. */
function fire(events: Map<string, (event?: unknown, ctx?: unknown) => unknown>, name: string, ctx?: unknown) {
  const handler = events.get(name);
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler({ type: name }, ctx);
}

function sessionCtx(todosSnapshots: Array<TodoItem[]>): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () =>
        todosSnapshots.map((todos) => ({
          type: "message",
          message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: { todos } },
        })),
    },
  } as unknown as ExtensionContext;
}

describe("validateTodoList", () => {
  it("accepts a valid list and trims content", () => {
    const { todos, error } = validateTodoList([
      { content: "  write tests  ", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ]);
    expect(error).toBeUndefined();
    expect(todos).toEqual([item("write tests", "in_progress"), item("ship it")]);
  });

  it("accepts an empty list (clearing the plan)", () => {
    const { todos, error } = validateTodoList([]);
    expect(error).toBeUndefined();
    expect(todos).toEqual([]);
  });

  it("rejects more than one in_progress item", () => {
    const { error } = validateTodoList([item("a", "in_progress"), item("b", "in_progress")]);
    expect(error).toContain("at most one todo may be in_progress");
  });

  it("rejects invalid statuses", () => {
    const { error } = validateTodoList([{ content: "a", status: "done" }]);
    expect(error).toContain("status must be one of");
  });

  it("rejects empty content", () => {
    const { error } = validateTodoList([{ content: "   ", status: "pending" }]);
    expect(error).toContain("content must be a non-empty string");
  });

  it("rejects non-array input", () => {
    const { error } = validateTodoList("nope");
    expect(error).toBe("todos must be an array");
  });

  it("allows any number of cancelled items", () => {
    const { error } = validateTodoList([item("a", "cancelled"), item("b", "cancelled")]);
    expect(error).toBeUndefined();
  });

  it("rejects duplicate item content", () => {
    const { error } = validateTodoList([item("a"), item("a", "completed")]);
    expect(error).toContain("duplicate");
  });

  it("rejects lists longer than 50 items", () => {
    const { error } = validateTodoList(Array.from({ length: 51 }, (_, i) => item(`t${i}`)));
    expect(error).toContain("at most 50");
  });
});

describe("summarizeTodos", () => {
  it("counts completed and cancelled items as resolved", () => {
    const todos = [item("a", "completed"), item("b", "in_progress"), item("c"), item("d", "cancelled")];
    expect(summarizeTodos(todos)).toEqual({ resolved: 2, total: 4, active: item("b", "in_progress") });
  });
});

describe("droppedUnfinishedItems", () => {
  it("flags unfinished items missing from the next list", () => {
    const previous = [
      item("keep", "in_progress"),
      item("drop", "pending"),
      item("done", "completed"),
      item("cut", "cancelled"),
    ];
    const next = [item("keep", "completed"), item("done", "completed"), item("cut", "cancelled"), item("new")];
    expect(droppedUnfinishedItems(previous, next)).toEqual([item("drop")]);
  });

  it("flags reworded unfinished items as drops", () => {
    const previous = [item("run the tests")];
    expect(droppedUnfinishedItems(previous, [item("execute the tests")])).toEqual([item("run the tests")]);
  });

  it("allows resolved items to drop freely", () => {
    const previous = [item("done", "completed"), item("cut", "cancelled")];
    expect(droppedUnfinishedItems(previous, [])).toEqual([]);
  });
});

describe("renderPlainList", () => {
  it("renders ASCII markers the model can echo back", () => {
    const text = renderPlainList([item("a", "completed"), item("b", "in_progress"), item("c", "cancelled")]);
    expect(text).toContain("2/3 resolved");
    expect(text).toContain("[x] a");
    expect(text).toContain("[>] b");
    expect(text).toContain("[-] c");
  });
});

describe("renderTodoCall", () => {
  it("shows progress and the active item", () => {
    const text = renderTodoCall(
      { todos: [item("a", "completed"), item("write tests", "in_progress"), item("c")] },
      THEME,
    );
    expect(text).toContain("todo ");
    expect(text).toContain("1/3");
    expect(text).toContain("write tests");
  });

  it("tolerates partially streamed arguments", () => {
    expect(renderTodoCall({}, THEME)).toBe("todo");
    // Any key order: status may arrive before content.
    expect(renderTodoCall({ todos: [{ status: "in_progress" }] }, THEME)).toContain("todo");
    expect(renderTodoCall({ todos: [{ content: "a", status: "completed" }, null] }, THEME)).toContain("1/1");
  });
});

describe("renderTodoResult", () => {
  it("shows one-line progress when collapsed", () => {
    const todos = [item("a", "completed"), item("write tests", "in_progress"), item("c")];
    const text = renderTodoResult({ todos }, { expanded: false }, THEME);
    expect(text).toContain("1/3");
    expect(text).toContain("write tests");
    expect(text).not.toContain("[x]");
  });

  it("shows the full checklist when expanded", () => {
    const todos = [item("a", "completed"), item("b", "in_progress"), item("c"), item("d", "cancelled")];
    const text = renderTodoResult({ todos }, { expanded: true }, THEME);
    expect(text).toContain("✓ a");
    expect(text).toContain("▸ b");
    expect(text).toContain("○ c");
    expect(text).toContain("✗ d");
  });

  it("renders errors and empty lists", () => {
    expect(renderTodoResult({ todos: [], error: "bad list" }, { expanded: false }, THEME)).toContain("✗ bad list");
    expect(renderTodoResult({ todos: [] }, { expanded: false }, THEME)).toContain("no todos");
  });
});

describe("shouldRemind", () => {
  it("reminds when the plan went stale", () => {
    expect(shouldRemind({ unfinished: true, turnsSinceUpdate: REMINDER_MIN_TURNS, compactedSinceUpdate: false })).toBe(
      true,
    );
  });

  it("reminds immediately after compaction", () => {
    expect(shouldRemind({ unfinished: true, turnsSinceUpdate: 1, compactedSinceUpdate: true })).toBe(true);
  });

  it("stays quiet for fresh plans and finished work", () => {
    expect(shouldRemind({ unfinished: true, turnsSinceUpdate: 1, compactedSinceUpdate: false })).toBe(false);
    expect(shouldRemind({ unfinished: false, turnsSinceUpdate: 99, compactedSinceUpdate: true })).toBe(false);
  });
});

describe("renderReminder", () => {
  it("includes the current plan and instructions", () => {
    const text = renderReminder([item("a", "completed"), item("b", "in_progress")]);
    expect(text).toContain("TODO REMINDER");
    expect(text).toContain("[x] a");
    expect(text).toContain("[>] b");
    expect(text).toContain("Keep statuses current");
  });
});

describe("registerTodoTool", () => {
  it("updates state on valid lists and snapshots it into details", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);

    const result = (await tools.get(TODO_TOOL_NAME)!.execute("1", {
      todos: [item("a", "completed"), item("b", "in_progress")],
    })) as { content: Array<{ type: string; text: string }>; details: TodoDetails };
    expect(result.content[0].text).toContain("[x] a");
    expect(result.details.todos).toHaveLength(2);
    expect(result.details.error).toBeUndefined();
  });

  it("rejects invalid lists but returns the current state", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;

    await tool.execute("1", { todos: [item("a", "in_progress")] });
    const result = (await tool.execute("2", {
      todos: [item("a", "in_progress"), item("b", "in_progress")],
    })) as { content: Array<{ type: string; text: string }>; details: TodoDetails };

    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("[>] a");
    expect(result.details.error).toBeDefined();
    // State is unchanged by the rejected update.
    expect(result.details.todos).toEqual([item("a", "in_progress")]);
  });

  it("renders call and result rows from the registered tool", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;

    const call = tool.renderCall!(
      { todos: [item("a", "completed"), item("b", "in_progress")] } as never,
      THEME,
      {} as never,
    );
    expect(renderPlain(call as never)).toContain("1/2");

    const result = await tool.execute("1", { todos: [item("a", "completed"), item("b", "in_progress")] });
    const rendered = tool.renderResult!(result as never, { expanded: true } as never, THEME, {} as never);
    const text = renderPlain(rendered as never);
    expect(text).toContain("✓ a");
    expect(text).toContain("▸ b");
  });

  it("reconstructs state from the session branch (last snapshot wins)", async () => {
    const { pi, tools, events } = makePi();
    registerTodoTool(pi);

    fire(events, "session_start", sessionCtx([[item("old")], [item("new", "completed")]]));

    // A rejected update reports the current (reconstructed) state unchanged.
    const result = (await tools.get(TODO_TOOL_NAME)!.execute("1", {
      todos: [item("x", "in_progress"), item("y", "in_progress")],
    })) as { details: TodoDetails };
    expect(result.details.todos).toEqual([item("new", "completed")]);
  });

  it("reconstructs on session_tree (branch navigation) the same way", async () => {
    const { pi, tools, events } = makePi();
    registerTodoTool(pi);

    fire(events, "session_tree", sessionCtx([[item("branched")]]));

    const result = (await tools.get(TODO_TOOL_NAME)!.execute("1", {
      todos: [item("x", "in_progress"), item("y", "in_progress")],
    })) as { details: TodoDetails };
    expect(result.details.todos).toEqual([item("branched")]);
  });

  it("reminds on the first turn after resume when compaction hides the plan", () => {
    const branch = [
      {
        type: "message",
        message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: { todos: [item("a", "in_progress")] } },
      },
      { type: "compaction" },
    ];
    const { pi, events } = makePi();
    registerTodoTool(pi);

    fire(events, "session_start", { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext);
    const reminder = fire(events, "before_agent_start") as { message: { content: string } };
    expect(reminder.message.content).toContain("[>] a");
  });

  it("reminds once after the plan goes stale, then resets on update", async () => {
    const { pi, tools, events } = makePi();
    registerTodoTool(pi);

    await tools.get(TODO_TOOL_NAME)!.execute("1", { todos: [item("a", "in_progress")] });

    const results: unknown[] = [];
    for (let i = 0; i < REMINDER_MIN_TURNS; i++) results.push(fire(events, "before_agent_start"));
    // Quiet until the threshold is reached.
    expect(results[REMINDER_MIN_TURNS - 2]).toBeUndefined();
    const reminder = results[REMINDER_MIN_TURNS - 1] as { message: { customType: string; content: string } };
    expect(reminder.message.customType).toBe("todo.reminder");
    expect(reminder.message.content).toContain("[>] a");
    // Consumed: the next turn is quiet again.
    expect(fire(events, "before_agent_start")).toBeUndefined();

    // A fresh update restarts the staleness counter, even for unfinished plans.
    await tools.get(TODO_TOOL_NAME)!.execute("2", { todos: [item("a", "completed"), item("b")] });
    for (let i = 0; i < REMINDER_MIN_TURNS - 1; i++) {
      expect(fire(events, "before_agent_start")).toBeUndefined();
    }
    expect(fire(events, "before_agent_start")).toBeDefined();
  });

  it("reminds on the next turn after compaction", async () => {
    const { pi, tools, events } = makePi();
    registerTodoTool(pi);

    await tools.get(TODO_TOOL_NAME)!.execute("1", { todos: [item("a", "in_progress")] });
    fire(events, "session_compact");

    const reminder = fire(events, "before_agent_start") as { message: { content: string } };
    expect(reminder.message.content).toContain("[>] a");
  });

  it("registers /todos and guards non-TUI mode", async () => {
    const { pi, commands } = makePi();
    registerTodoTool(pi);

    expect(commands.get("todos")?.description).toContain("task list");
    const notify = vi.fn();
    await commands.get("todos")!.handler("", { mode: "headless", ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
  });

  it("rejects updates that silently drop unfinished items", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;

    await tool.execute("1", { todos: [item("keep", "in_progress"), item("drop"), item("done", "completed")] });
    const result = (await tool.execute("2", { todos: [item("keep", "completed"), item("done", "completed")] })) as {
      content: Array<{ type: string; text: string }>;
      details: TodoDetails;
    };

    expect(result.content[0].text).toContain('"drop"');
    expect(result.content[0].text).toContain("cancelled");
    // State is unchanged by the rejected update.
    expect(result.details.todos).toHaveLength(3);
  });

  it("accepts explicit cancellation and allows clearing a fully resolved list", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;

    await tool.execute("1", { todos: [item("a", "in_progress"), item("b")] });
    const cancelled = (await tool.execute("2", { todos: [item("a", "cancelled"), item("b", "cancelled")] })) as {
      details: TodoDetails;
    };
    expect(cancelled.details.error).toBeUndefined();

    const cleared = (await tool.execute("3", { todos: [] })) as { details: TodoDetails };
    expect(cleared.details.todos).toEqual([]);
  });

  it("rejects clearing while unfinished items remain, leaving state unchanged", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;
    await tool.execute("1", { todos: [item("a", "in_progress")] });

    const result = (await tool.execute("2", { todos: [] })) as {
      content: Array<{ type: string; text: string }>;
      details: TodoDetails;
    };
    expect(result.content[0].text).toContain('"a"');
    expect(result.details.todos).toEqual([item("a", "in_progress")]);
    expect(result.details.error).toBeDefined();
  });

  it("supports rewording via cancel-and-replace in one call", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;
    await tool.execute("1", { todos: [item("run the tests")] });

    const result = (await tool.execute("2", {
      todos: [item("run the tests", "cancelled"), item("run vitest")],
    })) as { details: TodoDetails };
    expect(result.details.error).toBeUndefined();
    expect(result.details.todos).toEqual([item("run the tests", "cancelled"), item("run vitest")]);
  });

  it("recovers from the 50-item cap via cancel-then-replace", async () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const tool = tools.get(TODO_TOOL_NAME)!;
    const fifty = Array.from({ length: 50 }, (_, i) => item(`t${i}`));
    await tool.execute("1", { todos: fifty });

    // Adding a 51st item fails validation with actionable advice.
    const tooMany = (await tool.execute("2", { todos: [...fifty, item("new")] })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(tooMany.content[0].text).toContain("cancelled, then replace");

    // Cancel one, then replace the resolved slot in the next call.
    await tool.execute("3", { todos: fifty.map((t, i) => (i === 0 ? item("t0", "cancelled") : t)) });
    const replaced = (await tool.execute("4", {
      todos: [...fifty.slice(1), item("new")],
    })) as { details: TodoDetails };
    expect(replaced.details.error).toBeUndefined();
    expect(replaced.details.todos).toHaveLength(50);
  });

  it("rejected updates do not reset the staleness counter", async () => {
    const { pi, tools, events } = makePi();
    registerTodoTool(pi);
    await tools.get(TODO_TOOL_NAME)!.execute("1", { todos: [item("a", "in_progress")] });

    for (let i = 0; i < REMINDER_MIN_TURNS - 1; i++) fire(events, "before_agent_start");
    // A rejected update must not count as keeping the plan current.
    await tools.get(TODO_TOOL_NAME)!.execute("2", { todos: [item("a", "in_progress"), item("b", "in_progress")] });
    const reminder = fire(events, "before_agent_start") as { message: { content: string } };
    expect(reminder.message.content).toContain("[>] a");
  });

  it("instructs models on when the tool is worth using", () => {
    const { pi, tools } = makePi();
    registerTodoTool(pi);
    const description = (tools.get(TODO_TOOL_NAME) as unknown as { description: string }).description;
    // The usage policy: plans that outlive the context, not thought organization.
    expect(description).toContain("outlive the context");
    expect(description).toContain("compaction");
    expect(description).toContain("Skip it");
  });

  it("renders the /todos checklist full-screen in TUI mode", async () => {
    const { pi, tools, commands } = makePi();
    registerTodoTool(pi);
    await tools.get(TODO_TOOL_NAME)!.execute("1", { todos: [item("a", "completed"), item("b", "in_progress")] });

    let component: { render: (width: number) => string[]; handleInput: (data: string) => void } | undefined;
    const ctx = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
          component = factory({}, THEME, {}, () => {}) as typeof component;
        },
      },
    };
    await commands.get("todos")!.handler("", ctx);

    const text = component!.render(80).join("\n");
    expect(text).toContain("1/2 resolved");
    expect(text).toContain("✓ a");
    expect(text).toContain("▸ b");
    // Empty state and escape-to-close.
    let closed = false;
    let emptyComponent: typeof component;
    const emptyCtx = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        custom: async (f: (t: unknown, th: unknown, k: unknown, done: () => void) => unknown) => {
          emptyComponent = f({}, THEME, {}, () => {
            closed = true;
          }) as typeof component;
        },
      },
    };
    const fresh = makePi();
    registerTodoTool(fresh.pi);
    await fresh.commands.get("todos")!.handler("", emptyCtx);
    expect(emptyComponent!.render(80).join("\n")).toContain("No todos yet");
    emptyComponent!.handleInput("\x1b");
    expect(closed).toBe(true);
  });
});
