import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const instances: Array<{ closed: number; info: unknown }> = [];
  const behavior: {
    connect: () => Promise<void>;
    listTools: (p?: unknown) => Promise<{ tools: unknown[]; nextCursor?: string }>;
    callTool: (...args: unknown[]) => Promise<unknown>;
  } = {
    connect: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
  return { instances, behavior };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    closed = 0;
    constructor(public info: unknown) {
      sdk.instances.push(this);
    }
    connect(_t: unknown) {
      return sdk.behavior.connect();
    }
    listTools(p?: unknown) {
      return sdk.behavior.listTools(p);
    }
    callTool(...args: unknown[]) {
      return sdk.behavior.callTool(...args);
    }
    async close() {
      this.closed++;
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(public opts: unknown) {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: unknown) {}
  },
}));

import {
  formatParamNames,
  formatSearchHits,
  loadConfig,
  modeOf,
  registerMcpTool,
  renderMcpCall,
  resolveToolByName,
  serializeCallResult,
  validateServerDef,
  type ToolMeta,
} from "../extensions/mcp";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function makePi() {
  const tools = new Map<
    string,
    {
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    }
  >();
  const handlers = new Map<string, () => void>();
  const pi = {
    registerTool: (tool: { name: string; execute: unknown }) => tools.set(tool.name, tool as never),
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
}

function writeConfig(dir: string, servers: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: servers, ...extra }));
  return path;
}

const TWO_TOOLS = [
  {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: {} }, required: ["query"] },
  },
  { name: "web_fetch", description: "Fetch a URL", inputSchema: { type: "object", properties: { url: {}, raw: {} } } },
];

/** Identity theme: strips styling so assertions see plain text. */
const THEME = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

describe("modeOf", () => {
  it("prefers modes in render/execute agreement order, treating empty strings as absent", () => {
    expect(modeOf({ tool: "x", search: "y" })).toBe("call");
    expect(modeOf({ search: "y", describe: "z" })).toBe("search");
    expect(modeOf({ describe: "z", server: "s" })).toBe("describe");
    expect(modeOf({ server: "s" })).toBe("list");
    expect(modeOf({})).toBe("status");
    expect(modeOf({ tool: "", search: "", describe: "", server: "" })).toBe("status");
  });
});

describe("renderMcpCall", () => {
  it("shows each call mode with its target", () => {
    expect(renderMcpCall({ tool: "web__search" }, THEME)).toContain("call web__search");
    expect(renderMcpCall({ search: "browser" }, THEME)).toContain('search "browser"');
    expect(renderMcpCall({ describe: "web__search" }, THEME)).toContain("describe web__search");
    expect(renderMcpCall({ server: "web" }, THEME)).toContain("list web");
    expect(renderMcpCall({}, THEME)).toContain("status");
  });

  it("truncates long search queries", () => {
    const text = renderMcpCall({ search: "q".repeat(100) }, THEME);
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(80);
  });

  it("tolerates partially streamed arguments", () => {
    expect(renderMcpCall({ search: "" }, THEME)).toContain("status");
    expect(renderMcpCall({}, THEME)).toContain("mcp ");
  });
});

describe("loadConfig", () => {
  it("returns empty for a missing file", () => {
    expect(loadConfig("/nonexistent/mcp.json")).toEqual({ config: {} });
  });

  it("parses valid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = writeConfig(dir, { s1: { url: "https://x/mcp" } });
    const { config, error } = loadConfig(path);
    expect(error).toBeUndefined();
    expect(config.mcpServers?.s1?.url).toBe("https://x/mcp");
  });

  it("surfaces parse errors instead of swallowing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = join(dir, "mcp.json");
    writeFileSync(path, "{not json");
    const { config, error } = loadConfig(path);
    expect(config).toEqual({});
    expect(error).toBeTruthy();
  });
});

describe("validateServerDef", () => {
  it("accepts url-only and command-only defs", () => {
    expect(validateServerDef({ url: "https://x" })).toBeUndefined();
    expect(validateServerDef({ command: "npx", args: ["x"] })).toBeUndefined();
  });

  it("rejects both or neither, and non-array args", () => {
    expect(validateServerDef({ url: "u", command: "c" })).toMatch(/mutually exclusive/);
    expect(validateServerDef({})).toMatch(/needs 'url' or 'command'/);
    expect(validateServerDef({ command: "c", args: "oops" as never })).toMatch(/args/);
  });
});

describe("resolveToolByName", () => {
  const known: ToolMeta[] = [
    { server: "a", name: "run", qualified: "a__run" },
    { server: "b", name: "run", qualified: "b__run" },
    { server: "a", name: "unique", qualified: "a__unique" },
  ];

  it("resolves qualified and bare-unique names", () => {
    expect(resolveToolByName(known, "a__run").qualified).toBe("a__run");
    expect(resolveToolByName(known, "unique").qualified).toBe("a__unique");
  });

  it("rejects ambiguous bare names with candidates", () => {
    expect(() => resolveToolByName(known, "run")).toThrow(/ambiguous.*a__run, b__run/);
  });

  it("rejects unknown names with the known list", () => {
    expect(() => resolveToolByName(known, "nope")).toThrow(/not found.*a__run/);
    expect(() => resolveToolByName([], "nope")).toThrow(/none \(servers not connected yet\)/);
  });
});

describe("serializeCallResult", () => {
  it("joins text blocks", () => {
    expect(
      serializeCallResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("reduces binary blocks to mime summaries", () => {
    expect(serializeCallResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toBe(
      "[image: image/png]",
    );
    expect(serializeCallResult({ content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] })).toBe(
      "[audio: audio/wav]",
    );
  });

  it("keeps resource text but hides resource blobs", () => {
    expect(serializeCallResult({ content: [{ type: "resource", resource: { uri: "x", text: "body" } }] })).toBe("body");
    expect(serializeCallResult({ content: [{ type: "resource", resource: { uri: "x", blob: "AAAA" } }] })).toBe(
      "[resource: x (binary)]",
    );
  });

  it("marks errors and handles legacy toolResult", () => {
    expect(serializeCallResult({ content: [{ type: "text", text: "bad" }], isError: true })).toBe(
      "MCP tool reported an error: bad",
    );
    expect(serializeCallResult({ toolResult: { ok: false } })).toBe('{"ok":false}');
    expect(serializeCallResult({})).toBe("(no content)");
    expect(serializeCallResult(null)).toBe("(no content)");
  });
});

describe("formatting", () => {
  it("marks optional params", () => {
    expect(formatParamNames({ properties: { query: {}, raw: {} }, required: ["query"] })).toBe("query, raw?");
    expect(formatParamNames(undefined)).toBe("(no params)");
    expect(formatParamNames({})).toBe("(no params)");
  });

  it("reports truncation in search results", () => {
    const hits: ToolMeta[] = [{ server: "a", name: "t", qualified: "a__t" }];
    expect(formatSearchHits(hits, 1)).toContain("1 matching tool(s)");
    expect(formatSearchHits(hits, 50)).toContain("showing 1 of 50");
    expect(formatSearchHits(hits, 1)).toContain("params: (no params)");
  });
});

describe("registerMcpTool integration", () => {
  beforeEach(() => {
    sdk.instances.length = 0;
    sdk.behavior.connect = async () => undefined;
    sdk.behavior.listTools = async () => ({ tools: TWO_TOOLS });
    sdk.behavior.callTool = async () => ({ content: [{ type: "text", text: "ok" }] });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(servers: Record<string, unknown> = { s1: { url: "https://x/mcp" } }) {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = writeConfig(dir, servers);
    const { pi, tools, handlers } = makePi();
    registerMcpTool(pi, path);
    return { tool: tools.get("mcp")!, handlers };
  }

  it("tool call rows render the call mode", () => {
    const { tool } = setup();
    const renderCall = (
      tool as unknown as {
        renderCall: (args: unknown, theme: unknown, context?: unknown) => { render: (width: number) => string[] };
      }
    ).renderCall;
    const text = renderCall({ search: "browser" }, THEME, {}).render(200).join("\n");
    expect(text).toContain('search "browser"');
  });

  it("treats empty-string arguments as status, matching the renderer", async () => {
    const { tool } = setup();
    const result = await tool.execute("1", { search: "" });
    expect(result.content[0].text).toContain("not connected yet");
  });

  it("reports a named server's connect failure instead of a missing tool", async () => {
    sdk.behavior.connect = async () => {
      throw new Error("boom");
    };
    const { tool } = setup();
    // Qualified name: the named server's failure must surface, not "not found".
    await expect(tool.execute("1", { tool: "s1__web_search" })).rejects.toThrow(/Failed to connect to MCP server "s1"/);
    await expect(tool.execute("1", { describe: "s1__web_search" })).rejects.toThrow(/Failed to connect/);
  });

  it("lists status without connecting", async () => {
    const { tool } = setup();
    const result = await tool.execute("1", {});
    expect(result.content[0].text).toContain("s1 (http https://x/mcp): not connected yet");
    expect(sdk.instances).toHaveLength(0);
  });

  it("search connects lazily and formats hits", async () => {
    const { tool } = setup();
    const result = await tool.execute("1", { search: "web" });
    expect(result.content[0].text).toContain("s1__web_search");
    expect(result.content[0].text).toContain("params: query");
    expect(result.content[0].text).toContain("params: url?, raw?");
  });

  it("C1: closes the client when listTools fails (no orphaned process)", async () => {
    sdk.behavior.listTools = async () => {
      throw new Error("list boom");
    };
    const { tool } = setup();
    const result = await tool.execute("1", { search: "web" });
    expect(result.content[0].text).toContain("Unreachable servers: s1");
    expect(sdk.instances[0].closed).toBe(1);
  });

  it("I5: a bare tool call connects before resolving", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    sdk.behavior.callTool = callTool;
    const { tool } = setup();
    const result = await tool.execute("1", { tool: "web_fetch", args: { url: "https://x" } });
    expect(result.content[0].text).toBe("ok");
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("C2: idle close never fires while a call is in flight", async () => {
    let releaseCall: (v: unknown) => void = () => undefined;
    sdk.behavior.callTool = () => new Promise((resolve) => (releaseCall = resolve));
    const { tool } = setup();
    const callPromise = tool.execute("1", { tool: "s1__web_search", args: { query: "q" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sdk.instances[0].closed).toBe(0);
    releaseCall({ content: [{ type: "text", text: "done" }] });
    await callPromise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sdk.instances[0].closed).toBe(1);
  });

  it("C3: session_shutdown closes a client that finishes connecting afterwards", async () => {
    let releaseConnect: () => void = () => undefined;
    sdk.behavior.connect = () => new Promise<void>((resolve) => (releaseConnect = resolve));
    const { tool, handlers } = setup();
    const callPromise = tool.execute("1", { server: "s1" });
    handlers.get("session_shutdown")!();
    releaseConnect();
    await expect(callPromise).rejects.toThrow(/shutting down/);
    expect(sdk.instances[0].closed).toBe(1);
  });

  it("reports invalid config in status and refuses to connect", async () => {
    const { tool } = setup({ bad: {} });
    const result = await tool.execute("1", {});
    expect(result.content[0].text).toContain("invalid config");
    await expect(tool.execute("1", { server: "bad" })).rejects.toThrow(/invalid config/);
    expect(sdk.instances).toHaveLength(0);
  });

  it("surfaces config parse errors in status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = join(dir, "mcp.json");
    writeFileSync(path, "{broken");
    const { pi, tools } = makePi();
    registerMcpTool(pi, path);
    const result = await tools.get("mcp")!.execute("1", {});
    expect(result.content[0].text).toContain("config error");
  });

  it("paginates tool listing", async () => {
    const calls: unknown[] = [];
    sdk.behavior.listTools = async (p?: unknown) => {
      calls.push(p);
      return calls.length === 1 ? { tools: [TWO_TOOLS[0]], nextCursor: "c1" } : { tools: [TWO_TOOLS[1]] };
    };
    const { tool } = setup();
    const result = await tool.execute("1", { server: "s1" });
    expect(result.content[0].text).toContain("s1__web_search");
    expect(result.content[0].text).toContain("s1__web_fetch");
    expect(calls).toEqual([undefined, { cursor: "c1" }]);
  });
});

describe("pins", () => {
  beforeEach(() => {
    sdk.instances.length = 0;
    sdk.behavior.connect = async () => undefined;
    sdk.behavior.listTools = async () => ({ tools: TWO_TOOLS });
    sdk.behavior.callTool = async () => ({ content: [{ type: "text", text: "ok" }] });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupPins(pin: string[], servers: Record<string, unknown> = { s1: { url: "https://x/mcp" } }) {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pin-"));
    const path = writeConfig(dir, servers, { pin });
    const { pi, tools, handlers } = makePi();
    await registerMcpTool(pi, path);
    return { tools, handlers };
  }

  it("registers pinned tools natively with the server's schema and description", async () => {
    const { tools } = await setupPins(["s1__web_search"]);
    const pinned = tools.get("s1__web_search") as unknown as {
      description: string;
      promptSnippet: string;
      parameters: unknown;
    };
    expect(pinned).toBeDefined();
    expect(pinned.description).toContain("Search the web");
    expect(pinned.description).toContain('MCP server "s1"');
    expect(pinned.promptSnippet).toContain("Search the web");
    expect(pinned.parameters).toEqual(TWO_TOOLS[0].inputSchema);
    expect(tools.get("mcp")).toBeDefined(); // gateway still present for the tail
  });

  it("routes pinned calls through the shared connection and closes on idle", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    sdk.behavior.callTool = callTool;
    const { tools } = await setupPins(["s1__web_search"]);
    const result = await tools.get("s1__web_search")!.execute("1", { query: "q" });
    expect(result.content[0].text).toBe("ok");
    expect(callTool).toHaveBeenCalledWith(
      { name: "web_search", arguments: { query: "q" } },
      undefined,
      expect.objectContaining({ timeout: 120_000 }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sdk.instances[0].closed).toBe(1);
  });

  it("degrades an unreachable pinned server to a status line, never a load failure", async () => {
    sdk.behavior.connect = async () => {
      throw new Error("boom");
    };
    const { tools } = await setupPins(["s1__web_search"]);
    expect(tools.get("s1__web_search")).toBeUndefined();
    const status = await tools.get("mcp")!.execute("1", {});
    expect(status.content[0].text).toMatch(/- pin s1__web_search: .*boom/);
  });

  it("names unknown tools, bare names, and non-object schemas as pin issues", async () => {
    sdk.behavior.listTools = async () => ({
      tools: [...TWO_TOOLS, { name: "weird", inputSchema: { type: "string" } }],
    });
    const { tools } = await setupPins(["s1__nope", "s1__weird", "bare_name", "sX__thing"]);
    for (const name of ["s1__nope", "s1__weird", "bare_name", "sX__thing"]) {
      expect(tools.get(name)).toBeUndefined();
    }
    const status = await tools.get("mcp")!.execute("1", {});
    const text = status.content[0].text;
    expect(text).toMatch(/s1__nope: not offered/);
    expect(text).toMatch(/s1__weird: input schema is not an object/);
    expect(text).toMatch(/bare_name: unknown server/);
    expect(text).toMatch(/sX__thing: unknown server/);
  });

  it("lists successful pins in status", async () => {
    const { tools } = await setupPins(["s1__web_search"]);
    const status = await tools.get("mcp")!.execute("1", {});
    expect(status.content[0].text).toContain("- pinned s1__web_search: native tool");
  });

  it("annotates the gateway description with server notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-note-"));
    const path = writeConfig(dir, { s1: { url: "https://x/mcp", note: "web search and fetch" } });
    const { pi, tools } = makePi();
    await registerMcpTool(pi, path);
    expect((tools.get("mcp") as unknown as { description: string }).description).toContain("s1 (web search and fetch)");
  });

  it("survives malformed pin config with a status line, never a load failure", async () => {
    for (const bad of [{}, "s1__web_search"]) {
      const dir = mkdtempSync(join(tmpdir(), "mcp-bad-"));
      const path = writeConfig(dir, { s1: { url: "https://x/mcp" } }, { pin: bad });
      const { pi, tools } = makePi();
      await expect(registerMcpTool(pi, path)).resolves.toBeUndefined();
      expect(tools.get("mcp")).toBeDefined();
    }
    const dir = mkdtempSync(join(tmpdir(), "mcp-bad-"));
    const path = writeConfig(dir, { s1: { url: "https://x/mcp" } }, { pin: [42, "s1__web_search"] });
    const { pi, tools } = makePi();
    await registerMcpTool(pi, path);
    expect(tools.get("s1__web_search")).toBeDefined(); // the valid entry still lands
    const status = await tools.get("mcp")!.execute("1", {});
    expect(status.content[0].text).toContain("42: pin entries must be strings");
  });

  it("rejects pin names providers refuse and $ref schemas Anthropic would drop", async () => {
    sdk.behavior.listTools = async () => ({
      tools: [
        ...TWO_TOOLS,
        {
          name: "refl",
          inputSchema: { type: "object", $defs: { q: {} }, properties: { x: { $ref: "#/$defs/q" } } },
        },
      ],
    });
    const { tools } = await setupPins(["my.server__x", "s1__refl"]);
    expect(tools.get("my.server__x")).toBeUndefined();
    const status = await tools.get("mcp")!.execute("1", {});
    const text = status.content[0].text;
    expect(text).toContain("my.server__x: tool name must be 1-64 chars");
    expect(text).toContain("s1__refl: schema uses $ref");
  });

  it("reports a disabled server by name instead of 'unknown server'", async () => {
    const { tools } = await setupPins(["s1__web_search"], { s1: { url: "https://x/mcp", disabled: true } });
    expect(tools.get("s1__web_search")).toBeUndefined();
    const status = await tools.get("mcp")!.execute("1", {});
    expect(status.content[0].text).toContain("s1__web_search: server is disabled");
  });

  it("shares one connection across pins on a server and dedupes repeated pins", async () => {
    const { tools } = await setupPins(["s1__web_search", "s1__web_fetch", "s1__web_search"]);
    expect(sdk.instances).toHaveLength(1);
    const status = await tools.get("mcp")!.execute("1", {});
    const pinnedLines = (status.content[0].text ?? "").split("\n").filter((l: string) => l.includes("- pinned"));
    expect(pinnedLines).toHaveLength(2);
  });

  it("reconnects a pinned tool after the idle close", async () => {
    const { tools } = await setupPins(["s1__web_search"]);
    await tools.get("s1__web_search")!.execute("1", { query: "a" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sdk.instances[0].closed).toBe(1);
    const result = await tools.get("s1__web_search")!.execute("2", { query: "b" });
    expect(result.content[0].text).toBe("ok");
    expect(sdk.instances).toHaveLength(2);
  });
});
