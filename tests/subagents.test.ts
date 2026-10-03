import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adoptSubagentTask,
  agentFromText,
  backgroundedNotice,
  buildCommandPrompt,
  BUILTIN_TOOLS,
  buildChildArgs,
  DEFAULT_AGENT_MD,
  extractAssistantText,
  formatUsageLine,
  isValidCommandName,
  loadAgents,
  parseConcurrency,
  parseTimeoutMs,
  refLabel,
  registerCommandsForAgents,
  registerSubagentCommands,
  registerSubagentsExtension,
  registerSubagentTools,
  renderSubagentCall,
  renderSubagentsCall,
  resolveAgentDef,
  resolveChildModel,
  runChild,
  runWithLimit,
  splitFrontmatter,
  sumUsages,
  summarizeTask,
  renderSubagentResult,
  type AgentDef,
  type ChildLike,
  type ChildRun,
  type ChildUsage,
  type SpawnFn,
} from "../extensions/subagents";
import { createTaskRegistry, type AdoptedHandle } from "../lib/superbash";

/** Identity theme: strips styling so assertions see plain text. */
const THEME = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

const USAGE = (over: Partial<ChildUsage> = {}): ChildUsage => ({
  input: 100,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 105,
  cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
  ...over,
});

const usageLine = (usage: ChildUsage): string => JSON.stringify({ type: "message_update", usage });
const assistantLine = (text: string): string =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
/** A complete assistant message_end line, the shape runChild parses for final text. */
const jsonLine = assistantLine;

/** Render a tool-call component to plain text for assertions. */
function renderPlain(component: { render: (width: number) => string[] }): string {
  return component.render(200).join("\n");
}

const AGENT: AgentDef = {
  name: "reviewer",
  description: "reviews code",
  instructions: "You are a reviewer.",
  tools: ["read", "bash"],
};

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  stdoutEmit: (chunk: string) => void;
  stderrEmit: (chunk: string) => void;
  close: (code: number | null) => void;
  fail: (error: Error) => void;
  kill: (signal?: string) => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.killed = false;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdoutEmit = (chunk: string) => stdout.emit("data", Buffer.from(chunk));
  child.stderrEmit = (chunk: string) => stderr.emit("data", Buffer.from(chunk));
  child.close = (code: number | null) => child.emit("close", code);
  child.fail = (error: Error) => child.emit("error", error);
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.close(null));
  };
  return child;
}

describe("splitFrontmatter", () => {
  it("parses scalars and body", () => {
    const { fm, body } = splitFrontmatter("---\nname: x\ndescription: hello\n---\nBody here");
    expect(fm).toEqual({ name: "x", description: "hello" });
    expect(body).toBe("Body here");
  });

  it("parses nested maps with real YAML booleans", () => {
    const { fm } = splitFrontmatter("---\ntools:\n  write: false\n  edit: false\n---\nBody");
    expect(fm.tools).toEqual({ write: false, edit: false });
  });

  it("handles CRLF line endings", () => {
    const { fm, body } = splitFrontmatter("---\r\nname: x\r\ndescription: d\r\n---\r\nBody");
    expect(fm).toEqual({ name: "x", description: "d" });
    expect(body).toBe("Body");
  });

  it("treats a file without frontmatter as body", () => {
    const { fm, body } = splitFrontmatter("# Just a prompt\n\n---\n\nhr line\nMore");
    expect(fm).toEqual({});
    expect(body).toBe("# Just a prompt\n\n---\n\nhr line\nMore");
  });

  it("keeps --- inside frontmatter values out of the body", () => {
    const { fm, body } = splitFrontmatter("---\ndescription: a --- b\n---\nBody");
    expect(fm.description).toBe("a --- b");
    expect(body).toBe("Body");
  });

  it("keeps markdown hr in body intact", () => {
    const { body } = splitFrontmatter("---\nname: x\n---\nIntro\n\n---\n\nMore");
    expect(body).toBe("Intro\n\n---\n\nMore");
  });

  it("treats unterminated frontmatter as body", () => {
    const text = "---\nname: x\nno closing";
    const { fm, body } = splitFrontmatter(text);
    expect(fm).toEqual({});
    expect(body).toBe(text);
  });

  it("preserves colons in quoted values", () => {
    const { fm } = splitFrontmatter('---\ndescription: "a: b"\n---\nBody');
    expect(fm.description).toBe("a: b");
  });

  it("folds block scalars and ignores comments", () => {
    const { fm } = splitFrontmatter("---\n# a comment\ndescription: >-\n  multi-line\n  description\n---\nBody");
    expect(fm.description).toBe("multi-line description");
  });

  it("tolerates a UTF-8 BOM and whitespace-padded delimiters", () => {
    const bom = "\uFEFF---\nname: x\n--- \nBody";
    expect(splitFrontmatter(bom)).toEqual({ fm: { name: "x" }, body: "Body" });
  });

  it("keeps indented --- inside block scalars out of the delimiter scan", () => {
    const { fm, body } = splitFrontmatter("---\ndescription: |\n  text with --- inside\n---\nBody");
    expect(fm.description).toBe("text with --- inside\n");
    expect(body).toBe("Body");
  });

  it("returns empty fm for an empty or comment-only block", () => {
    expect(splitFrontmatter("---\n---\nBody").fm).toEqual({});
    expect(splitFrontmatter("---\n# only a comment\n---\nBody").fm).toEqual({});
    expect(splitFrontmatter("---\n~\n---\nBody").fm).toEqual({});
  });

  it("throws on invalid YAML in frontmatter", () => {
    expect(() => splitFrontmatter("---\nname: [unclosed\n---\nBody")).toThrow();
  });

  it("throws when frontmatter is not a mapping", () => {
    expect(() => splitFrontmatter("---\njust a scalar\n---\nBody")).toThrow(/mapping/);
    expect(() => splitFrontmatter("---\n- a\n- b\n---\nBody")).toThrow(/mapping/);
  });
});

describe("agentFromText", () => {
  it("falls back to filename-derived name and defaults tools", () => {
    const agent = agentFromText("Just instructions", "code-reviewer");
    expect(agent.name).toBe("code-reviewer");
    expect(agent.instructions).toBe("Just instructions");
    expect(agent.tools).toEqual(BUILTIN_TOOLS);
    expect(agent.description).toBe("");
  });

  it("honors tools denylist", () => {
    const agent = agentFromText("---\ntools:\n  write: false\n  edit: false\n---\nBody", "x");
    expect(agent.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("treats False/0 as disabled case-insensitively", () => {
    const agent = agentFromText("---\ntools:\n  write: False\n  edit: 0\n---\nBody", "x");
    expect(agent.tools).not.toContain("write");
    expect(agent.tools).not.toContain("edit");
  });

  it("treats scalar tools as an allowlist", () => {
    const agent = agentFromText("---\ntools: read, grep\n---\nBody", "x");
    expect(agent.tools).toEqual(["read", "grep"]);
  });

  it("accepts tools as a YAML array", () => {
    const block = agentFromText("---\ntools:\n  - read\n  - bash\n---\nBody", "x");
    const flow = agentFromText("---\ntools: [read, bash]\n---\nBody", "x");
    expect(block.tools).toEqual(["read", "bash"]);
    expect(flow.tools).toEqual(["read", "bash"]);
  });

  it("treats quoted no/off as disabled in tools maps", () => {
    const agent = agentFromText('---\ntools:\n  write: "no"\n  edit: off\n---\nBody', "x");
    expect(agent.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("fails closed for map entries with no value", () => {
    const agent = agentFromText("---\ntools:\n  write:\n---\nBody", "x");
    expect(agent.tools).not.toContain("write");
  });

  it("yields no tools for an explicit empty allowlist, all tools for whitespace-only string", () => {
    const none = agentFromText("---\ntools: []\n---\nBody", "x");
    expect(none.tools).toEqual([]);
    const blank = agentFromText('---\ntools: "   "\n---\nBody', "x");
    expect(blank.tools).toEqual(BUILTIN_TOOLS);
  });

  it("warns about unknown tool names and keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    agentFromText("---\ntools: [reads, bash]\n---\nBody", "x");
    agentFromText("---\ntools:\n  wriet: false\n---\nBody", "x");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("uses empty-quoted name as fallback", () => {
    const agent = agentFromText('---\nname: ""\n---\nBody', "fallback");
    expect(agent.name).toBe("fallback");
  });

  it("extracts model and thinking", () => {
    const agent = agentFromText("---\nmodel: zai/glm-5.3\nthinking: high\n---\nBody", "x");
    expect(agent.model).toBe("zai/glm-5.3");
    expect(agent.thinking).toBe("high");
    expect(agent.instructions).toBe("Body");
  });

  it("ignores non-string scalar values for name/description", () => {
    const agent = agentFromText("---\nname: 42\ndescription: [a, b]\n---\nBody", "fallback");
    expect(agent.name).toBe("fallback");
    expect(agent.description).toBe("");
  });

  it("rejects files whose frontmatter does not parse", () => {
    expect(() => agentFromText("---\nname: [unclosed\n---\nBody", "x")).toThrow();
  });
});

describe("loadAgents", () => {
  it("skips unreadable files with a warning and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
    writeFileSync(join(dir, "good.md"), "---\ndescription: ok\n---\nBody");
    writeFileSync(join(dir, "bad.md"), "---\nname: [unclosed\n---\nBody");
    writeFileSync(join(dir, "not-markdown.txt"), "ignore me");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agents = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("good");
    warn.mockRestore();
  });

  it("returns empty for a missing dir", () => {
    expect(loadAgents("/nonexistent/pi-agents")).toEqual([]);
  });
});

describe("env parsing", () => {
  it("uses defaults for missing or invalid values", () => {
    expect(parseTimeoutMs({})).toBe(600000);
    expect(parseTimeoutMs({ PI_SUBAGENT_TIMEOUT_MS: "abc" })).toBe(600000);
    expect(parseTimeoutMs({ PI_SUBAGENT_TIMEOUT_MS: "0" })).toBe(600000);
    expect(parseTimeoutMs({ PI_SUBAGENT_TIMEOUT_MS: "-5" })).toBe(600000);
    expect(parseConcurrency({})).toBe(4);
    expect(parseConcurrency({ PI_SUBAGENT_CONCURRENCY: "x" })).toBe(4);
  });

  it("accepts valid values", () => {
    expect(parseTimeoutMs({ PI_SUBAGENT_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(parseConcurrency({ PI_SUBAGENT_CONCURRENCY: "2" })).toBe(2);
    expect(parseConcurrency({ PI_SUBAGENT_CONCURRENCY: "2.9" })).toBe(2);
  });
});

describe("extractAssistantText", () => {
  it("joins text blocks and ignores others", () => {
    expect(
      extractAssistantText([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "a" },
        { type: "toolCall", name: "x" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("returns empty for non-arrays and empty arrays", () => {
    expect(extractAssistantText("nope")).toBe("");
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText([])).toBe("");
  });
});

describe("buildChildArgs", () => {
  it("isolates the child and restricts tools", () => {
    const args = buildChildArgs(AGENT, "do it", undefined);
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-session");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are a reviewer.");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash");
    expect(args[args.indexOf("--") + 1]).toBe("do it");
  });

  it("prefers caller model over agent model and adds thinking", () => {
    const args = buildChildArgs({ ...AGENT, model: "agent-model", thinking: "high" }, "t", "caller-model");
    expect(args[args.indexOf("--model") + 1]).toBe("caller-model");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });
});

describe("resolveChildModel", () => {
  it("inherits the parent chat's model when nothing pins one", () => {
    expect(resolveChildModel(undefined, undefined, { provider: "zai", id: "glm-5.3" })).toBe("zai/glm-5.3");
  });

  it("the tool call's model param outranks the agent definition, which outranks the session", () => {
    const session = { provider: "zai", id: "glm-5.3" };
    expect(resolveChildModel("param-model", "agent-model", session)).toBe("param-model");
    expect(resolveChildModel(undefined, "agent-model", session)).toBe("agent-model");
  });

  it("falls back to pi's default when no model is resolvable", () => {
    expect(resolveChildModel(undefined, undefined, undefined)).toBeUndefined();
    // A partial session model cannot form provider/id — never emit a bogus flag.
    expect(resolveChildModel(undefined, undefined, { id: "glm-5.3" })).toBeUndefined();
    expect(resolveChildModel(undefined, undefined, { provider: "zai" })).toBeUndefined();
  });
});

describe("runChild", () => {
  it("returns the last assistant text", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child;
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, spawnFn);
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      }) + "\n",
    );
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "final" }] },
      }) + "\n",
    );
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("final");
    expect(r.usage).toBeUndefined();
  });

  it("keeps earlier text when the final message has only tool calls", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "useful" }] },
      }) + "\n",
    );
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      }) + "\n",
    );
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("useful");
  });

  it("parses a final line without trailing newline", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "last-line" }] },
      }),
    );
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("last-line");
  });

  it("falls back to (no output) for empty text", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("(no output)");
  });

  it("sums per-message usage across the child run", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    // First request: tool-call round trip. message_update's usage is per-request
    // cumulative — it must not be counted; only the message_end total is.
    child.stdoutEmit(`${usageLine(USAGE({ input: 999 }))}\n`);
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash" }],
          usage: USAGE({ input: 1000, output: 40, totalTokens: 1040 }),
        },
      }) + "\n",
    );
    // Second request: final text answer with its own usage.
    child.stdoutEmit(`${usageLine(USAGE({ input: 5 }))}\n`);
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: USAGE({ input: 2000, output: 10, totalTokens: 2010 }) } })}\n`,
    );
    child.close(0);
    const r = await promise;
    expect(r.usage).toEqual(
      USAGE({
        input: 3000,
        output: 50,
        totalTokens: 3050,
        cost: { input: 0.2, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.24 },
      }),
    );
  });

  it("ignores malformed usage payloads", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: "lots" } } })}\n`,
    );
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "more" }], usage: "banana" } })}\n`,
    );
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("more");
    expect(r.usage).toBeUndefined();
  });

  it("rejects a payload whose optional fields are non-numeric", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { ...USAGE(), reasoning: "lots" } } })}\n`,
    );
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("done");
    expect(r.usage).toBeUndefined();
  });

  it("keeps the accumulated sum when a later message_end has no usage", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], usage: USAGE({ input: 100, output: 40, totalTokens: 140 }) } })}\n`,
    );
    child.stdoutEmit(`${assistantLine("done")}\n`);
    child.close(0);
    const r = await promise;
    expect(r.usage).toEqual(USAGE({ input: 100, output: 40, totalTokens: 140 }));
  });

  it("attaches the spent usage to the failure when the child exits non-zero", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: USAGE({ input: 700, output: 30, totalTokens: 730 }) } })}\n`,
    );
    child.stderrEmit("boom\n");
    child.close(2);
    const err = (await promise.catch((e: unknown) => e)) as Error & { usage?: ChildUsage };
    expect(err).toBeInstanceOf(Error);
    expect(err.usage).toEqual(USAGE({ input: 700, output: 30, totalTokens: 730 }));
  });

  it("ignores message_update usage payloads", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    // message_update usage is per-request cumulative and resets between requests;
    // counting it would double-count what message_end already reports.
    child.stdoutEmit(`${usageLine(USAGE({ input: 999 }))}\n`);
    child.stdoutEmit(`${assistantLine("done")}\n`);
    child.close(0);
    const r = await promise;
    expect(r.text).toBe("done");
    expect(r.usage).toBeUndefined();
  });

  it("rejects with stderr tail on non-zero exit", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stderrEmit("boom failure");
    child.close(2);
    await expect(promise).rejects.toThrow(/exited with code 2: boom failure/);
  });

  it("kills and rejects on timeout", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 30 }, () => child);
    await expect(promise).rejects.toThrow(/timed out after 0s/);
    expect(child.killed).toBe(true);
  });

  it("rejects with the abort reason when the signal fires", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000, signal: controller.signal }, () => child);
    controller.abort(new Error("user cancelled"));
    await expect(promise).rejects.toThrow("user cancelled");
    expect(child.killed).toBe(true);
  });

  it("streams updates via onUpdate", async () => {
    const child = fakeChild();
    const updates: string[] = [];
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        timeoutMs: 5000,
        onUpdate: (p: { content: Array<{ type: string; text?: string }> }) =>
          updates.push((p.content[0] as { text: string }).text),
      },
      () => child,
    );
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "wip" }] },
      }) + "\n",
    );
    child.stdoutEmit(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }) + "\n",
    );
    child.close(0);
    await promise;
    expect(updates).toEqual(["wip", "done"]);
  });

  it("rejects when spawn fails", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.fail(new Error("ENOENT pi"));
    await expect(promise).rejects.toThrow(/Failed to spawn pi.*ENOENT/);
  });
});

describe("adoption (runChild)", () => {
  const adoptOpts = { timeoutMs: 5000, adoptAfterMs: 5 };

  it("hands the still-running child to onAdopted and resolves immediately", async () => {
    const child = fakeChild();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    const run = await promise;
    expect(run).toEqual({ adopted: true, id: "bg-1" });
    expect(handle).toBeDefined();
    expect(child.killed).toBe(false); // the child keeps running
  });

  it("delivers text streamed after adoption through the completion promise", async () => {
    const child = fakeChild();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    await promise;
    // The final reply arrives only after the tool result already returned.
    child.stdoutEmit(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "late answer" }], usage: USAGE() },
      })}\n`,
    );
    child.close(0);
    const completion = await handle!.completion;
    expect(completion.text).toBe("late answer");
    expect(completion.usage).toEqual(USAGE());
  });

  it("stops streaming partials once adopted", async () => {
    const child = fakeChild();
    const updates: unknown[] = [];
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onUpdate: (p: unknown) => updates.push(p),
        onAdopted: () => "bg-1",
      },
      () => child,
    );
    await promise;
    child.stdoutEmit(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after" }] } })}\n`,
    );
    child.close(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toHaveLength(0);
  });

  it("detaches the abort signal at adoption: a turn abort no longer kills the child", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        signal: controller.signal,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    await promise;
    controller.abort(new Error("user cancelled"));
    await new Promise((r) => setTimeout(r, 10));
    expect(child.killed).toBe(false);
    child.stdoutEmit(jsonLine("kept going"));
    child.close(0);
    await expect(handle!.completion).resolves.toMatchObject({ text: "kept going" });
  });

  it("still enforces the hard timeout after adoption", async () => {
    const child = fakeChild();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        timeoutMs: 20,
        adoptAfterMs: 5,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    await promise;
    await expect(handle!.completion).rejects.toThrow(/timed out after 0s/);
    expect(child.killed).toBe(true);
  });

  it("carries usage on an adopted child's failure", async () => {
    const child = fakeChild();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    await promise;
    child.stdoutEmit(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: USAGE({ input: 700 }) },
      })}\n`,
    );
    child.stderrEmit("boom");
    child.close(2);
    const err = (await handle!.completion.catch((e: unknown) => e)) as Error & { usage?: ChildUsage };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exited with code 2/);
    expect(err.usage).toEqual(USAGE({ input: 700 }));
  });

  it("never adopts without onAdopted, even past the threshold", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 30, adoptAfterMs: 5 }, () => child);
    await expect(promise).rejects.toThrow(/timed out/); // hard timeout, no adoption
  });

  it("blocks to completion by default: no adoptAfterMs means never adopt, even with onAdopted", async () => {
    const child = fakeChild();
    const onAdopted = vi.fn(() => "bg-1");
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 30, onAdopted }, () => child);
    await expect(promise).rejects.toThrow(/timed out/); // the hard timeout, not adoption, ends it
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it("kills the child when the signal was already aborted at registration", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000, signal: controller.signal }, () => child);
    await expect(promise).rejects.toThrow("cancelled before start");
    expect(child.killed).toBe(true);
  });

  it("rejects via the abort path when abort wins the race with the adopt timer", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const onAdopted = vi.fn(() => "bg-1");
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      { timeoutMs: 5000, adoptAfterMs: 5000, signal: controller.signal, onAdopted },
      () => child,
    );
    controller.abort(new Error("user cancelled"));
    await expect(promise).rejects.toThrow("user cancelled");
    expect(onAdopted).not.toHaveBeenCalled();
    expect(child.killed).toBe(true);
  });

  it("fails the call instead of hanging when onAdopted throws", async () => {
    const child = fakeChild();
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onAdopted: () => {
          throw new Error("registry exploded");
        },
      },
      () => child,
    );
    await expect(promise).rejects.toThrow("registry exploded");
    expect(child.killed).toBe(true);
  });

  it("rejects the completion promise when the child errors after adoption", async () => {
    const child = fakeChild();
    let handle: AdoptedHandle<ChildRun> | undefined;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      {
        ...adoptOpts,
        onAdopted: (h) => {
          handle = h;
          return "bg-1";
        },
      },
      () => child,
    );
    await promise;
    child.fail(new Error("spawn pipe broke"));
    await expect(handle!.completion).rejects.toThrow(/Failed to spawn/);
  });
});

describe("adoptSubagentTask", () => {
  it("wires completion and failure wakes through the registry", async () => {
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage });
    const okChild = fakeChild();
    const failChild = fakeChild();

    const okPromise = runChild(
      AGENT,
      "task",
      undefined,
      { timeoutMs: 5000, adoptAfterMs: 5, onAdopted: (h) => adoptSubagentTask(registry, "reviewer", h, undefined) },
      () => okChild,
    );
    await okPromise;
    okChild.stdoutEmit(jsonLine("all clear"));
    okChild.close(0);

    const failPromise = runChild(
      AGENT,
      "task",
      undefined,
      { timeoutMs: 5000, adoptAfterMs: 5, onAdopted: (h) => adoptSubagentTask(registry, "reviewer", h, undefined) },
      () => failChild,
    );
    await failPromise;
    failChild.stderrEmit("boom");
    failChild.close(2);

    await new Promise((r) => setTimeout(r, 10));
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    const okWake = sendUserMessage.mock.calls[0][0] as string;
    expect(okWake).toContain('[background] subagent "reviewer" (t-');
    expect(okWake).toContain("completed");
    expect(okWake).toContain("all clear");
    const failWake = sendUserMessage.mock.calls[1][0] as string;
    expect(failWake).toContain("failed");
    expect(failWake).toContain("exited with code 2");
  });

  it("sends no wake when the child completes after killAll", async () => {
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage });
    const child = fakeChild();
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      { timeoutMs: 5000, adoptAfterMs: 5, onAdopted: (h) => adoptSubagentTask(registry, "reviewer", h, undefined) },
      () => child,
    );
    await promise;
    registry.killAll();
    child.stdoutEmit(jsonLine("never delivered"));
    child.close(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("includes the usage line and stashes over-cap replies", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "bg-adopt-"));
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage });
    const child = fakeChild();
    const long = `${"r".repeat(4500)}`;
    const promise = runChild(
      AGENT,
      "task",
      undefined,
      { timeoutMs: 5000, adoptAfterMs: 5, onAdopted: (h) => adoptSubagentTask(registry, "reviewer", h, sessionDir) },
      () => child,
    );
    await promise;
    child.stdoutEmit(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: long }], usage: USAGE() },
      })}\n`,
    );
    child.close(0);
    await new Promise((r) => setTimeout(r, 10));
    const wake = sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("105 tokens (100 in / 5 out), $0.120");
    expect(wake).toContain("full reply:");
    expect(wake).not.toContain("r".repeat(4500));
  });
});

describe("formatUsageLine / backgroundedNotice", () => {
  it("formats compact token and cost figures", () => {
    expect(formatUsageLine(USAGE())).toBe("105 tokens (100 in / 5 out), $0.120");
    expect(formatUsageLine(USAGE({ input: 12_000, output: 3_400, totalTokens: 15_400 }))).toBe(
      "15.4k tokens (12.0k in / 3.4k out), $0.120",
    );
  });

  it("tells the model what happened and how the result is received", () => {
    const notice = backgroundedNotice("reviewer", "bg-3");
    expect(notice).toContain('"reviewer"');
    expect(notice).toContain("bg-3");
    // The delivery contract: wakes steer in as the parent's next message,
    // even mid-run — so the notice says the result arrives on its own and
    // forbids sleep-polling (which can only waste time, never help).
    expect(notice).toContain("delivered to you automatically");
    expect(notice).toContain("even mid-run");
    expect(notice).toMatch(/[Nn]ever sleep or poll/);
    expect(notice).toContain("end your turn");
    // No check-in suggestions in the notice — task_remind is scoped to its own tool.
    expect(notice).not.toContain("task_remind");
  });
});

describe("registerSubagentTools with a registry", () => {
  function makePi() {
    const tools = new Map<
      string,
      {
        description?: string;
        promptGuidelines?: string[];
        execute: (
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<unknown>;
        renderCall?: (args: never, theme: never, context?: never) => unknown;
        renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
      }
    >();
    const pi = {
      registerTool: (t: {
        name: string;
        description?: string;
        promptGuidelines?: string[];
        execute: (
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<unknown>;
        renderCall?: (args: never, theme: never, context?: never) => unknown;
        renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
      }) => tools.set(t.name, t),
    };
    return { pi: pi as never, tools };
  }

  /** A child that stays silent until the test drives it. */
  function silentSpawn(children: FakeChild[]): SpawnFn {
    return (): ChildLike => {
      const child = fakeChild();
      children.push(child);
      return child;
    };
  }

  function ctxWithSessionDir(dir?: string) {
    return { sessionManager: { getSessionDir: () => dir } };
  }

  it("teaches the wake contract on every delivery surface", () => {
    const { pi, tools } = makePi();
    registerSubagentTools(pi, mkdtempSync(join(tmpdir(), "agents-")), silentSpawn([]), undefined, undefined);
    // Descriptions are always in context — each surface that mentions
    // backgrounding must teach that wakes arrive automatically (even
    // mid-run) and forbid sleep-polling, with a guideline reinforcing it.
    for (const name of ["subagent", "subagents"]) {
      const tool = tools.get(name)!;
      expect(tool.description).toContain("even mid-run");
      expect(tool.description).toContain("sleep or poll");
      expect((tool.promptGuidelines ?? []).join("\n")).toContain("sleep or poll");
    }
  });

  it("backgrounds a background:true task immediately and wakes on completion", async () => {
    const children: FakeChild[] = [];
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage });
    const { pi, tools } = makePi();
    registerSubagentTools(pi, mkdtempSync(join(tmpdir(), "agents-")), silentSpawn(children), undefined, registry);

    const result = (await tools
      .get("subagent")!
      .execute("1", { task: "t", background: true }, undefined, undefined, ctxWithSessionDir())) as {
      content: Array<{ type: string; text: string }>;
      details: { agent: string; backgrounded: boolean; id: string };
    };
    expect(result.details.backgrounded).toBe(true);
    expect(result.details.id).toMatch(/^t-/);
    expect(result.content[0].text).toContain(result.details.id);
    expect(result.content[0].text).toContain("even mid-run");
    expect(result.content[0].text).toMatch(/[Nn]ever sleep or poll/);
    expect(result.content[0].text).toContain("end your turn");
    expect(registry.running()).toHaveLength(1);

    children[0].stdoutEmit(jsonLine("late but worth it"));
    children[0].close(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][0]).toContain("late but worth it");
    expect(registry.running()).toHaveLength(0);
  });

  it("returns partial results when only some batch tasks background", async () => {
    const children: FakeChild[] = [];
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage });
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\nBody.");
    let call = 0;
    const spawnFn = (): ChildLike => {
      const child = fakeChild();
      children.push(child);
      const i = call++;
      if (i === 0) {
        // Fast child finishes before any adoption.
        setImmediate(() => {
          child.stdoutEmit(
            `${JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "fast ok" }], usage: USAGE() },
            })}\n`,
          );
          child.close(0);
        });
      }
      return child;
    };
    const { pi, tools } = makePi();
    registerSubagentTools(pi, dir, spawnFn as unknown as SpawnFn, undefined, registry);

    const result = (await tools.get("subagents")!.execute(
      "1",
      {
        tasks: [
          { agent: "reviewer", task: "t1" },
          { agent: "reviewer", task: "t2", background: true },
        ],
      },
      undefined,
      undefined,
      ctxWithSessionDir(),
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { count: number; backgrounded?: number };
      usage?: ChildUsage;
    };

    expect(result.content[0].text).toContain("### reviewer\nfast ok");
    expect(result.content[0].text).toMatch(/backgrounded as t-[0-9a-z]+/);
    // The wake contract rides in one shared footer, not per-task paragraphs.
    expect(result.content[0].text).toContain("Still running — backgrounded as");
    expect(result.content[0].text).toContain("still running — if you have nothing else to do, end your turn");
    expect(result.content[0].text).toMatch(/[Nn]ever sleep or poll/);
    expect(result.content[0].text).toContain("don't arm check-ins just to wait");
    expect(result.details).toMatchObject({ count: 2, backgrounded: 1 });
    // Only the fast child's usage rides inline; the slow one's comes in its wake.
    expect(result.usage).toEqual(USAGE());
    expect(registry.running()).toHaveLength(1);
  });

  it("renders backgrounded result rows", () => {
    const single = renderSubagentResult(
      backgroundedNotice("reviewer", "bg-1"),
      { agent: "reviewer", backgrounded: true },
      { isPartial: false, expanded: false, isError: false },
      THEME,
    );
    expect(single).toContain("backgrounded (reviewer)");

    const batch = renderSubagentResult(
      "### reviewer\nok",
      { count: 2, backgrounded: 1 },
      { isPartial: false, expanded: false, isError: false },
      THEME,
    );
    expect(batch).toContain("done (2 subagents, 1 backgrounded)");
  });
});

describe("registerSubagentsExtension (full wiring)", () => {
  interface WiredTool {
    execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
  }

  /** Minimal bash operations fake: enough surface for the bash tool's wiring path. */
  function wireBgOps() {
    let onData: ((chunk: Buffer) => void) | undefined;
    let resolve: ((r: { exitCode: number | null }) => void) | undefined;
    const fake = {
      aborted: false,
      exec: (
        _command: string,
        _cwd: string,
        { onData: d, signal }: { onData: (c: Buffer) => void; signal?: AbortSignal },
      ) => {
        onData = d;
        return new Promise((res, rej) => {
          resolve = res;
          // pi's local ops kill the tree and reject with "aborted" on signal.
          signal?.addEventListener(
            "abort",
            () => {
              fake.aborted = true;
              rej(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      emit: (chunk: string) => onData?.(Buffer.from(chunk)),
      exit: (code: number | null) => resolve?.({ exitCode: code }),
    };
    return fake;
  }
  type WireBgOps = ReturnType<typeof wireBgOps>;

  function wireUp() {
    const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const tools = new Map<string, WiredTool>();
    const children: FakeChild[] = [];
    const bgOps: WireBgOps[] = [];
    const pi = {
      registerTool: (t: { name: string }) => tools.set(t.name, t as unknown as WiredTool),
      registerCommand: () => undefined,
      sendUserMessage,
      on: (event: string, handler: (event?: unknown, ctx?: unknown) => void) => handlers.set(event, handler),
    };
    registerSubagentsExtension(pi as never, {
      agentsDir: mkdtempSync(join(tmpdir(), "agents-")),
      spawnFn: (() => {
        const child = fakeChild();
        children.push(child);
        return child;
      }) as unknown as SpawnFn,
      bgOperations: (() => {
        const ops = wireBgOps();
        bgOps.push(ops);
        return ops;
      }) as never,
    });
    handlers.get("session_start")!(undefined, { ui: { notify, setStatus } });
    return { handlers, sendUserMessage, notify, setStatus, tools, children, bgOps };
  }

  async function runBackgroundedTask(tools: Map<string, WiredTool>, children: FakeChild[]) {
    const result = (await tools.get("subagent")!.execute("1", { task: "t", background: true }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    })) as { details: { id: string } };
    expect(children[0].killed).toBe(false);
    return result;
  }

  it("delivers wakes as steering so a busy or sleep-polling model receives them", async () => {
    const wired = wireUp();
    await runBackgroundedTask(wired.tools, wired.children);

    // Child settles: the wake must go out with deliverAs "steer". A followUp
    // wake queues until the run ends — a model that keeps calling tools
    // (e.g. sleeping to "wait") would never receive it. Steering lands at the
    // parent's next turn boundary, even mid-run, making the livelock
    // impossible by mechanism.
    wired.children[0].stdoutEmit(jsonLine("done"));
    wired.children[0].close(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text, options] = wired.sendUserMessage.mock.calls[0] as [string, { deliverAs?: string }];
    expect(text).toContain("[background]");
    expect(options?.deliverAs).toBe("steer");
  });

  it("delivers bash-task wakes through the same steered channel as subagent wakes", async () => {
    const wired = wireUp();
    await wired.tools
      .get("bash")!
      .execute("1", { command: "just check 2>&1", wait: "background" }, undefined, undefined, {
        sessionManager: { getSessionDir: () => undefined },
      });

    // The bash kind must ride the same steered wake channel — a split
    // (bash queueing as followUp) would reintroduce the sleep-poll livelock
    // for shell tasks only.
    wired.bgOps[0].emit("ok\n");
    wired.bgOps[0].exit(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text, options] = wired.sendUserMessage.mock.calls[0] as [string, { deliverAs?: string }];
    expect(text).toContain("[background] bash");
    expect(options?.deliverAs).toBe("steer");
  });

  it("kills backgrounded children on session replacement and explains the lost wake", async () => {
    const wired = wireUp();
    await runBackgroundedTask(wired.tools, wired.children);

    wired.handlers.get("session_shutdown")!({ reason: "fork" });
    expect(wired.children[0].killed).toBe(true);
    expect(wired.notify).toHaveBeenCalledWith(expect.stringContaining("killed 1"), "warning");
    expect(wired.notify).toHaveBeenCalledWith(expect.stringContaining("results will not arrive"), "warning");

    // The killed child's close event lands after the kill: no wake for it.
    wired.children[0].stdoutEmit(jsonLine("too late"));
    wired.children[0].close(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.sendUserMessage).not.toHaveBeenCalled();
  });

  it("registers the bash tool and kills its task on shutdown alongside subagents", async () => {
    const wired = wireUp();
    const result = (await wired.tools
      .get("bash")!
      .execute("1", { command: "sleep 60", wait: "background" }, undefined, undefined, {
        sessionManager: { getSessionDir: () => undefined },
      })) as { details: { id: string } };
    expect(result.details.id).toMatch(/^t-/);
    expect(wired.bgOps[0].aborted).toBe(false);

    wired.handlers.get("session_shutdown")!({ reason: "fork" });
    await new Promise((r) => setTimeout(r, 10)); // killAll marks killed, then close lands
    expect(wired.bgOps[0].aborted).toBe(true);
    expect(wired.sendUserMessage).not.toHaveBeenCalled(); // killed tasks never wake
    expect(wired.notify).toHaveBeenCalledWith(expect.stringContaining("killed 1"), "warning");
  });

  it("stays silent on quit and reload shutdowns", async () => {
    const wired = wireUp();
    await runBackgroundedTask(wired.tools, wired.children);

    wired.handlers.get("session_shutdown")!({ reason: "quit" });
    expect(wired.children[0].killed).toBe(true);
    expect(wired.notify).not.toHaveBeenCalled();
  });
});

describe("sumUsages", () => {
  it("sums per-child run totals across a batch", () => {
    expect(sumUsages([USAGE({ input: 100, output: 40 }), USAGE({ input: 50, output: 10 })])).toEqual(
      USAGE({
        input: 150,
        output: 50,
        totalTokens: 210,
        cost: { input: 0.2, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.24 },
      }),
    );
  });

  it("skips children that reported none and returns undefined when no child did", () => {
    expect(sumUsages([USAGE(), undefined, USAGE({ input: 1 })])).toEqual(
      USAGE({
        input: 101,
        output: 10,
        totalTokens: 210,
        cost: { input: 0.2, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.24 },
      }),
    );
    expect(sumUsages([undefined, undefined])).toBeUndefined();
    expect(sumUsages([])).toBeUndefined();
  });

  it("carries optional reasoning and cacheWrite1h fields through the sum", () => {
    expect(
      sumUsages([USAGE({ reasoning: 3, cacheWrite1h: 5 }), USAGE({ reasoning: 4, cacheWrite1h: 7 })]),
    ).toMatchObject({
      reasoning: 7,
      cacheWrite1h: 12,
    });
    expect(sumUsages([USAGE({ reasoning: 3 }), USAGE()])).toMatchObject({ reasoning: 3 });
  });
});

describe("runWithLimit", () => {
  it("preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const jobs = [1, 2, 3, 4, 5].map((n) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 3) throw new Error(`fail-${n}`);
      return n * 10;
    });
    const results = await runWithLimit(jobs, 2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(
      results.map((r: PromiseSettledResult<number>) =>
        r.status === "fulfilled" ? r.value : `ERR:${(r.reason as Error).message}`,
      ),
    ).toEqual([10, 20, "ERR:fail-3", 40, 50]);
  });
});

describe("DEFAULT_AGENT_MD", () => {
  it("parses as a read-only generic agent", () => {
    const agent = agentFromText(DEFAULT_AGENT_MD, "fallback");
    expect(agent.name).toBe("generic");
    expect(agent.tools).not.toContain("write");
    expect(agent.tools).not.toContain("edit");
    expect(agent.instructions.trim().length).toBeGreaterThan(50);
  });
});

describe("resolveAgentDef", () => {
  const list: AgentDef[] = [{ name: "reviewer", description: "", instructions: "review", tools: ["read"] }];

  it("resolves a named agent", () => {
    expect(resolveAgentDef(list, { agent: "reviewer" }).name).toBe("reviewer");
  });

  it("resolves an inline definition", () => {
    const agent = resolveAgentDef(list, {
      agent_md: "---\nname: sql-auditor\nmodel: gw-a/foo\ntools: read,bash\n---\nAudit SQL.",
    });
    expect(agent.name).toBe("sql-auditor");
    expect(agent.model).toBe("gw-a/foo");
    expect(agent.tools).toEqual(["read", "bash"]);
    expect(agent.instructions).toBe("Audit SQL.");
  });

  it("falls back to the generic default when neither is given", () => {
    const agent = resolveAgentDef(list, {});
    expect(agent.name).toBe("generic");
    expect(agent.tools).not.toContain("write");
  });

  it("rejects agent and agent_md together", () => {
    expect(() => resolveAgentDef(list, { agent: "reviewer", agent_md: "---\nx" })).toThrow(/not both/);
  });

  it("throws for an unknown agent name", () => {
    expect(() => resolveAgentDef(list, { agent: "nope" })).toThrow(/not found/);
  });
});

describe("refLabel", () => {
  it("labels named, inline, and default refs", () => {
    expect(refLabel({ agent: "reviewer" })).toBe("reviewer");
    expect(refLabel({ agent_md: "---\nname: sql-auditor\n---\nbody" })).toBe("sql-auditor");
    expect(refLabel({ agent_md: "no frontmatter" })).toBe("generic");
    expect(refLabel({})).toBe("generic");
  });

  it("falls back to generic for unparseable agent_md", () => {
    expect(refLabel({ agent_md: "---\nname: [unclosed\n---\nbody" })).toBe("generic");
  });
});

describe("registerSubagentTools", () => {
  function makePi() {
    const tools = new Map<
      string,
      {
        execute: (
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<unknown>;
        renderCall?: (args: never, theme: never, context?: never) => unknown;
        renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
      }
    >();
    const pi = {
      registerTool: (t: {
        name: string;
        execute: (
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<unknown>;
        renderCall?: (args: never, theme: never, context?: never) => unknown;
        renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
      }) => tools.set(t.name, t),
    };
    return { pi: pi as never, tools };
  }

  function spawnReturning(lines: string[], calls: string[][]) {
    return (command: string, args: string[], _options: { stdio: ["ignore", "pipe", "pipe"] }): ChildLike => {
      calls.push([command, ...args]);
      const child = fakeChild();
      setImmediate(() => {
        for (const line of lines) child.stdoutEmit(line + "\n");
        child.close(0);
      });
      return child;
    };
  }

  function jsonLine(text: string): string {
    return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  }

  it("forwards child usage on the single subagent tool result", async () => {
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              usage: USAGE({ output: 40, totalTokens: 140 }),
            },
          }),
        ],
        [],
      ),
    );
    const result = (await tools.get("subagent")!.execute("1", { task: "t" })) as { usage?: ChildUsage };
    expect(result.usage).toEqual(USAGE({ output: 40, totalTokens: 140 }));
  });

  it("children inherit the parent chat's model, and the param still overrides", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning([jsonLine("done")], calls),
    );
    const ctx = { model: { provider: "zai", id: "glm-5.3" } };
    await tools.get("subagent")!.execute("1", { task: "t" }, undefined, undefined, ctx);
    expect(calls[0][calls[0].indexOf("--model") + 1]).toBe("zai/glm-5.3");

    calls.length = 0;
    await tools.get("subagent")!.execute("1", { task: "t", model: "yeti/other" }, undefined, undefined, ctx);
    expect(calls[0][calls[0].indexOf("--model") + 1]).toBe("yeti/other");

    // No session model (ctx absent) and no pins: no --model flag, pi's default applies.
    calls.length = 0;
    await tools.get("subagent")!.execute("1", { task: "t" });
    expect(calls[0].includes("--model")).toBe(false);
  });

  it("batch children inherit the parent chat's model per task", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning([jsonLine("done")], calls),
    );
    const ctx = { model: { provider: "yeti", id: "ornith-1.5" } };
    await tools
      .get("subagents")!
      .execute("1", { tasks: [{ task: "a" }, { task: "b", model: "zai/glm-5.3" }] }, undefined, undefined, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0][calls[0].indexOf("--model") + 1]).toBe("yeti/ornith-1.5");
    expect(calls[1][calls[1].indexOf("--model") + 1]).toBe("zai/glm-5.3");
  });

  it("omits usage when no child reported any", async () => {
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")), spawnReturning([jsonLine("done")], []));
    const result = (await tools.get("subagent")!.execute("1", { task: "t" })) as { usage?: ChildUsage };
    expect(result.usage).toBeUndefined();
  });

  it("aggregates usage across the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\nReview things.");
    const perCall: string[][] = [];
    const spawnFn = (_c: string, _a: string[], _o: unknown): ChildLike => {
      perCall.push([]);
      const child = fakeChild();
      setImmediate(() => {
        child.stdoutEmit(
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              usage: USAGE({ input: 100, output: 40, totalTokens: 140 }),
            },
          }) + "\n",
        );
        child.close(0);
      });
      return child;
    };
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, dir, spawnFn as unknown as SpawnFn);
    const result = (await tools.get("subagents")!.execute("1", {
      tasks: [{ agent: "reviewer", task: "t1" }, { task: "t2" }],
    })) as { usage?: ChildUsage };
    expect(perCall.length).toBe(2);
    expect(result.usage).toEqual(
      USAGE({
        input: 200,
        output: 80,
        totalTokens: 280,
        cost: { input: 0.2, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.24 },
      }),
    );
  });

  it("credits usage from failed children in the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\nReview things.");
    let call = 0;
    const spawnFn = (_c: string, _a: string[], _o: unknown): ChildLike => {
      const child = fakeChild();
      setImmediate(() => {
        if (call++ === 0) {
          // First child succeeds.
          child.stdoutEmit(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: USAGE({ input: 100, output: 40, totalTokens: 140 }) } })}\n`,
          );
          child.close(0);
        } else {
          // Second child burns tokens, then dies — its spend still counts.
          child.stdoutEmit(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: USAGE({ input: 700, output: 30, totalTokens: 730 }) } })}\n`,
          );
          child.stderrEmit("boom\n");
          child.close(2);
        }
      });
      return child;
    };
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, dir, spawnFn as unknown as SpawnFn);
    const result = (await tools.get("subagents")!.execute("1", {
      tasks: [
        { agent: "reviewer", task: "t1" },
        { agent: "reviewer", task: "t2" },
      ],
    })) as { content: Array<{ type: string; text: string }>; usage?: ChildUsage };
    expect(result.content[0].text).toContain("ERROR:");
    expect(result.usage).toEqual(
      USAGE({
        input: 800,
        output: 70,
        totalTokens: 870,
        cost: { input: 0.2, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.24 },
      }),
    );
  });

  it("runs a mixed batch: named, inline, and default agents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\nReview things.");
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, dir, spawnReturning([jsonLine("ok")], calls));

    const result = (await tools.get("subagents")!.execute("1", {
      tasks: [
        { agent: "reviewer", task: "t1" },
        { agent_md: "---\nname: inline-x\n---\nDo x.", task: "t2" },
        { task: "t3" },
      ],
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toContain("### reviewer\nok");
    expect(result.content[0].text).toContain("### inline-x\nok");
    expect(result.content[0].text).toContain("### generic\nok");
    expect(calls.length).toBe(3);
    // default agent must not get write/edit tools
    const defaultArgs = calls[2].join(" ");
    expect(defaultArgs).not.toContain("write");
  });

  it("single subagent tool uses the generic default and reports its name", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning([jsonLine("done")], calls),
    );

    const result = (await tools.get("subagent")!.execute("1", { task: "just look" })) as {
      content: Array<{ type: string; text: string }>;
      details: { agent: string };
    };
    expect(result.content[0].text).toBe("done");
    expect(result.details.agent).toBe("generic");
  });

  it("tool call rows render the agent name from the call arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\nBody.");
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, dir);

    const single = tools.get("subagent")!.renderCall!({ agent: "reviewer", task: "t" } as never, THEME);
    expect(renderPlain(single as never)).toContain("reviewer");

    const batch = tools.get("subagents")!.renderCall!({ tasks: [{ agent: "reviewer", task: "t" }] } as never, THEME);
    expect(renderPlain(batch as never)).toContain("reviewer");
  });

  it("tool call rows tolerate partially streamed arguments", () => {
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")));

    const context = { lastComponent: undefined } as never;
    const single = tools.get("subagent")!.renderCall!({} as never, THEME, context);
    expect(renderPlain(single as never)).toContain("subagent ");

    const batch = tools.get("subagents")!.renderCall!({} as never, THEME, context);
    expect(renderPlain(batch as never)).toContain("subagents");
    expect(renderPlain(batch as never)).not.toContain("(0)");
  });

  it("result rows render status and summary from the tool result", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning([jsonLine("all clear")], calls),
    );

    const result = await tools.get("subagent")!.execute("1", { task: "t" });
    const rendered = tools.get("subagent")!.renderResult!(
      result as never,
      { isPartial: false, expanded: false } as never,
      THEME,
      { args: { task: "t" }, isError: false } as never,
    );
    expect(renderPlain(rendered as never)).toContain("done (generic)");
    expect(renderPlain(rendered as never)).toContain("all clear");
  });

  it("result rows render a running partial with the streamed tail", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(
      pi as never,
      mkdtempSync(join(tmpdir(), "agents-")),
      spawnReturning([jsonLine("first"), jsonLine("second")], calls),
    );

    const partials: unknown[] = [];
    const execute = tools.get("subagent")!.execute as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: (r: unknown) => void,
    ) => Promise<unknown>;
    await execute("1", { task: "t" }, undefined, (r) => partials.push(r));

    expect(partials.length).toBeGreaterThan(0);
    const rendered = tools.get("subagent")!.renderResult!(
      partials[partials.length - 1] as never,
      { isPartial: true, expanded: false } as never,
      THEME,
      { args: { task: "t" }, isError: false } as never,
    );
    expect(renderPlain(rendered as never)).toContain("running (generic)");
    expect(renderPlain(rendered as never)).toContain("second");
  });

  it("result rows recover the agent name from call arguments on the error path", () => {
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")));

    // pi clears details on thrown errors; only the call arguments remain.
    const rendered = tools.get("subagent")!.renderResult!(
      { content: [{ type: "text", text: 'Agent "ghost" not found' }], details: {} } as never,
      { isPartial: false, expanded: false } as never,
      THEME,
      { args: { agent: "ghost", task: "t" }, isError: true } as never,
    );
    expect(renderPlain(rendered as never)).toContain("failed (ghost)");
    expect(renderPlain(rendered as never)).toContain('Agent "ghost" not found');
  });

  it("batch result rows render the task count", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")), spawnReturning([jsonLine("ok")], calls));

    const result = await tools.get("subagents")!.execute("1", { tasks: [{ task: "t1" }, { task: "t2" }] });
    const rendered = tools.get("subagents")!.renderResult!(
      result as never,
      { isPartial: false, expanded: false } as never,
      THEME,
      { args: { tasks: [{ task: "t1" }, { task: "t2" }] }, isError: false } as never,
    );
    expect(renderPlain(rendered as never)).toContain("done (2 subagents)");
  });

  it("surfaces an error section for an unknown agent without failing the batch", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")), spawnReturning([jsonLine("ok")], calls));

    const result = (await tools.get("subagents")!.execute("1", {
      tasks: [{ agent: "ghost", task: "t" }, { task: "t2" }],
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toContain('### ghost\nERROR: Agent "ghost" not found');
    expect(result.content[0].text).toContain("### generic\nok");
    expect(calls.length).toBe(1);
  });
});

describe("isValidCommandName", () => {
  it("accepts single-word names", () => {
    expect(isValidCommandName("code-reviewer")).toBe(true);
    expect(isValidCommandName("sme2")).toBe(true);
    expect(isValidCommandName("_private")).toBe(true);
  });

  it("rejects names with spaces or empty names", () => {
    expect(isValidCommandName("two words")).toBe(false);
    expect(isValidCommandName("")).toBe(false);
    expect(isValidCommandName("-leading")).toBe(false);
    expect(isValidCommandName("a/b")).toBe(false);
  });
});

describe("buildCommandPrompt", () => {
  it("names the agent and embeds the task", () => {
    const prompt = buildCommandPrompt("reviewer", "check the auth flow");
    expect(prompt).toContain('"reviewer"');
    expect(prompt).toContain("check the auth flow");
    expect(prompt).toContain("only sees what you send");
  });
});

describe("registerSubagentCommands", () => {
  interface Registered {
    description?: string;
    handler: (args: string, ctx: { ui: { notify: (msg: string, type?: string) => void } }) => Promise<void>;
  }

  function makePi() {
    const commands = new Map<string, Registered>();
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    const pi = {
      registerCommand: (name: string, opts: Registered) => commands.set(name, opts),
      sendUserMessage,
    };
    return { pi: pi as never, commands, sendUserMessage, notify, ctx: ctx as never };
  }

  function agentsDirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it("registers one command per agent file, keyed by name with frontmatter description", () => {
    const dir = agentsDirWith({
      "code-reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\n---\nBody.",
      "sme.md": "---\nname: subject-matter-expert\ndescription: Deep expertise.\n---\nBody.",
    });
    const { pi, commands } = makePi();
    registerSubagentCommands(pi, dir);

    expect([...commands.keys()].sort()).toEqual(["code-reviewer", "subject-matter-expert"]);
    expect(commands.get("code-reviewer")!.description).toBe("Reviews code.");
  });

  it("falls back to a generic description when frontmatter omits one", () => {
    const dir = agentsDirWith({ "worker.md": "---\nname: worker\n---\nBody." });
    const { pi, commands } = makePi();
    registerSubagentCommands(pi, dir);

    expect(commands.get("worker")!.description).toBe("Delegate a task to the worker subagent");
  });

  it("filename is the fallback command name", () => {
    const dir = agentsDirWith({ "lint.md": "---\ndescription: Lints.\n---\nBody." });
    const { pi, commands } = makePi();
    registerSubagentCommands(pi, dir);

    expect(commands.has("lint")).toBe(true);
  });

  it("sends a delegation user message when invoked with a task", async () => {
    const dir = agentsDirWith({
      "code-reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\n---\nBody.",
    });
    const { pi, commands, sendUserMessage, ctx } = makePi();
    registerSubagentCommands(pi, dir);

    await commands.get("code-reviewer")!.handler("  review src/auth.ts  ", ctx);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sendUserMessage.mock.calls[0] as [string, { deliverAs?: string }];
    expect(message).toContain('"code-reviewer"');
    expect(message).toContain("review src/auth.ts");
    expect(options?.deliverAs).toBe("followUp");
  });

  it("notifies usage instead of sending when invoked without a task", async () => {
    const dir = agentsDirWith({
      "code-reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\n---\nBody.",
    });
    const { pi, commands, sendUserMessage, notify, ctx } = makePi();
    registerSubagentCommands(pi, dir);

    await commands.get("code-reviewer")!.handler("   ", ctx);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Usage: /code-reviewer <task>");
    expect(notify.mock.calls[0][0]).toContain("Reviews code.");
  });

  it("skips agents whose names are not valid command names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dir = agentsDirWith({
        "weird.md": "---\nname: two words\ndescription: d\n---\nBody.",
        "fine.md": "---\nname: fine\ndescription: d\n---\nBody.",
      });
      const { pi, commands } = makePi();
      registerSubagentCommands(pi, dir);

      expect([...commands.keys()]).toEqual(["fine"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"two words"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("skips agent names reserved by pi built-in commands", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dir = agentsDirWith({
        "copy.md": "---\nname: copy\ndescription: A copywriter.\n---\nBody.",
        "fine.md": "---\nname: fine\ndescription: d\n---\nBody.",
      });
      const { pi, commands } = makePi();
      registerSubagentCommands(pi, dir);

      expect([...commands.keys()]).toEqual(["fine"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reserved"));
    } finally {
      warn.mockRestore();
    }
  });

  it("registers the first command for a duplicated agent name and skips the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first: AgentDef = { name: "reviewer", description: "first", instructions: "A", tools: [...BUILTIN_TOOLS] };
      const second: AgentDef = {
        name: "reviewer",
        description: "second",
        instructions: "B",
        tools: [...BUILTIN_TOOLS],
      };
      const { pi, commands } = makePi();
      registerCommandsForAgents(pi, [first, second]);

      expect([...commands.keys()]).toEqual(["reviewer"]);
      expect(commands.get("reviewer")!.description).toBe("first");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate"));
    } finally {
      warn.mockRestore();
    }
  });

  it("registers nothing when the agents directory is empty or missing", () => {
    const { pi, commands } = makePi();
    registerSubagentCommands(pi, mkdtempSync(join(tmpdir(), "agents-")));
    expect(commands.size).toBe(0);

    registerSubagentCommands(pi, join(tmpdir(), "does-not-exist-xyz"));
    expect(commands.size).toBe(0);
  });
});

describe("summarizeTask", () => {
  it("passes short tasks through", () => {
    expect(summarizeTask("review src/auth.ts")).toBe("review src/auth.ts");
  });

  it("collapses whitespace to one line", () => {
    expect(summarizeTask("line one\n   line two\t\ttab")).toBe("line one line two tab");
  });

  it("truncates long tasks with an ellipsis", () => {
    const out = summarizeTask("x".repeat(100));
    expect(out.length).toBe(72);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("tool call rendering", () => {
  it("subagent call shows the named agent and task summary", () => {
    const text = renderSubagentCall("code-reviewer", "review the staged changes", THEME as never);
    expect(text).toContain("subagent ");
    expect(text).toContain("code-reviewer");
    expect(text).toContain("review the staged changes");
  });

  it("subagent call truncates long tasks", () => {
    const text = renderSubagentCall("reviewer", `${"y".repeat(100)}\nmore`, THEME as never);
    expect(text.length).toBeLessThanOrEqual("subagent ".length + "reviewer".length + 3 + 72);
    expect(text).toContain("...");
  });

  it("subagents call shows the count and every agent name", () => {
    const text = renderSubagentsCall(["reviewer", "generic", "inline-x"], THEME as never);
    expect(text).toContain("subagents (3)");
    expect(text).toContain("reviewer, generic, inline-x");
  });

  it("subagents call caps the name list", () => {
    const text = renderSubagentsCall(["a", "b", "c", "d", "e"], THEME as never);
    expect(text).toContain("subagents (5)");
    expect(text).toContain("a, b, c, d, ...");
    expect(text).not.toContain(" e");
  });

  it("subagents call without names renders a bare title", () => {
    expect(renderSubagentsCall([], THEME as never)).toBe("subagents");
  });
});

describe("renderSubagentResult", () => {
  const DONE = { isPartial: false, expanded: false, isError: false };

  it("shows a running status with the streamed tail while partial", () => {
    const text = renderSubagentResult(
      "thinking...\nstill working",
      { agent: "reviewer" },
      { isPartial: true, expanded: false, isError: false },
      THEME as never,
    );
    expect(text).toContain("running (reviewer)...");
    expect(text).toContain("still working");
    expect(text).not.toContain("thinking");
  });

  it("shows a bare running status before any output arrives", () => {
    const text = renderSubagentResult(
      "",
      { agent: "reviewer" },
      { isPartial: true, expanded: false, isError: false },
      THEME as never,
    );
    expect(text).toBe("running (reviewer)...");
  });

  it("summarizes a finished single-agent result with its first line", () => {
    const text = renderSubagentResult("## Summary\nAll good", { agent: "reviewer" }, DONE, THEME as never);
    expect(text).toContain("done (reviewer)");
    expect(text).toContain("## Summary");
    expect(text).not.toContain("All good");
  });

  it("reports failures with the error's first line, without details (pi clears them)", () => {
    const text = renderSubagentResult('Agent "ghost" not found', {}, { ...DONE, isError: true }, THEME as never);
    expect(text).toContain("failed");
    expect(text).toContain('Agent "ghost" not found');
  });

  it("summarizes a batch result by count, not content", () => {
    const text = renderSubagentResult("### reviewer\nok", { count: 3 }, DONE, THEME as never);
    expect(text).toContain("done (3 subagents)");
    expect(text).not.toContain("### reviewer");
  });

  it("previews the full reply when expanded and hints at truncation", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const text = renderSubagentResult(body, { agent: "reviewer" }, { ...DONE, expanded: true }, THEME as never);
    expect(text).toContain("line 0");
    expect(text).toContain("line 14");
    expect(text).not.toContain("line 15");
    expect(text).toContain("... (5 more lines)");
  });

  it("truncates long summary lines", () => {
    const text = renderSubagentResult("x".repeat(200), { agent: "r" }, DONE, THEME as never);
    expect(text).toContain("...");
    expect(text.length).toBeLessThanOrEqual("done (r) — ".length + 100);
  });
});
