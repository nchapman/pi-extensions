import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentFromText,
  buildCommandPrompt,
  BUILTIN_TOOLS,
  buildChildArgs,
  DEFAULT_AGENT_MD,
  extractAssistantText,
  isValidCommandName,
  loadAgents,
  parseConcurrency,
  parseTimeoutMs,
  refLabel,
  registerCommandsForAgents,
  registerSubagentCommands,
  registerSubagentTools,
  renderSubagentCall,
  renderSubagentsCall,
  resolveAgentDef,
  runChild,
  runWithLimit,
  splitFrontmatter,
  summarizeTask,
  type AgentDef,
  type ChildLike,
  type SpawnFn,
} from "../extensions/subagents";

/** Identity theme: strips styling so assertions see plain text. */
const THEME = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

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

describe("runChild", () => {
  it("returns the last assistant text", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child;
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, spawnFn);
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }) + "\n");
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } }) + "\n");
    child.close(0);
    await expect(promise).resolves.toBe("final");
  });

  it("keeps earlier text when the final message has only tool calls", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "useful" }] } }) + "\n");
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }) + "\n");
    child.close(0);
    await expect(promise).resolves.toBe("useful");
  });

  it("parses a final line without trailing newline", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "last-line" }] } }));
    child.close(0);
    await expect(promise).resolves.toBe("last-line");
  });

  it("falls back to (no output) for empty text", async () => {
    const child = fakeChild();
    const promise = runChild(AGENT, "task", undefined, { timeoutMs: 5000 }, () => child);
    child.close(0);
    await expect(promise).resolves.toBe("(no output)");
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
    const promise = runChild(AGENT, "task", undefined, {
      timeoutMs: 5000,
      onUpdate: (p: { content: Array<{ type: string; text?: string }> }) => updates.push((p.content[0] as { text: string }).text),
    }, () => child);
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "wip" }] } }) + "\n");
    child.stdoutEmit(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
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
    expect(results.map((r: PromiseSettledResult<number>) => (r.status === "fulfilled" ? r.value : `ERR:${(r.reason as Error).message}`))).toEqual([
      10, 20, "ERR:fail-3", 40, 50,
    ]);
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
  const list: AgentDef[] = [
    { name: "reviewer", description: "", instructions: "review", tools: ["read"] },
  ];

  it("resolves a named agent", () => {
    expect(resolveAgentDef(list, { agent: "reviewer" }).name).toBe("reviewer");
  });

  it("resolves an inline definition", () => {
    const agent = resolveAgentDef(list, {
      agent_md: "---\nname: sql-auditor\nmodel: yeti/foo\ntools: read,bash\n---\nAudit SQL.",
    });
    expect(agent.name).toBe("sql-auditor");
    expect(agent.model).toBe("yeti/foo");
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
    const tools = new Map<string, {
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
    }>();
    const pi = {
      registerTool: (t: {
        name: string;
        execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
        renderCall?: (args: never, theme: never, context?: never) => unknown;
      }) =>
        tools.set(t.name, t),
    };
    return { pi: pi as never, tools };
  }

  function spawnReturning(lines: string[], calls: string[][]) {
    return (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"] }): ChildLike => {
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
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")), spawnReturning([jsonLine("done")], calls));

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

  it("surfaces an error section for an unknown agent without failing the batch", async () => {
    const calls: string[][] = [];
    const { pi, tools } = makePi();
    registerSubagentTools(pi as never, mkdtempSync(join(tmpdir(), "agents-")), spawnReturning([jsonLine("ok")], calls));

    const result = (await tools.get("subagents")!.execute("1", {
      tasks: [{ agent: "ghost", task: "t" }, { task: "t2" }],
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toContain("### ghost\nERROR: Agent \"ghost\" not found");
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
    const dir = agentsDirWith({ "code-reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\n---\nBody." });
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
    const dir = agentsDirWith({ "code-reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\n---\nBody." });
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
      const second: AgentDef = { name: "reviewer", description: "second", instructions: "B", tools: [...BUILTIN_TOOLS] };
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
