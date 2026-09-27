import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BUILT_IN_TOOLS,
  DEFAULT_MAX_CHARS,
  MIN_MAX_CHARS,
  isBuiltInTool,
  maxCharsFromEnv,
  registerOverflow,
  renderCappedResult,
  splitHeadTail,
  stashPath,
  textLength,
} from "../extensions/overflow";

type Part = { type: string; text?: string; [k: string]: unknown };

function makePi() {
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      events.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, events };
}

/** Fire the captured tool_result handler with a realistic event + ctx. */
function fireResult(
  events: Map<string, (event?: unknown, ctx?: unknown) => unknown>,
  event: Record<string, unknown>,
  ctx?: unknown,
) {
  const handler = events.get("tool_result");
  if (!handler) throw new Error("no tool_result handler registered");
  return handler(event, ctx);
}

function resultEvent(toolName: string, parts: Part[], toolCallId = "call_1"): Record<string, unknown> {
  return { type: "tool_result", toolName, toolCallId, content: parts, isError: false, details: undefined, input: {} };
}

const ctxWithDir = (dir: string): ExtensionContext =>
  ({ sessionManager: { getSessionDir: () => dir } }) as unknown as ExtensionContext;

describe("maxCharsFromEnv", () => {
  it("defaults to 10,000", () => {
    expect(maxCharsFromEnv({})).toBe(DEFAULT_MAX_CHARS);
    expect(DEFAULT_MAX_CHARS).toBe(10_000);
  });

  it("0 disables the extension", () => {
    expect(maxCharsFromEnv({ PI_OVERFLOW_MAX_CHARS: "0" })).toBe(0);
  });

  it("clamps small values up to the floor", () => {
    expect(maxCharsFromEnv({ PI_OVERFLOW_MAX_CHARS: "100" })).toBe(MIN_MAX_CHARS);
    expect(MIN_MAX_CHARS).toBe(1_000);
  });

  it("respects valid overrides", () => {
    expect(maxCharsFromEnv({ PI_OVERFLOW_MAX_CHARS: "25000" })).toBe(25_000);
  });

  it("falls back to the default on garbage", () => {
    expect(maxCharsFromEnv({ PI_OVERFLOW_MAX_CHARS: "banana" })).toBe(DEFAULT_MAX_CHARS);
  });
});

describe("isBuiltInTool", () => {
  it("mirrors pi's built-in tool set (they self-truncate)", () => {
    expect([...BUILT_IN_TOOLS]).toEqual(["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"]);
    for (const name of BUILT_IN_TOOLS) expect(isBuiltInTool(name)).toBe(true);
  });

  it("treats everything else — MCP and extension tools — as cappable", () => {
    expect(isBuiltInTool("mcp__playwright__browser_snapshot")).toBe(false);
    expect(isBuiltInTool("recall")).toBe(false);
    expect(isBuiltInTool("subagents")).toBe(false);
  });
});

describe("textLength", () => {
  it("sums text parts and ignores images", () => {
    const parts = [
      { type: "text", text: "abc" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "de" },
    ];
    expect(textLength(parts)).toBe(5);
  });

  it("handles empty content", () => {
    expect(textLength([])).toBe(0);
  });
});

describe("splitHeadTail", () => {
  it("splits a newline-free blob 80/20 with the rest omitted", () => {
    const { head, tail, omitted } = splitHeadTail("x".repeat(10_000), 1_000);
    expect(head.length).toBe(800);
    expect(tail.length).toBe(200);
    expect(omitted).toBe(9_000);
  });

  it("snaps both cuts to line boundaries when lines are short", () => {
    const text = Array.from({ length: 2_000 }, (_, i) => `line-${i}`).join("\n");
    const { head, tail, omitted } = splitHeadTail(text, 1_000);
    expect(head.endsWith("\n")).toBe(true);
    expect(
      head
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("line-")),
    ).toBe(true);
    expect(tail.startsWith("line-")).toBe(true);
    expect(omitted).toBe(text.length - head.length - tail.length);
    expect(head.length + tail.length).toBeGreaterThanOrEqual(700);
  });

  it("keeps the whole budget when text has no useful boundary near a cut", () => {
    // One giant line: nothing to snap to, raw slices are the best available.
    const text = "y".repeat(5_000);
    const { head, tail, omitted } = splitHeadTail(text, 1_000);
    expect(head + tail + "y".repeat(omitted)).toHaveLength(text.length);
  });

  it("never lets head+tail exceed the budget, whatever the text shape", () => {
    // Deterministic pseudo-random sweep (fixed seed — no flaky CI).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const lineLen = 1 + rand(40);
      const line = "a".repeat(lineLen);
      const text = Array.from({ length: 1 + rand(500) }, () => line).join("\n");
      const budget = 100 + rand(2_000);
      if (text.length <= budget) continue;
      const { head, tail, omitted } = splitHeadTail(text, budget);
      expect(head.length + tail.length).toBeLessThanOrEqual(budget);
      expect(omitted).toBeGreaterThanOrEqual(1);
      expect(text.startsWith(head)).toBe(true);
      expect(text.endsWith(tail)).toBe(true);
    }
  });
});

describe("renderCappedResult", () => {
  it("names the counts, the limit, the stash path, and the recovery route", () => {
    const out = renderCappedResult({
      head: "HEAD",
      tail: "TAIL",
      omitted: 48_593,
      originalChars: 56_214,
      limit: 10_000,
      filePath: "/sessions/abc/overflow/call_1.txt",
    });
    expect(out).toContain("56,214");
    expect(out).toContain("48,593");
    expect(out).toContain("10,000");
    expect(out).toContain("/sessions/abc/overflow/call_1.txt");
    expect(out).toMatch(/read tool|grep/i);
    expect(out).toContain("HEAD");
    expect(out).toContain("TAIL");
    expect(out).toContain("recall");
  });
});

describe("stashPath", () => {
  it("neutralizes path-traversal ids and caps length", () => {
    expect(stashPath("/s", "../../etc/passwd")).toBe("/s/overflow/______etc_passwd.txt");
    const longId = "x".repeat(500);
    expect(stashPath("/s", longId)).toBe(`/s/overflow/${"x".repeat(100)}.txt`);
  });
});

describe("registerOverflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overflow-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_OVERFLOW_MAX_CHARS;
  });

  it("caps an oversized custom-tool result and stashes the full text", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    const full = Array.from({ length: 3_000 }, (_, i) => `row-${i}`).join("\n");

    const result = fireResult(
      events,
      resultEvent("mcp__db__query", [{ type: "text", text: full }]),
      ctxWithDir(dir),
    ) as {
      content: Part[];
    };

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text as string;
    expect(text).toContain("row-0"); // head survives
    expect(text).toContain("row-2999"); // tail survives
    expect(text.length).toBeLessThan(full.length / 2);
    const stashed = readFileSync(join(dir, "overflow", "call_1.txt"), "utf8");
    expect(stashed).toBe(full);
  });

  it("leaves results under the limit untouched", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);

    expect(
      fireResult(events, resultEvent("mcp__db__query", [{ type: "text", text: "small" }]), ctxWithDir(dir)),
    ).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("never touches built-in tool results — pi truncates those itself", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    const full = "z".repeat(50_000);

    expect(fireResult(events, resultEvent("bash", [{ type: "text", text: full }]), ctxWithDir(dir))).toBeUndefined();
  });

  it("preserves image parts alongside the capped text", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

    const result = fireResult(
      events,
      resultEvent("mcp__playwright__snapshot", [{ type: "text", text: "s".repeat(20_000) }, image]),
      ctxWithDir(dir),
    ) as { content: Part[] };

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toBe(image);
    expect(readFileSync(join(dir, "overflow", "call_1.txt"), "utf8")).toBe("s".repeat(20_000));
  });

  it("joins multiple text parts before measuring and stashing", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);

    const result = fireResult(
      events,
      resultEvent("mcp__db__query", [
        { type: "text", text: "a".repeat(6_000) },
        { type: "text", text: "b".repeat(6_000) },
      ]),
      ctxWithDir(dir),
    ) as { content: Part[] };

    const stashed = readFileSync(join(dir, "overflow", "call_1.txt"), "utf8");
    expect(stashed).toBe(`${"a".repeat(6_000)}\n${"b".repeat(6_000)}`);
    expect(result.content[0].type).toBe("text");
  });

  it("skips capping when no session dir is available — never discard without a pointer", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);

    expect(
      fireResult(events, resultEvent("mcp__db__query", [{ type: "text", text: "q".repeat(20_000) }])),
    ).toBeUndefined();
    expect(
      fireResult(events, resultEvent("mcp__db__query", [{ type: "text", text: "q".repeat(20_000) }]), {}),
    ).toBeUndefined();
  });

  it("registers no handler when disabled via PI_OVERFLOW_MAX_CHARS=0", () => {
    process.env.PI_OVERFLOW_MAX_CHARS = "0";
    const { pi, events } = makePi();
    registerOverflow(pi);

    expect(events.get("tool_result")).toBeUndefined();
  });

  it("passes the result through untouched when the stash write fails", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    // A regular file at the overflow/ path makes mkdirSync fail — the exact
    // write-failure branch that must never produce a lying pointer.
    writeFileSync(join(dir, "overflow"), "not a directory");

    expect(
      fireResult(events, resultEvent("mcp__db__query", [{ type: "text", text: "e".repeat(20_000) }]), ctxWithDir(dir)),
    ).toBeUndefined();
  });

  it("passes the result through when the environment itself throws", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    const brokenCtx = {
      sessionManager: {
        getSessionDir: () => {
          throw new Error("boom");
        },
      },
    };
    const handler = events.get("tool_result")!;
    expect(
      handler(resultEvent("mcp__db__query", [{ type: "text", text: "e".repeat(20_000) }]), brokenCtx),
    ).toBeUndefined();
  });

  it("caps error results too, and the returned object carries only content", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);

    const result = fireResult(
      events,
      { ...resultEvent("mcp__db__query", [{ type: "text", text: "stack".repeat(5_000) }]), isError: true },
      ctxWithDir(dir),
    ) as Record<string, unknown>;

    // Field-merge contract: only content is replaced; isError/details/usage
    // pass through pi untouched, so the handler must not set them.
    expect(Object.keys(result)).toEqual(["content"]);
    expect(readFileSync(join(dir, "overflow", "call_1.txt"), "utf8")).toBe("stack".repeat(5_000));
  });

  it("passes malformed text parts through instead of dropping them", () => {
    const { pi, events } = makePi();
    registerOverflow(pi);
    const malformed = { type: "text", text: 42 };

    const result = fireResult(
      events,
      resultEvent("mcp__db__query", [{ type: "text", text: "m".repeat(20_000) }, malformed as unknown as Part]),
      ctxWithDir(dir),
    ) as { content: Part[] };

    expect(result.content).toContain(malformed);
  });
});
