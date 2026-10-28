/** Agent definitions and their discovery: YAML-frontmatter parsing, tool
 * restriction resolution, the named/inline/generic agent resolution chain,
 * loading from ~/.pi/agent/agents, and the one-/command-per-agent
 * registration. Pure file/text work — no child processes. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentDef,
  BUILTIN_TOOLS,
  EXTENSION_NAME_RE,
  THINKING_LEVELS,
  isValidThinkingLevel,
  resolveChildExtensions,
} from "./child";

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

/** A tool name pi's --tools accepts as a plain entry. pi also allows
 * modifier entries (`+name`, `-name`, patterns like `*`) that adjust the
 * *default* selection instead of restricting it — forwarding one verbatim
 * either makes the child exit(1) (mixed names and modifiers) or silently
 * swaps the explicit allowlist for the settings default. Passthrough extras
 * must therefore be plain names; anything else warns and drops. */
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function warnUnknownTools(kind: string, names: string[], extensions: readonly string[]): void {
  // With extensions declared, non-builtin names are extension tools (ssh_bash,
  // …) loaded into the child via -e — pass them through. Without extensions
  // they are typos: warn and drop, since the child would never see the tool.
  const unknown = names.filter((n) => !BUILTIN_TOOLS.includes(n));
  if (unknown.length > 0 && extensions.length === 0) {
    console.warn(
      `tools: ignoring unknown ${kind} ${unknown.map((n) => `"${n}"`).join(", ")} (known: ${BUILTIN_TOOLS.join(", ")}; list extension tools only alongside \`extensions:\`)`,
    );
  }
}

/** Tools restriction accepts an allowlist string (`tools: read, bash`), an
 * allowlist array (`tools: [read, bash]`), or a per-tool enable map
 * (`tools: {write: false}`); anything else means all built-in tools.
 * A map entry with no value (`write:`) disables the tool — fail closed.
 * When the agent declares extensions, allowlist entries beyond the builtins
 * pass through unchanged so extension tools can be granted explicitly; the
 * map form cannot grant them (it only restricts builtins) and says so. */
export function resolveTools(fm: Record<string, unknown>, extensions: readonly string[] = []): string[] {
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
    warnUnknownTools("name(s) in", names, extensions);
    const allow = new Set(names);
    const builtins = BUILTIN_TOOLS.filter((b) => allow.has(b));
    let extra: string[] = [];
    if (extensions.length > 0) {
      const nonBuiltin = names.filter((n) => !BUILTIN_TOOLS.includes(n));
      extra = nonBuiltin.filter((n) => TOOL_NAME_RE.test(n));
      const rejected = nonBuiltin.filter((n) => !TOOL_NAME_RE.test(n));
      if (rejected.length > 0) {
        console.warn(
          `tools: dropping ${rejected.map((n) => `"${n}"`).join(", ")} — not plain tool names (+name/-name/pattern entries would break or bypass the child's --tools allowlist)`,
        );
      }
    }
    return [...builtins, ...extra];
  }
  if (t && typeof t === "object") {
    const map = t as Record<string, unknown>;
    warnUnknownTools("key(s) in", Object.keys(map), extensions);
    if (extensions.length > 0) {
      const ungrantable = Object.keys(map).filter((k) => !BUILTIN_TOOLS.includes(k));
      if (ungrantable.length > 0) {
        console.warn(
          `tools: map form cannot grant extension tool(s) ${ungrantable.map((k) => `"${k}"`).join(", ")} — use the allowlist form (tools: [read, ${ungrantable[0]}])`,
        );
      }
    }
    return BUILTIN_TOOLS.filter((b) => {
      const raw = map[b];
      if (raw === undefined) return true;
      if (raw === null) return false;
      return isEnabled(raw);
    });
  }
  return [...BUILTIN_TOOLS];
}

/** `extensions:` accepts a comma/space-separated string or an array of
 * sibling-extension names the child loads via `-e`. Invalid-shaped names
 * (paths, dots) warn and skip — they can never walk the filesystem. */
export function parseExtensions(fm: Record<string, unknown>): string[] {
  const raw = fm.extensions;
  if (raw !== undefined && typeof raw !== "string" && !Array.isArray(raw)) {
    // A wrong shape (a YAML map, a bare number) would otherwise silently
    // degrade every run of this agent to an isolated child — the exact
    // misleading "model not found" failure the run-time hint untangles.
    console.warn(`extensions: ignoring ${typeof raw} value — use a list of extension directory names`);
    return [];
  }
  const names = typeof raw === "string" && raw.trim() ? raw.split(/[,\s]+/) : Array.isArray(raw) ? raw.map(String) : [];
  const valid: string[] = [];
  for (const name of names) {
    const n = name.trim();
    if (!n) continue;
    if (!EXTENSION_NAME_RE.test(n)) {
      console.warn(`extensions: ignoring "${n}" — must be a plain extension directory name`);
      continue;
    }
    if (!valid.includes(n)) valid.push(n);
  }
  return valid;
}

/**
 * Parse an agent markdown definition containing YAML frontmatter and markdown body instructions.
 * Validates thinking level if specified and falls back to fallbackName if frontmatter omits a name.
 * `extensions:` is honored only for trusted sources (agent files under the
 * agents dir, human-authored): inline agent_md is model-authored, and a
 * prompt-supplied definition granting itself extension capabilities is
 * escalation by prompt — stripped there with a warning, fail closed.
 */
export function agentFromText(text: string, fallbackName: string, opts: { trusted?: boolean } = {}): AgentDef {
  const { fm, body } = splitFrontmatter(text);
  const name = typeof fm.name === "string" && fm.name ? fm.name : fallbackName;
  const thinking = typeof fm.thinking === "string" && fm.thinking ? fm.thinking : undefined;
  // A typo'd level would silently clamp to a default in the child — a
  // quiet quality drop. Fail at load instead (named files are skipped with
  // a warning; inline agent_md errors back to the caller).
  if (thinking !== undefined && !isValidThinkingLevel(thinking)) {
    throw new Error(`agent ${name}: invalid thinking "${thinking}" — must be one of ${THINKING_LEVELS.join("|")}`);
  }
  let extensions = parseExtensions(fm);
  if (!opts.trusted && extensions.length > 0) {
    console.warn(
      `agent ${name}: ignoring "extensions:" in an inline definition — extension grants belong in an agent file`,
    );
    extensions = [];
  }
  return {
    name,
    description: typeof fm.description === "string" ? fm.description : "",
    instructions: body,
    tools: resolveTools(fm, extensions),
    toolsSpec: fm.tools,
    model: typeof fm.model === "string" && fm.model ? fm.model : undefined,
    thinking,
    extensions,
    trusted: opts.trusted === true || undefined,
  };
}

/** The agent as its children will run it: when the file declares no
 * extensions of its own, PI_SUBAGENT_EXTENSIONS fills in (a human-set knob —
 * it applies to ad-hoc inline agents too, by its own meaning of "every
 * subagent"), and tools re-resolve from the raw spec so extension tools
 * named in the allowlist survive — they were dropped at parse time as
 * non-builtin names because the file declared no extensions. Untrusted
 * (inline) definitions keep their parse-time tools: re-resolving would
 * re-grant exactly the extension tools the trust strip removed, letting a
 * model-authored definition grant itself capabilities. */
export function effectiveAgent(agent: AgentDef, env: NodeJS.ProcessEnv = process.env): AgentDef {
  if (agent.extensions?.length) return agent;
  const extensions = resolveChildExtensions(agent, env);
  if (extensions.length === 0) return agent;
  if (!agent.trusted) return { ...agent, extensions };
  return { ...agent, extensions, tools: resolveTools({ tools: agent.toolsSpec }, extensions) };
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

/** Reference identifying an agent by pre-registered name or inline markdown definition. */
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

/**
 * Scan a directory for `*.md` files and load them into agent definitions.
 * Skips files that fail frontmatter parsing or carry invalid configurations.
 */
export function loadAgents(dir: string): AgentDef[] {
  if (!existsSync(dir)) return [];
  const agents: AgentDef[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(dir, file), "utf8");
      // Agent files are human-authored config — only they may grant extensions.
      agents.push(agentFromText(text, file.replace(/\.md$/, ""), { trusted: true }));
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

/** Default directory containing user agent definition markdown files (`~/.pi/agent/agents`). */
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
