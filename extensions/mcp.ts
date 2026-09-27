import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export interface ServerDef {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /** One-line capability hint shown in the gateway tool's description. */
  note?: string;
}

export interface McpConfig {
  mcpServers?: Record<string, ServerDef>;
  /** Qualified tool names (server__tool) registered as native tools at load.
   * The pin string is the tool name the model sees. */
  pin?: string[];
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
    throw new Error(
      `Tool "${tool}" not found. Known tools: ${known.map((t) => t.qualified).join(", ") || "none (servers not connected yet)"}`,
    );
  }
  throw new Error(
    `Tool "${tool}" is ambiguous. Use the qualified name: ${candidates.map((t) => t.qualified).join(", ")}`,
  );
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
    else if (block.type === "image" || block.type === "audio")
      parts.push(`[${block.type}: ${block.mimeType ?? "unknown"}]`);
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
  const head =
    total > hits.length ? `showing ${hits.length} of ${total} matching tool(s)` : `${total} matching tool(s)`;
  return `${head}:\n${lines.join("\n")}`;
}

/** Shared mode precedence: empty strings read as "not provided" so rendering
 * and behavior agree. */
export function modeOf(args: {
  tool?: unknown;
  search?: unknown;
  describe?: unknown;
  server?: unknown;
}): "call" | "search" | "describe" | "list" | "status" {
  const has = (v: unknown) => typeof v === "string" && v !== "";
  return has(args.tool)
    ? "call"
    : has(args.search)
      ? "search"
      : has(args.describe)
        ? "describe"
        : has(args.server)
          ? "list"
          : "status";
}

/** One-line display for an `mcp` tool call: the selected mode and target. */
export function renderMcpCall(
  args: { tool?: unknown; search?: unknown; describe?: unknown; server?: unknown },
  theme: Pick<Theme, "fg" | "bold">,
): string {
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
  const str = (v: unknown) => (typeof v === "string" && v ? v : "");
  const mode = modeOf(args);
  const target =
    mode === "call"
      ? `call ${args.tool}`
      : mode === "search"
        ? `search "${clip(str(args.search))}"`
        : mode === "describe"
          ? `describe ${args.describe}`
          : mode === "list"
            ? `list ${args.server}`
            : "status";
  return theme.fg("toolTitle", theme.bold("mcp ")) + theme.fg("accent", target);
}

function reply(text: string): { content: Array<{ type: "text"; text: string }>; details: {} } {
  return { content: [{ type: "text", text }], details: {} };
}

/** Reuse the prior render component when available (pi renderer idiom). */
function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

export async function registerMcpTool(pi: ExtensionAPI, configPath: string = CONFIG_PATH): Promise<void> {
  const { config, error: configError } = loadConfig(configPath);
  const servers = new Map<string, ServerState>();
  const pinnedTools: string[] = [];
  const pinIssues: string[] = [];
  for (const [name, def] of Object.entries(config.mcpServers ?? {})) {
    if (def.disabled) continue;
    const state: ServerState = { def, activeCalls: 0, shuttingDown: false };
    state.invalid = validateServerDef(def);
    servers.set(name, state);
  }

  function clearIdleTimer(state: ServerState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  function closeClient(state: ServerState): void {
    clearIdleTimer(state);
    const client = state.client;
    state.client = undefined;
    if (client) void client.close().catch(() => undefined);
  }

  /** Schedule teardown when idle. unref() so the timer never keeps pi alive. */
  function scheduleIdleClose(state: ServerState): void {
    clearIdleTimer(state);
    if (state.activeCalls > 0) return;
    state.idleTimer = setTimeout(() => {
      if (state.activeCalls > 0) return;
      closeClient(state);
    }, IDLE_CLOSE_MS);
    state.idleTimer.unref();
  }

  async function listAllTools(
    client: Client,
    serverName: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
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
      throw new Error(
        `Server "${name}" is not configured. Configured servers: ${[...servers.keys()].join(", ") || "(none)"}`,
      );
    }
    if (state.shuttingDown) throw new Error("MCP is shutting down");
    if (state.invalid) throw new Error(`Server "${name}" has invalid config: ${state.invalid}`);
    clearIdleTimer(state);
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

  /** Connect the server named by a qualified tool, or all servers when the
   * name is bare — just enough metadata to resolve the name either way.
   * A named server's connect failure propagates; bare names swallow per-server
   * errors (returned as the failed list) so a down server doesn't hide others. */
  async function connectForResolve(name: string): Promise<string[]> {
    const sep = name.indexOf("__");
    const maybe = sep > 0 ? name.slice(0, sep) : undefined;
    if (maybe && servers.has(maybe)) {
      await ensureMeta(maybe);
      return [];
    }
    return ensureAllMeta();
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

  const serverList =
    [...servers.entries()].map(([n, s]) => (s.def.note ? `${n} (${s.def.note})` : n)).join(", ") || "(none configured)";
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: `MCP gateway — status, tool search/describe, and tool calls over MCP servers. Servers: ${serverList}.
Usage:
  mcp({})                            → server status
  mcp({ search: "query" })           → search tools by name/description
  mcp({ describe: "server__tool" })  → show a tool's parameters
  mcp({ tool: "server__tool", args: { ... } }) → call a tool
  mcp({ server: "name" })            → list a server's tools
Tool names are "server__tool"; a bare name works when unambiguous. Unpinned servers connect lazily on first use.`,
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
    renderCall(args, theme, context) {
      // Arguments stream in partially; the helpers tolerate missing keys.
      const text = reuseText(context);
      text.setText(renderMcpCall(args ?? {}, theme));
      return text;
    },
    async execute(_id, params, signal) {
      const mode = modeOf(params);

      if (signal?.aborted) throw new Error("Aborted");

      if (mode === "status") {
        const lines: string[] = [];
        if (configError) lines.push(`config error (${configPath}): ${configError}`);
        for (const [name, state] of servers) {
          const kind = state.def.url
            ? `http ${state.def.url}`
            : `stdio ${state.def.command} ${state.def.args?.join(" ") ?? ""}`;
          const status = state.invalid
            ? `invalid config (${state.invalid})`
            : state.tools
              ? `known: ${state.tools.length} tools (${state.client ? "connected" : "idle"})`
              : state.lastError
                ? `not connected (${state.lastError})`
                : "not connected yet";
          lines.push(`- ${name} (${kind}): ${status}`);
        }
        for (const pin of pinnedTools) lines.push(`- pinned ${pin}: native tool`);
        for (const issue of pinIssues) lines.push(`- pin ${issue}`);
        return reply(lines.join("\n") || "No MCP servers configured.");
      }

      if (mode === "list") {
        const state = await ensureMeta(params.server!);
        const tools = (state.tools ?? []).map((t) => `- ${t.qualified}${t.description ? ` — ${t.description}` : ""}`);
        return reply(`Tools on ${params.server}:\n${tools.join("\n") || "(none)"}`);
      }

      if (mode === "search") {
        const failed = await ensureAllMeta();
        const query = params.search!.toLowerCase();
        const q = (s: string) => s.toLowerCase().includes(query);
        const matching = allTools().filter((t) => q(t.name) || q(t.qualified) || q(t.description ?? ""));
        const hits = matching.slice(0, MAX_SEARCH_RESULTS);
        const body =
          matching.length === 0 ? `No tools matching "${params.search}".` : formatSearchHits(hits, matching.length);
        return reply(body + unreachableNote(failed));
      }

      if (mode === "describe") {
        const failed = await connectForResolve(params.describe!);
        const tool = resolveToolByName(allTools(), params.describe!);
        const text = `${tool.qualified}${tool.description ? `\n\n${tool.description}` : ""}\n\nParameters: ${JSON.stringify(tool.inputSchema ?? {}, null, 1)}`;
        return reply(text + unreachableNote(failed));
      }

      // mode === "call": connect lazily before resolving so a bare
      // mcp({ tool }) works on first use.
      await connectForResolve(params.tool!);
      const tool = resolveToolByName(allTools(), params.tool!);
      const state = await ensureConnected(tool.server);
      state.activeCalls++;
      try {
        const result = await withTimeout(
          state.client!.callTool({ name: tool.name, arguments: params.args ?? {} }, undefined, {
            timeout: CALL_TIMEOUT_MS,
            signal,
          }),
          CALL_TIMEOUT_MS + 5_000,
          `Call ${tool.qualified}`,
        );
        return reply(serializeCallResult(result));
      } finally {
        state.activeCalls--;
        scheduleIdleClose(state);
      }
    },
  });

  /** A pinned MCP tool exposed as a native pi tool: the server's own schema and
   * description, execute routed through the shared connection machinery —
   * pinned servers connect eagerly at load so the schema is in hand. */
  function registerPinnedTool(tool: ToolMeta): void {
    const description = tool.description?.trim() || "(no description)";
    pi.registerTool({
      name: tool.qualified,
      label: tool.qualified,
      description: `${description} — direct proxy for MCP server "${tool.server}"; everything else stays behind the mcp gateway.`,
      promptSnippet: description.split("\n")[0].slice(0, 120).trim() || "(no description)",
      parameters: tool.inputSchema as TSchema,
      async execute(_id, params, signal) {
        if (signal?.aborted) throw new Error("Aborted");
        const state = await ensureConnected(tool.server);
        state.activeCalls++;
        try {
          const result = await withTimeout(
            state.client!.callTool(
              { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
              undefined,
              {
                timeout: CALL_TIMEOUT_MS,
                signal,
              },
            ),
            CALL_TIMEOUT_MS + 5_000,
            `Call ${tool.qualified}`,
          );
          return reply(serializeCallResult(result));
        } finally {
          state.activeCalls--;
          scheduleIdleClose(state);
        }
      },
    });
  }

  // Pins resolve against their named server only, so an unreachable or unknown
  // pin never blocks the rest — it degrades to a status line. The name and
  // schema guards exist because a bad pin fails at the provider on every
  // request, not just when called — registration-time acceptance isn't enough.
  if (config.pin !== undefined && !Array.isArray(config.pin)) {
    pinIssues.push("pin: config must be an array of server__tool strings");
  }
  for (const pin of new Set(Array.isArray(config.pin) ? config.pin : [])) {
    if (typeof pin !== "string") {
      pinIssues.push(`${JSON.stringify(pin)}: pin entries must be strings (server__tool)`);
      continue;
    }
    if (!/^[\w-]{1,64}$/.test(pin)) {
      pinIssues.push(`${pin}: tool name must be 1-64 chars of [a-zA-Z0-9_-] for providers`);
      continue;
    }
    const sep = pin.indexOf("__");
    const serverName = sep > 0 ? pin.slice(0, sep) : undefined;
    const state = serverName !== undefined ? servers.get(serverName) : undefined;
    if (serverName === undefined || state === undefined) {
      if (serverName !== undefined && config.mcpServers?.[serverName]?.disabled) {
        pinIssues.push(`${pin}: server is disabled`);
      } else {
        pinIssues.push(`${pin}: unknown server (pins use server__tool names)`);
      }
      continue;
    }
    if (state.invalid) {
      pinIssues.push(`${pin}: server config invalid (${state.invalid})`);
      continue;
    }
    try {
      await ensureMeta(serverName);
      const tool = state.tools?.find((t) => t.name === pin.slice(sep + 2));
      if (!tool) {
        pinIssues.push(`${pin}: not offered by ${serverName}`);
        continue;
      }
      const schema = tool.inputSchema as { type?: unknown } | undefined;
      if (!schema || schema.type !== "object") {
        pinIssues.push(`${pin}: input schema is not an object`);
        continue;
      }
      if (JSON.stringify(schema).includes("$ref")) {
        pinIssues.push(`${pin}: schema uses $ref — not portable to all providers`);
        continue;
      }
      registerPinnedTool(tool);
      pinnedTools.push(pin);
    } catch (error) {
      pinIssues.push(`${pin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export default async function (pi: ExtensionAPI) {
  await registerMcpTool(pi);
}
