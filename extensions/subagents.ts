import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const STDERR_TAIL_MAX = 8 * 1024;
const STDOUT_BUF_MAX = 1024 * 1024;

export interface AgentDef {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model?: string;
  thinking?: string;
}

export function parseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PI_SUBAGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function parseConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PI_SUBAGENT_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
}

/** Frontmatter delimiter: `---` at column 0, tolerant of trailing whitespace. */
const DELIMITER = /^---[ \t]*$/;

/** Split YAML frontmatter from the body. Throws on invalid YAML so a broken
 * tools restriction can never be silently ignored; handles BOM, CRLF, and
 * `---` inside indented block-scalar content. */
export function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (!DELIMITER.test(lines[0] ?? "")) return { fm: {}, body: text };
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER.test(lines[i])) {
      const parsed = parseYaml(lines.slice(1, i).join("\n"));
      if (parsed === null || parsed === undefined) return { fm: {}, body: lines.slice(i + 1).join("\n").replace(/^\n/, "") };
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("frontmatter must be a YAML mapping of key/value pairs");
      }
      return { fm: parsed as Record<string, unknown>, body: lines.slice(i + 1).join("\n").replace(/^\n/, "") };
    }
  }
  // Unterminated frontmatter: treat the whole file as body.
  return { fm: {}, body: text };
}

const FALSY = new Set(["", "false", "0", "no", "off"]);

/** Truthiness for tools-map values, tolerant of YAML booleans and strings. */
function isEnabled(raw: unknown): boolean {
  return !FALSY.has(String(raw).trim().toLowerCase());
}

function warnUnknownTools(kind: string, names: string[]): void {
  const unknown = names.filter((n) => !BUILTIN_TOOLS.includes(n)).map((n) => `"${n}"`);
  if (unknown.length > 0) {
    console.warn(`tools: ignoring unknown ${kind} ${unknown.join(", ")} (known: ${BUILTIN_TOOLS.join(", ")})`);
  }
}

/** Tools restriction accepts an allowlist string (`tools: read, bash`), an
 * allowlist array (`tools: [read, bash]`), or a per-tool enable map
 * (`tools: {write: false}`); anything else means all built-in tools.
 * A map entry with no value (`write:`) disables the tool — fail closed. */
export function resolveTools(fm: Record<string, unknown>): string[] {
  const t = fm.tools;
  if (typeof t === "string" && t.trim()) {
    const names = t.split(",").map((s) => s.trim()).filter(Boolean);
    warnUnknownTools("name(s) in", names);
    const allow = new Set(names);
    return BUILTIN_TOOLS.filter((b) => allow.has(b));
  }
  if (Array.isArray(t)) {
    const names = t.map(String).map((s) => s.trim()).filter(Boolean);
    warnUnknownTools("name(s) in", names);
    const allow = new Set(names);
    return BUILTIN_TOOLS.filter((b) => allow.has(b));
  }
  if (t && typeof t === "object") {
    const map = t as Record<string, unknown>;
    warnUnknownTools("key(s) in", Object.keys(map));
    return BUILTIN_TOOLS.filter((b) => {
      const raw = map[b];
      if (raw === undefined) return true;
      if (raw === null) return false;
      return isEnabled(raw);
    });
  }
  return [...BUILTIN_TOOLS];
}

export function agentFromText(text: string, fallbackName: string): AgentDef {
  const { fm, body } = splitFrontmatter(text);
  const name = typeof fm.name === "string" && fm.name ? fm.name : fallbackName;
  return {
    name,
    description: typeof fm.description === "string" ? fm.description : "",
    instructions: body,
    tools: resolveTools(fm),
    model: typeof fm.model === "string" && fm.model ? fm.model : undefined,
    thinking: typeof fm.thinking === "string" && fm.thinking ? fm.thinking : undefined,
  };
}

/** Generic agent used when a call names no agent and supplies no definition. */
export const DEFAULT_AGENT_MD = `---
name: generic
description: General-purpose subagent. Investigates and reports; does not modify files.
tools:
  write: false
  edit: false
---

You are a focused subagent operating in an isolated pi session. The parent agent delegated a task to you; your reply is the only thing they will see, so make it complete and self-contained.

- Read the task carefully and answer exactly what was asked.
- Investigate with your tools (read, grep, find, ls, bash) before answering; verify claims against the actual code or data rather than guessing.
- Do not modify files — you are analysis-oriented by default.
- Structure the reply for the parent agent: lead with the answer, then supporting details, file paths, and evidence.
- If the task is ambiguous or cannot be completed, say so plainly and explain what is missing instead of improvising.
`;

export interface AgentRef {
  agent?: string;
  agent_md?: string;
}

function findAgent(list: AgentDef[], name: string): AgentDef {
  const agent = list.find((a) => a.name === name);
  if (!agent) throw new Error(`Agent "${name}" not found. Available: ${list.map((a) => a.name).join(", ") || "(none)"}`);
  return agent;
}

/** Resolve a task item to an agent: named file, inline definition, or the generic default. */
export function resolveAgentDef(list: AgentDef[], ref: AgentRef): AgentDef {
  if (ref.agent && ref.agent_md) {
    throw new Error('Provide either "agent" or "agent_md", not both');
  }
  if (ref.agent_md) return agentFromText(ref.agent_md, "ad-hoc");
  if (ref.agent) return findAgent(list, ref.agent);
  return agentFromText(DEFAULT_AGENT_MD, "generic");
}

/** Display name for a task item, without resolving the full definition.
 * Tolerates unparseable agent_md — the error surfaces when the task runs. */
export function refLabel(ref: AgentRef): string {
  if (ref.agent) return ref.agent;
  try {
    const fm = splitFrontmatter(ref.agent_md ?? "").fm;
    return typeof fm.name === "string" && fm.name ? fm.name : "generic";
  } catch {
    return "generic";
  }
}

export function loadAgents(dir: string): AgentDef[] {
  if (!existsSync(dir)) return [];
  const agents: AgentDef[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(dir, file), "utf8");
      agents.push(agentFromText(text, file.replace(/\.md$/, "")));
    } catch (error) {
      console.warn(`subagents: skipping ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return agents;
}

/** Extract text blocks from a message content array. */
export function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: unknown) => (b as { type?: string } | null)?.type === "text")
    .map((b: unknown) => (b as { text?: string }).text ?? "")
    .join("\n");
}

export interface ChildLike {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as ChildLike;

export interface RunChildOptions {
  timeoutMs?: number;
  onUpdate?: (partial: AgentToolResult) => void;
  signal?: AbortSignal;
}

export function buildChildArgs(agent: AgentDef, task: string, model?: string): string[] {
  const args = [
    "-p",
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt", agent.instructions,
    "--tools", agent.tools.join(","),
  ];
  const effectiveModel = model ?? agent.model;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  args.push("--", task);
  return args;
}

export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions = {},
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { onUpdate, signal } = options;
  return new Promise((resolve, reject) => {
    const child = spawnFn("pi", buildChildArgs(agent, task, model), { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastText = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = extractAssistantText(event.message.content);
          if (text) {
            lastText = text;
            onUpdate?.({ content: [{ type: "text", text: lastText }], details: { agent: agent.name, status: "running" } });
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > STDOUT_BUF_MAX) {
        const nl = stdoutBuf.lastIndexOf("\n");
        stdoutBuf = nl >= 0 ? stdoutBuf.slice(nl + 1) : "";
      }
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > STDERR_TAIL_MAX) stderrBuf = stderrBuf.slice(-STDERR_TAIL_MAX);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error(`Subagent "${agent.name}" timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = () => {
      child.kill("SIGKILL");
      settle(() => reject(signal?.reason ?? new Error(`Subagent "${agent.name}" aborted`)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      settle(() => {
        if (signal?.aborted) reject(signal.reason ?? new Error(`Subagent "${agent.name}" aborted`));
        else if (code === 0) resolve(lastText || "(no output)");
        else reject(new Error(`Subagent "${agent.name}" exited with code ${code}: ${stderrBuf.slice(-500) || "no stderr"}`));
      });
    });
    child.on("error", (error) => {
      cleanup();
      settle(() => reject(new Error(`Failed to spawn pi for subagent "${agent.name}": ${error.message}`)));
    });
  });
}

/** Run jobs with bounded concurrency; results preserve input order. */
export async function runWithLimit<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      try {
        results[i] = { status: "fulfilled", value: await jobs[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const taskField = Type.String({ description: "The task to delegate, with full context" });
const modelField = Type.Optional(Type.String({ description: "Model override (provider/id)" }));
const taskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Named agent from the available list" })),
  agent_md: Type.Optional(Type.String({ description: "Inline agent definition: markdown with optional frontmatter (name, description, tools, model, thinking) followed by the system prompt. Takes precedence over the generic default. Provide either agent or agent_md, not both." })),
  task: taskField,
  model: modelField,
});

const AGENTS_DIR = join(homedir(), ".pi/agent/agents");

export function registerSubagentTools(pi: ExtensionAPI, agentsDir: string = AGENTS_DIR, spawnFn: SpawnFn = defaultSpawn): void {
  const agents = loadAgents(agentsDir);
  const agentList = agents.length
    ? agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n")
    : `(no agents found in ${agentsDir})`;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a focused task to a subagent: a fresh pi session with its own context, system prompt, and tool restrictions.
Available agents:
${agentList}
Alternatively pass agent_md: a full agent definition in markdown (frontmatter + system prompt) for an ad-hoc specialist. With neither, a generic read-only investigator runs.
The subagent runs to completion and returns its final response. Use for reviews, research, and any work that benefits from an isolated context.`,
    promptSnippet: "Delegate a task to a focused subagent (isolated pi session)",
    promptGuidelines: [
      "Use subagent for self-contained work (reviews, research, audits); the subagent only sees the task text you pass, so include all needed context.",
      "For a bespoke specialist, pass agent_md with the exact instructions and tool restrictions instead of forcing a named agent to fit.",
    ],
    parameters: taskItem,
    async execute(_id, params, signal, onUpdate) {
      const list = loadAgents(agentsDir);
      const agent = resolveAgentDef(list, params);
      const text = await runChild(agent, params.task, params.model, {
        timeoutMs: parseTimeoutMs(process.env),
        onUpdate,
        signal,
      }, spawnFn);
      return { content: [{ type: "text", text }], details: { agent: agent.name } };
    },
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: `Run multiple subagents in parallel. Each task gets an isolated pi session.
Available agents:
${agentList}
Each task may instead include agent_md (an inline agent definition) or omit both to use the generic read-only investigator.`,
    parameters: Type.Object({
      tasks: Type.Array(taskItem, { minItems: 1, description: "Tasks to run in parallel" }),
    }),
    async execute(_id, params, signal) {
      const list = loadAgents(agentsDir);
      const timeoutMs = parseTimeoutMs(process.env);
      const results = await runWithLimit(
        params.tasks.map((t) => () => {
          const agent = resolveAgentDef(list, t);
          return runChild(agent, t.task, t.model, { timeoutMs, signal }, spawnFn);
        }),
        parseConcurrency(process.env),
      );
      const sections = results.map((r, i) => {
        const label = refLabel(params.tasks[i]);
        const body = r.status === "fulfilled" ? r.value : `ERROR: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
        return `### ${label}\n${body}`;
      });
      return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }], details: { count: params.tasks.length } };
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSubagentTools(pi);
}
