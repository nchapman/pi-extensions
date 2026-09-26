import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ServerDef {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers?: Record<string, ServerDef>;
}

export interface ToolMeta {
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
  activeCalls: number;
  shuttingDown: boolean;
  invalid?: string;
  lastError?: string;
}

const CONFIG_PATH = join(homedir(), ".pi/agent/mcp.json");
const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const IDLE_CLOSE_MS = 30_000;
const MAX_SEARCH_RESULTS = 20;

export function loadConfig(path: string): { config: McpConfig; error?: string } {
  if (!existsSync(path)) return { config: {} };
  try {
    return { config: JSON.parse(readFileSync(path, "utf8")) as McpConfig };
  } catch (error) {
    return { config: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateServerDef(def: ServerDef): string | undefined {
  if (def.url && def.command) return "'url' and 'command' are mutually exclusive";
  if (!def.url && !def.command) return "needs 'url' or 'command'";
  if (def.args !== undefined && !Array.isArray(def.args)) return "'args' must be an array of strings";
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    timer.unref?.();
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

export function resolveToolByName(known: ToolMeta[], tool: string): ToolMeta {
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

interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string };
}

export function serializeCallResult(result: unknown): string {
  const r = result as { content?: ContentBlock[]; isError?: boolean; toolResult?: unknown } | null | undefined;
  const parts: string[] = [];
  for (const block of r?.content ?? []) {
    if (block.type === "text") parts.push(block.text ?? "");
    else if (block.type === "image" || block.type === "audio") parts.push(`[${block.type}: ${block.mimeType ?? "unknown"}]`);
    else if (block.type === "resource") {
      const res = block.resource ?? {};
      parts.push(res.text != null ? res.text : `[resource: ${res.uri ?? "unknown"}${res.blob ? " (binary)" : ""}]`);
    } else parts.push(JSON.stringify(block));
  }
  let text = parts.join("\n").trim();
  if (!text && r?.toolResult !== undefined) text = JSON.stringify(r.toolResult);
  if (!text) text = "(no content)";
  if (r?.isError) text = `MCP tool reported an error: ${text}`;
  return text;
}

export function formatParamNames(inputSchema: unknown): string {
  const s = inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const props = s?.properties;
  if (!props || typeof props !== "object") return "(no params)";
  const required = new Set(s?.required ?? []);
  const names = Object.keys(props).map((k) => (required.has(k) ? k : `${k}?`));
  return names.join(", ") || "(no params)";
}

export function formatSearchHits(hits: ToolMeta[], total: number): string {
  const lines = hits.map((t) => {
    const desc = t.description ? ` — ${t.description}` : "";
    return `- ${t.qualified}${desc}\n  params: ${formatParamNames(t.inputSchema)}`;
  });
  const head = total > hits.length ? `showing ${hits.length} of ${total} matching tool(s)` : `${total} matching tool(s)`;
  return `${head}:\n${lines.join("\n")}`;
}

export function registerMcpTool(pi: ExtensionAPI, configPath: string = CONFIG_PATH): void {
  const { config, error: configError } = loadConfig(configPath);
  const servers = new Map<string, ServerState>();
  for (const [name, def] of Object.entries(config.mcpServers ?? {})) {
    if (def.disabled) continue;
    const state: ServerState = { def, activeCalls: 0, shuttingDown: false };
    state.invalid = validateServerDef(def);
    servers.set(name, state);
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

  /** Schedule teardown when idle. unref() so the timer never keeps pi alive. */
  function scheduleIdleClose(state: ServerState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeCalls > 0) return;
    state.idleTimer = setTimeout(() => {
      if (state.activeCalls > 0) return;
      closeClient(state);
    }, IDLE_CLOSE_MS);
    state.idleTimer.unref();
  }

  async function listAllTools(client: Client, serverName: string): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined),
        LIST_TIMEOUT_MS,
        `List tools from ${serverName}`,
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async function ensureConnected(name: string): Promise<ServerState> {
    const state = servers.get(name);
    if (!state) {
      throw new Error(`Server "${name}" is not configured. Configured servers: ${[...servers.keys()].join(", ") || "(none)"}`);
    }
    if (state.shuttingDown) throw new Error("MCP is shutting down");
    if (state.invalid) throw new Error(`Server "${name}" has invalid config: ${state.invalid}`);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
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
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connect to ${name}`);
        const tools = await listAllTools(client, name);
        if (state.shuttingDown) throw new Error("MCP is shutting down");
        state.client = client;
        state.tools = tools.map((t) => ({
          server: name,
          name: t.name,
          qualified: `${name}__${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        state.lastError = undefined;
      } catch (error) {
        void client.close().catch(() => undefined);
        state.lastError = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to connect to MCP server "${name}": ${state.lastError}`);
      }
    })();
    try {
      await state.connecting;
      return state;
    } finally {
      state.connecting = undefined;
    }
  }

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

  /** Returns names of servers that could not be reached. */
  async function ensureAllMeta(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all([...servers.keys()].map((name) => ensureMeta(name).catch(() => failed.push(name))));
    return failed;
  }

  function unreachableNote(failed: string[]): string {
    if (failed.length === 0) return "";
    const detail = failed.map((n) => `${n} (${servers.get(n)?.lastError ?? "connect failed"})`).join("; ");
    return `\n\nUnreachable servers: ${detail}`;
  }

  pi.on("session_shutdown", () => {
    for (const state of servers.values()) {
      state.shuttingDown = true;
      closeClient(state);
    }
  });

  const serverNames = [...servers.keys()];
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
        if (configError) lines.push(`config error (${configPath}): ${configError}`);
        for (const [name, state] of servers) {
          const kind = state.def.url ? `http ${state.def.url}` : `stdio ${state.def.command} ${state.def.args?.join(" ") ?? ""}`;
          const status = state.invalid
            ? `invalid config (${state.invalid})`
            : state.tools
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
        const failed = await ensureAllMeta();
        const query = params.search!.toLowerCase();
        const q = (s: string) => s.toLowerCase().includes(query);
        const matching = allTools().filter((t) => q(t.name) || q(t.qualified) || q(t.description ?? ""));
        const hits = matching.slice(0, MAX_SEARCH_RESULTS);
        const body = matching.length === 0
          ? `No tools matching "${params.search}".`
          : formatSearchHits(hits, matching.length);
        return { content: [{ type: "text", text: body + unreachableNote(failed) }], details: {} };
      }

      if (mode === "describe") {
        const failed = await ensureAllMeta();
        const tool = resolveToolByName(allTools(), params.describe!);
        const text = `${tool.qualified}${tool.description ? `\n\n${tool.description}` : ""}\n\nParameters: ${JSON.stringify(tool.inputSchema ?? {}, null, 1)}`;
        return { content: [{ type: "text", text: text + unreachableNote(failed) }], details: {} };
      }

      // mode === "call": connect lazily before resolving so a bare
      // mcp({ tool }) works on first use.
      const requested = params.tool!;
      const sep = requested.indexOf("__");
      const maybeServer = sep > 0 ? requested.slice(0, sep) : undefined;
      if (maybeServer && servers.has(maybeServer)) await ensureMeta(maybeServer);
      else await ensureAllMeta();
      const tool = resolveToolByName(allTools(), requested);
      const state = await ensureConnected(tool.server);
      state.activeCalls++;
      try {
        const result = await withTimeout(
          state.client!.callTool({ name: tool.name, arguments: params.args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS, signal }),
          CALL_TIMEOUT_MS + 5_000,
          `Call ${tool.qualified}`,
        );
        return { content: [{ type: "text", text: serializeCallResult(result) }], details: {} };
      } finally {
        state.activeCalls--;
        scheduleIdleClose(state);
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerMcpTool(pi);
}
