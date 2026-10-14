/** Agent definitions and their discovery: YAML-frontmatter parsing, tool
 * restriction resolution, the named/inline/generic agent resolution chain,
 * loading from ~/.pi/agent/agents, and the one-/command-per-agent
 * registration. Pure file/text work — no child processes. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDef, BUILTIN_TOOLS, THINKING_LEVELS, isValidThinkingLevel } from "./child";

/** Frontmatter delimiter: `---` at column 0, tolerant of trailing whitespace. */
const DELIMITER = /^---[ \t]*$/;

/** Split YAML frontmatter from the body. Throws on invalid YAML so a broken
 * tools restriction can never be silently ignored; handles BOM, CRLF, and
 * `---` inside indented block-scalar content. */
export function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (!DELIMITER.test(lines[0] ?? "")) return { fm: {}, body: text };
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER.test(lines[i])) {
      const parsed = parseYaml(lines.slice(1, i).join("\n"));
      const body = lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n/, "");
      if (parsed === null || parsed === undefined) return { fm: {}, body };
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("frontmatter must be a YAML mapping of key/value pairs");
      }
      return { fm: parsed as Record<string, unknown>, body };
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
  const names =
    typeof t === "string" && t.trim()
      ? t
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(t)
        ? t
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
  if (names) {
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
  const thinking = typeof fm.thinking === "string" && fm.thinking ? fm.thinking : undefined;
  // A typo'd level would silently clamp to a default in the child — a
  // quiet quality drop. Fail at load instead (named files are skipped with
  // a warning; inline agent_md errors back to the caller).
  if (thinking !== undefined && !isValidThinkingLevel(thinking)) {
    throw new Error(`agent ${name}: invalid thinking "${thinking}" — must be one of ${THINKING_LEVELS.join("|")}`);
  }
  return {
    name,
    description: typeof fm.description === "string" ? fm.description : "",
    instructions: body,
    tools: resolveTools(fm),
    model: typeof fm.model === "string" && fm.model ? fm.model : undefined,
    thinking,
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
  if (!agent)
    throw new Error(`Agent "${name}" not found. Available: ${list.map((a) => a.name).join(", ") || "(none)"}`);
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

// Streaming renders call refLabel repeatedly with the same agent_md; a
// one-entry memo makes those consecutive calls skip the YAML parse.
let labelCache: { md: string; label: string } | undefined;

/** Display name for a task item, without resolving the full definition.
 * Tolerates unparseable agent_md — the error surfaces when the task runs. */
export function refLabel(ref: AgentRef): string {
  if (ref.agent) return ref.agent;
  const md = ref.agent_md ?? "";
  if (labelCache?.md === md) return labelCache.label;
  try {
    const fm = splitFrontmatter(md).fm;
    const label = typeof fm.name === "string" && fm.name ? fm.name : "generic";
    labelCache = { md, label };
    return label;
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

export const AGENTS_DIR = join(homedir(), ".pi/agent/agents");

/** Command names must be a single word: letters, digits, hyphens, underscores. */
export function isValidCommandName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
}

/** User message sent by an agent command. Generic across agents — the agent's
 * own definition carries its instructions, so only the task varies. */
export function buildCommandPrompt(agentName: string, task: string): string {
  return `Delegate the task below to the "${agentName}" subagent using the subagent tool — pass the text verbatim as the task. The subagent only sees what you send, so include all context it needs (files, diffs, errors, constraints):\n\n${task}`;
}

/** pi's built-in commands take precedence over extension commands with the
 * same name, so registering these would produce unreachable commands. Derived
 * from the documented built-in list; may lag pi releases. Also includes
 * `llama`, which collides with a command from pi's bundled llama extension. */
const RESERVED_COMMAND_NAMES = new Set([
  "settings",
  "model",
  "thinking",
  "scoped-models",
  "login",
  "logout",
  "llama",
  "new",
  "resume",
  "name",
  "session",
  "tree",
  "fork",
  "clone",
  "compact",
  "import",
  "copy",
  "export",
  "share",
  "bug",
  "trust",
  "reload",
  "hotkeys",
  "changelog",
  "quit",
]);

/** Register one `/name` command per agent. Invoking `/name task` sends a user
 * message that delegates `task` to that subagent. Pure over the agent list so
 * callers control discovery and ordering. */
export function registerCommandsForAgents(pi: ExtensionAPI, agents: readonly AgentDef[]): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!isValidCommandName(agent.name)) {
      console.warn(
        `subagents: skipping command for "${agent.name}": name must be a single word (letters, digits, hyphens, underscores)`,
      );
      continue;
    }
    if (RESERVED_COMMAND_NAMES.has(agent.name)) {
      console.warn(
        `subagents: skipping command for "${agent.name}": reserved by a pi built-in command; the agent is still available via the subagent tool`,
      );
      continue;
    }
    if (seen.has(agent.name)) {
      console.warn(
        `subagents: skipping duplicate command for "${agent.name}"; the subagent tool resolves to the first agent with that name`,
      );
      continue;
    }
    seen.add(agent.name);
    pi.registerCommand(agent.name, {
      description: agent.description || `Delegate a task to the ${agent.name} subagent`,
      handler: async (args, ctx) => {
        const task = args.trim();
        if (!task) {
          ctx.ui.notify(
            `Usage: /${agent.name} <task> — ${agent.description || "define a description in the agent's frontmatter"}`,
            "info",
          );
          return;
        }
        pi.sendUserMessage(buildCommandPrompt(agent.name, task), { deliverAs: "followUp" });
      },
    });
  }
}

/** Register commands for every agent discovered in `agentsDir`. */
export function registerSubagentCommands(pi: ExtensionAPI, agentsDir: string = AGENTS_DIR): void {
  registerCommandsForAgents(pi, loadAgents(agentsDir));
}
