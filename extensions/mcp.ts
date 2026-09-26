import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ServerDef {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

interface McpConfig {
  mcpServers?: Record<string, ServerDef>;
}

interface ToolMeta {
  server: string;
  name: string;
  qualified: string;
  description?: string;
  inputSchema?: unknown;
}

interface ServerState {
  def: ServerDef;
  client?: Client;
  tools?: ToolMeta[];
  connecting?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastError?: string;
}

const CONFIG_PATH = join(homedir(), ".pi/agent/mcp.json");
const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const IDLE_CLOSE_MS = 30_000;
const MAX_SEARCH_RESULTS = 20;

function loadConfig(): McpConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as McpConfig;
    }
  } catch {
    // fall through to empty config
  }
  return {};
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  const servers = new Map<string, ServerState>();
  const config = loadConfig();
  for (const [name, def] of Object.entries(config.mcpServers ?? {})) {
    if (!def.disabled) servers.set(name, { def });
  }

  function closeClient(state: ServerState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    const client = state.client;
    state.client = undefined;
    if (client) void client.close().catch(() => undefined);
  }

  /** Schedule connection teardown. unref() so it never keeps pi alive. */
  function scheduleIdleClose(state: ServerState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => closeClient(state), IDLE_CLOSE_MS);
    state.idleTimer.unref();
  }

  /** Ensure tools metadata is cached and a connection is open. */
  async function ensureConnected(name: string): Promise<ServerState> {
    const state = servers.get(name);
    if (!state) {
      throw new Error(`Server "${name}" is not configured. Configured servers: ${[...servers.keys()].join(", ") || "(none)"}`);
    }
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.client && state.tools) return state;
    if (state.connecting) {
      await state.connecting;
      return state;
    }
    state.connecting = (async () => {
      const client = new Client({ name: "pi-mcp", version: "0.1.0" });
      const def = state.def;
      const transport = def.url
        ? new StreamableHTTPClientTransport(new URL(def.url))
        : new StdioClientTransport({
            command: def.command!,
            args: def.args ?? [],
            env: def.env,
            cwd: def.cwd,
          });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connect to ${name}`);
      const listed = await withTimeout(client.listTools(), LIST_TIMEOUT_MS, `List tools from ${name}`);
      state.client = client;
      state.tools = listed.tools.map((t) => ({
        server: name,
        name: t.name,
        qualified: `${name}__${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      state.lastError = undefined;
    })().catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      closeClient(state);
      throw new Error(`Failed to connect to MCP server "${name}": ${state.lastError}`);
    });
    try {
      await state.connecting;
      return state;
    } finally {
      state.connecting = undefined;
    }
  }

  /** Metadata-only ensure: connect, cache tools, then allow idle close. */
  async function ensureMeta(name: string): Promise<ServerState> {
    const state = await ensureConnected(name);
    scheduleIdleClose(state);
    return state;
  }

  function allTools(): ToolMeta[] {
    const out: ToolMeta[] = [];
    for (const state of servers.values()) out.push(...(state.tools ?? []));
    return out;
  }

  async function ensureAllMeta(): Promise<void> {
    await Promise.all([...servers.keys()].map((name) => ensureMeta(name).catch(() => undefined)));
  }

  function resolveTool(tool: string): ToolMeta {
    const known = allTools();
    const qualified = tool.includes("__") && known.some((t) => t.qualified === tool);
    const candidates = qualified
      ? known.filter((t) => t.qualified === tool)
      : known.filter((t) => t.name === tool || t.qualified === tool);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new Error(`Tool "${tool}" not found. Known tools: ${known.map((t) => t.qualified).join(", ") || "none (servers not connected yet)"}`);
    }
    throw new Error(`Tool "${tool}" is ambiguous. Use the qualified name: ${candidates.map((t) => t.qualified).join(", ")}`);
  }

  function serializeCallResult(result: { content?: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }): string {
    const parts: string[] = [];
    for (const block of result.content ?? []) {
      if (block.type === "text") parts.push(block.text ?? "");
      else if (block.type === "image") parts.push(`[image: ${block.mimeType ?? "unknown"}]`);
      else parts.push(JSON.stringify(block));
    }
    let text = parts.join("\n").trim() || "(no content)";
    if (result.isError) text = `MCP tool reported an error: ${text}`;
    return text;
  }

  const serverNames = [...servers.keys()];
  pi.on("session_shutdown", () => {
    for (const state of servers.values()) closeClient(state);
  });
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: `MCP gateway — status, tool search/describe, and tool calls over MCP servers. Servers: ${serverNames.join(", ") || "(none configured)"}.
Usage:
  mcp({})                            → server status
  mcp({ search: "query" })           → search tools by name/description
  mcp({ describe: "server__tool" })  → show a tool's parameters
  mcp({ tool: "server__tool", args: { ... } }) → call a tool
  mcp({ server: "name" })            → list a server's tools
Tool names are "server__tool"; a bare name works when unambiguous. Servers connect lazily on first use.`,
    promptSnippet: "MCP gateway — search and call tools on external MCP servers",
    promptGuidelines: [
      'Discover MCP tools with mcp({ search: ... }) before calling them; call with mcp({ tool: "server__tool", args: { ... } }).',
    ],
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Search tools by name/description across servers" })),
      describe: Type.Optional(Type.String({ description: "Tool name to show details for (server__tool)" })),
      tool: Type.Optional(Type.String({ description: "Tool to call (server__tool, or bare name if unambiguous)" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool call arguments" })),
      server: Type.Optional(Type.String({ description: "Server name to list tools for" })),
    }),
    async execute(_id, params, signal) {
      const mode = params.tool !== undefined
        ? "call"
        : params.search !== undefined
          ? "search"
          : params.describe !== undefined
            ? "describe"
            : params.server !== undefined
              ? "list"
              : "status";

      if (signal?.aborted) throw new Error("Aborted");

      if (mode === "status") {
        const lines: string[] = [];
        for (const [name, state] of servers) {
          const kind = state.def.url ? `http ${state.def.url}` : `stdio ${state.def.command} ${state.def.args?.join(" ") ?? ""}`;
          const status = state.tools
            ? `known: ${state.tools.length} tools (${state.client ? "connected" : "idle"})`
            : state.lastError
              ? `not connected (${state.lastError})`
              : "not connected yet";
          lines.push(`- ${name} (${kind}): ${status}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") || "No MCP servers configured." }], details: {} };
      }

      if (mode === "list") {
        const state = await ensureMeta(params.server!);
        const tools = (state.tools ?? []).map((t) => `- ${t.qualified}${t.description ? ` — ${t.description}` : ""}`);
        return { content: [{ type: "text", text: `Tools on ${params.server}:\n${tools.join("\n") || "(none)"}` }], details: {} };
      }

      if (mode === "search") {
        await ensureAllMeta();
        const query = params.search!.toLowerCase();
        const q = (s: string) => s.toLowerCase().includes(query);
        const hits = allTools().filter((t) => q(t.name) || q(t.qualified) || q(t.description ?? "")).slice(0, MAX_SEARCH_RESULTS);
        if (hits.length === 0) {
          return { content: [{ type: "text", text: `No tools matching "${params.search}".` }], details: {} };
        }
        const lines = hits.map((t) => {
          const schema = t.inputSchema ? JSON.stringify((t.inputSchema as { properties?: unknown }).properties ?? t.inputSchema) : "{}";
          return `- ${t.qualified}${t.description ? ` — ${t.description}` : ""}\n  params: ${schema}`;
        });
        return { content: [{ type: "text", text: `${hits.length} tool(s):\n${lines.join("\n")}` }], details: {} };
      }

      if (mode === "describe") {
        await ensureAllMeta();
        const tool = resolveTool(params.describe!);
        const text = `${tool.qualified}${tool.description ? `\n\n${tool.description}` : ""}\n\nParameters: ${JSON.stringify(tool.inputSchema ?? {}, null, 1)}`;
        return { content: [{ type: "text", text }], details: {} };
      }

      // mode === "call"
      const tool = resolveTool(params.tool!);
      const state = await ensureConnected(tool.server);
      try {
        const result = await withTimeout(
          state.client!.callTool({ name: tool.name, arguments: params.args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS }),
          CALL_TIMEOUT_MS + 5_000,
          `Call ${tool.qualified}`,
        );
        return { content: [{ type: "text", text: serializeCallResult(result as never) }], details: {} };
      } finally {
        scheduleIdleClose(state);
      }
    },
  });
}
