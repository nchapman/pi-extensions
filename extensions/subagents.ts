import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_DIR = join(homedir(), ".pi/agent/agents");
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.PI_SUBAGENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

interface AgentDef {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model?: string;
  thinking?: string;
}

function parseFrontmatter(text: string): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return out;
  let current: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const indent = line.length - line.trimStart().length;
    const m = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, , key, rawValue] = m;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (indent === 0) {
      if (value === "") {
        out[key] = {};
        current = key;
      } else {
        out[key] = value;
        current = null;
      }
    } else if (current) {
      const parent = out[current];
      if (typeof parent === "object") parent[key] = value;
    }
  }
  return out;
}

function loadAgents(): AgentDef[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const agents: AgentDef[] = [];
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(AGENTS_DIR, file), "utf8");
    const fm = parseFrontmatter(text);
    const bodyStart = text.indexOf("---", 3);
    const instructions = bodyStart >= 0 ? text.slice(bodyStart + 3).replace(/^\n/, "") : text;
    const toolsMap = (fm.tools ?? {}) as Record<string, string>;
    agents.push({
      name: (fm.name as string) ?? file.replace(/\.md$/, ""),
      description: (fm.description as string) ?? "",
      instructions,
      tools: BUILTIN_TOOLS.filter((t) => toolsMap[t] !== "false"),
      model: fm.model as string | undefined,
      thinking: fm.thinking as string | undefined,
    });
  }
  return agents;
}

function findAgent(name: string): AgentDef {
  const agents = loadAgents();
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    throw new Error(`Agent "${name}" not found. Available: ${agents.map((a) => a.name).join(", ") || "(none)"}`);
  }
  return agent;
}

function runChild(agent: AgentDef, task: string, model: string | undefined, onUpdate?: (partial: AgentToolResult) => void, signal?: AbortSignal): Promise<string> {
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

  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastText = "";

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const content = event.message.content;
          if (Array.isArray(content)) {
            lastText = content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text?: string }) => b.text ?? "")
              .join("\n");
          }
          if (lastText && onUpdate) onUpdate({ content: [{ type: "text", text: lastText }], details: { agent: agent.name, status: "running" } });
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Subagent "${agent.name}" timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`));
    }, DEFAULT_TIMEOUT_MS);

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(lastText || "(no output)");
      else reject(new Error(`Subagent "${agent.name}" exited with code ${code}: ${stderrBuf.slice(-500) || "no stderr"}`));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn pi for subagent "${agent.name}": ${error.message}`));
    });
  });
}

const taskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "The task to delegate, with full context" }),
  model: Type.Optional(Type.String({ description: "Model override (provider/id)" })),
});

export default function (pi: ExtensionAPI) {
  const agents = loadAgents();
  const agentList = agents.length
    ? agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n")
    : "(no agents found in ~/.pi/agent/agents/)";

  const runOne = async (name: string, task: string, model: string | undefined, onUpdate?: (p: AgentToolResult) => void, signal?: AbortSignal) => {
    const agent = findAgent(name);
    return runChild(agent, task, model, onUpdate, signal);
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a focused task to a subagent: a fresh pi session with its own context, system prompt, and tool restrictions.
Available agents:
${agentList}
The subagent runs to completion and returns its final response. Use for reviews, research, and any work that benefits from an isolated context.`,
    promptSnippet: "Delegate a task to a focused subagent (isolated pi session)",
    promptGuidelines: [
      "Use subagent for self-contained work (reviews, research, audits); the subagent only sees the task text you pass, so include all needed context.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      task: Type.String({ description: "The task to delegate, with full context" }),
      model: Type.Optional(Type.String({ description: "Model override (provider/id)" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const text = await runOne(params.agent, params.task, params.model, (p) => onUpdate?.(p), signal);
      return { content: [{ type: "text", text }], details: { agent: params.agent } };
    },
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: `Run multiple subagents in parallel. Each task gets an isolated pi session.
Available agents:
${agentList}`,
    parameters: Type.Object({
      tasks: Type.Array(taskItem, { description: "Tasks to run in parallel" }),
    }),
    async execute(_id, params, signal) {
      const results = await Promise.allSettled(
        params.tasks.map((t) => runOne(t.agent, t.task, t.model, undefined, signal)),
      );
      const sections = results.map((r, i) => {
        const t = params.tasks[i];
        const body = r.status === "fulfilled" ? r.value : `ERROR: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
        return `### ${t.agent}\n${body}`;
      });
      return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }], details: { count: params.tasks.length } };
    },
  });
}
