import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentFromText,
  BUILTIN_TOOLS,
  buildChildArgs,
  extractAssistantText,
  loadAgents,
  parseConcurrency,
  parseTimeoutMs,
  runChild,
  runWithLimit,
  splitFrontmatter,
  type AgentDef,
  type ChildLike,
  type SpawnFn,
} from "../extensions/subagents";

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

  it("parses nested maps", () => {
    const { fm } = splitFrontmatter("---\ntools:\n  write: false\n  edit: false\n---\nBody");
    expect(fm.tools).toEqual({ write: "false", edit: "false" });
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
});

describe("loadAgents", () => {
  it("skips unreadable files with a warning and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
    writeFileSync(join(dir, "good.md"), "---\ndescription: ok\n---\nBody");
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
