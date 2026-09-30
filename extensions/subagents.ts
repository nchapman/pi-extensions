import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type AdoptedHandle,
  type BackgroundRegistry,
  capResultText,
  createBackgroundRegistry,
  createBgTool,
  createKillTaskTool,
  createTasksCommand,
  type BashSpawnFn,
  DEFAULT_BG_AFTER_MS,
  formatSubagentWake,
  parseBgAfterMs,
  parseWakeEnabled,
} from "../lib/background";

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

export interface ChildLike {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildLike;

export interface RunChildOptions {
  timeoutMs?: number;
  onUpdate?: (partial: AgentToolResult) => void;
  signal?: AbortSignal;
  /** Soft threshold in ms: hand the still-running child to onAdopted instead of waiting. */
  adoptAfterMs?: number;
  onAdopted?: OnAdopted;
}

/** What runChild hands to onAdopted when the soft threshold fires: the child's eventual outcome, plus a kill switch. Returns the task id embedded in the adoption marker. */
export type OnAdopted = (handle: AdoptedHandle<ChildRun>) => string;

/** runChild's result: the child's outcome, or a marker carrying the background task id. */
export type ChildOutcome = ChildRun | { adopted: true; id: string };

export function buildChildArgs(agent: AgentDef, task: string, model?: string): string[] {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt",
    agent.instructions,
    "--tools",
    agent.tools.join(","),
  ];
  const effectiveModel = model ?? agent.model;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  args.push("--", task);
  return args;
}

/** What runChild resolves with: the child's final text plus its cumulative usage, when reported. */
export interface ChildRun {
  text: string;
  usage?: ChildUsage;
}

/** Required fields of pi-ai's Usage, as it appears on JSON-mode assistant messages. */
export interface ChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Subset of output, reported by providers that expose a reasoning breakdown. */
  reasoning?: number;
  /** Subset of cacheWrite with 1h retention (Anthropic). */
  cacheWrite1h?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function looksLikeUsage(u: unknown): u is ChildUsage {
  if (typeof u !== "object" || u === null) return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const optNum = (v: unknown) => v === undefined || num(v);
  const { cost } = u as { cost?: unknown };
  if (typeof cost !== "object" || cost === null) return false;
  const c = cost as ChildUsage["cost"];
  return (
    num((u as ChildUsage).input) &&
    num((u as ChildUsage).output) &&
    num((u as ChildUsage).cacheRead) &&
    num((u as ChildUsage).cacheWrite) &&
    num((u as ChildUsage).totalTokens) &&
    optNum((u as ChildUsage).reasoning) &&
    optNum((u as ChildUsage).cacheWrite1h) &&
    num(c.input) &&
    num(c.output) &&
    num(c.cacheRead) &&
    num(c.cacheWrite) &&
    num(c.total)
  );
}

/** Sum two usage records; optional fields carry through when either side reports them. */
function addUsage(a: ChildUsage, b: ChildUsage): ChildUsage {
  const opt = (x: number | undefined, y: number | undefined) => (x === undefined ? y : y === undefined ? x : x + y);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoning: opt(a.reasoning, b.reasoning),
    cacheWrite1h: opt(a.cacheWrite1h, b.cacheWrite1h),
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** Sum per-child run totals so batch results keep session cost accounting accurate; undefined when no child reported any. */
export function sumUsages(list: Array<ChildUsage | undefined>): ChildUsage | undefined {
  const valid = list.filter((u): u is ChildUsage => u !== undefined);
  return valid.length ? valid.reduce(addUsage) : undefined;
}

/** One-line usage for wake headers: "105 tokens (100 in / 5 out), $0.120". */
export function formatUsageLine(u: ChildUsage): string {
  const k = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  return `${k(u.totalTokens)} tokens (${k(u.input)} in / ${k(u.output)} out), $${u.cost.total.toFixed(3)}`;
}

/** The tool result when a child moves to the background: what happened, and where the result will come from. */
export function backgroundedNotice(agentName: string, id: string): string {
  return `Subagent "${agentName}" is still running — moved to the background (${id}). Its result will arrive in a follow-up message when it completes (the hard timeout still applies); continue with other work meanwhile.`;
}

/** Adopt a still-running child into the registry and wire its wake. Returns the task id. */
export function adoptSubagentTask(
  registry: BackgroundRegistry,
  agentName: string,
  handle: AdoptedHandle<ChildRun>,
  sessionDir: string | undefined,
): string {
  const id = registry.adopt({ name: agentName, kind: "subagent", kill: handle.kill });
  // Duration counts from the child's spawn, not its adoption.
  const startedAt = handle.startedAt;
  handle.completion.then(
    (run) => {
      const capped = capResultText(run.text, sessionDir, id);
      registry.complete(id, {
        ok: true,
        text: formatSubagentWake(agentName, id, {
          ok: true,
          durationMs: Date.now() - startedAt,
          text: capped.text,
          usageLine: run.usage ? formatUsageLine(run.usage) : undefined,
        }),
      });
    },
    (error: Error & { usage?: ChildUsage }) => {
      registry.complete(id, {
        ok: false,
        text: formatSubagentWake(agentName, id, {
          ok: false,
          durationMs: Date.now() - startedAt,
          text: error.message,
          usageLine: error.usage ? formatUsageLine(error.usage) : undefined,
        }),
      });
    },
  );
  return id;
}

// Two overloads: a literal without onAdopted stays typed as ChildRun; anything
// else — including a prebuilt options variable — gets ChildOutcome and narrows.
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions & { onAdopted?: undefined },
  spawnFn?: SpawnFn,
): Promise<ChildRun>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions,
  spawnFn?: SpawnFn,
): Promise<ChildOutcome>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions,
  spawnFn?: SpawnFn,
): Promise<ChildOutcome>;
export function runChild(
  agent: AgentDef,
  task: string,
  model: string | undefined,
  options: RunChildOptions = {},
  spawnFn: SpawnFn = defaultSpawn,
): Promise<ChildOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { onUpdate, signal } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnFn("pi", buildChildArgs(agent, task, model), { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastText = "";
    let lastUsage: ChildUsage | undefined;
    let settled = false;
    // Adoption state: once the soft threshold fires, the outer promise has
    // resolved and every later event settles the completion promise instead.
    let adopted = false;
    let completionSettled = false;
    let completionResolve!: (run: ChildRun) => void;
    let completionReject!: (error: Error & { usage?: ChildUsage }) => void;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Failure paths still burned tokens: attach the spend so callers (the batch
    // sum) can credit it — the rejection alone would silently drop it.
    const rejectWith = (err: Error) => {
      if (lastUsage) Object.assign(err, { usage: lastUsage });
      reject(err);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          // Each assistant message carries its request's final usage; summing them
          // mirrors pi's own session accounting (message_update resets per request).
          if (looksLikeUsage(event.message.usage)) {
            lastUsage = lastUsage ? addUsage(lastUsage, event.message.usage) : event.message.usage;
          }
          const text = extractAssistantText(event.message.content);
          if (text) {
            lastText = text;
            // Partials have nowhere to go once the tool result returned (adoption).
            if (!adopted) {
              onUpdate?.({
                content: [{ type: "text", text: lastText }],
                details: { agent: agent.name, status: "running" },
              });
            }
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
      const error = new Error(`Subagent "${agent.name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
      // The hard timeout survives adoption: a backgrounded child still can't run forever.
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        if (lastUsage) Object.assign(error, { usage: lastUsage });
        completionReject(error);
      } else settle(() => rejectWith(error));
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = () => {
      child.kill("SIGKILL");
      settle(() => rejectWith(signal?.reason ?? new Error(`Subagent "${agent.name}" aborted`)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A signal aborted before registration never fires the listener — check
    // manually so an already-cancelled turn doesn't leave the child running.
    if (signal?.aborted) onAbort();

    // Soft threshold: hand the still-running child to onAdopted and resolve
    // immediately. The abort listener detaches — a backgrounded child survives
    // turn aborts — while stdout parsing and the hard timeout continue. A
    // throwing onAdopted falls back to the foreground failure contract.
    const adoptTimer = options.onAdopted
      ? setTimeout(() => {
          if (settled) return;
          signal?.removeEventListener("abort", onAbort);
          const completion = new Promise<ChildRun>((resolveCompletion, rejectCompletion) => {
            completionResolve = resolveCompletion;
            completionReject = rejectCompletion;
          });
          let id: string;
          try {
            id = options.onAdopted!({ completion, kill: () => child.kill("SIGKILL"), startedAt });
          } catch (error) {
            // Fence later events out of the completion path, kill the child,
            // and fail the call — adoption never happened.
            completionSettled = true;
            child.kill("SIGKILL");
            settle(() => reject(error instanceof Error ? error : new Error(String(error))));
            return;
          }
          adopted = true;
          settle(() => resolve({ adopted: true, id }));
        }, options.adoptAfterMs ?? DEFAULT_BG_AFTER_MS)
      : undefined;
    adoptTimer?.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(adoptTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    // Shared exit handling for the outer promise and an adopted child's
    // completion promise: success carries the final text and usage; failure
    // attaches the spend so callers can credit it.
    const finishClose = (
      code: number | null,
      fulfill: (run: ChildRun) => void,
      fail: (error: Error & { usage?: ChildUsage }) => void,
    ) => {
      if (code === 0) fulfill({ text: lastText || "(no output)", usage: lastUsage });
      else {
        const error = new Error(
          `Subagent "${agent.name}" exited with code ${code}: ${stderrBuf.slice(-500) || "no stderr"}`,
        );
        if (lastUsage) Object.assign(error, { usage: lastUsage });
        fail(error);
      }
    };

    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        finishClose(code, completionResolve, completionReject);
        return;
      }
      settle(() => {
        if (signal?.aborted) rejectWith(signal.reason ?? new Error(`Subagent "${agent.name}" aborted`));
        else finishClose(code, resolve, reject);
      });
    });
    child.on("error", (error) => {
      cleanup();
      const wrapped = new Error(`Failed to spawn pi for subagent "${agent.name}": ${error.message}`);
      if (adopted) {
        if (completionSettled) return;
        completionSettled = true;
        completionReject(wrapped);
        return;
      }
      settle(() => reject(wrapped));
    });
  });
}

/** Run jobs with bounded concurrency; results preserve input order. */
export async function runWithLimit<T>(
  jobs: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
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

/** Collapse a task to a single display line, capped for tool-call rows. */
export function summarizeTask(task: string, max = 72): string {
  const oneLine = task.trim().replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

const MAX_RENDERED_NAMES = 4;

/** One-line display for a `subagent` tool call: the agent's name and task. */
export function renderSubagentCall(agentName: string, task: string, theme: Pick<Theme, "fg" | "bold">): string {
  let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName);
  const summary = summarizeTask(task);
  if (summary) text += theme.fg("dim", ` — ${summary}`);
  return text;
}

/** One-line display for a `subagents` batch call: the count and agent names. */
export function renderSubagentsCall(agentNames: string[], theme: Pick<Theme, "fg" | "bold">): string {
  const shown =
    agentNames.slice(0, MAX_RENDERED_NAMES).join(", ") + (agentNames.length > MAX_RENDERED_NAMES ? ", ..." : "");
  let text = theme.fg("toolTitle", theme.bold(agentNames.length ? `subagents (${agentNames.length})` : "subagents"));
  if (shown) text += theme.fg("accent", ` ${shown}`);
  return text;
}

const RESULT_PREVIEW_LINES = 15;

/** Truncate one output line, preserving internal whitespace. */
function truncateLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

function firstNonEmptyLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

/** Result-row display for both subagent tools: a status line while running
 * (with the streamed tail), a summary when done, and an optional preview of
 * the full reply when expanded. */
export function renderSubagentResult(
  text: string,
  details: unknown,
  opts: { isPartial: boolean; expanded: boolean; isError: boolean },
  theme: Pick<Theme, "fg">,
): string {
  const d = details as { agent?: string; count?: number; backgrounded?: boolean | number } | undefined;
  if (opts.isPartial) {
    const status = theme.fg("warning", `running${d?.agent ? ` (${d.agent})` : ""}...`);
    const tail = lastNonEmptyLine(text);
    return tail ? `${status}\n${theme.fg("dim", truncateLine(tail, 100))}` : status;
  }
  const batch = typeof d?.count === "number";
  // Backgrounded: the tool call's job is done even though the child's isn't.
  if (!batch && d?.backgrounded) {
    let out = theme.fg("warning", `backgrounded${d.agent ? ` (${d.agent})` : ""}`);
    const summary = firstNonEmptyLine(text);
    if (summary) out += theme.fg("dim", ` — ${truncateLine(summary, 100)}`);
    return out;
  }
  const bgCount = typeof d?.backgrounded === "number" ? d.backgrounded : 0;
  const label = opts.isError
    ? `failed${d?.agent ? ` (${d.agent})` : ""}`
    : batch
      ? `done (${d.count} subagents${bgCount ? `, ${bgCount} backgrounded` : ""})`
      : `done${d?.agent ? ` (${d.agent})` : ""}`;
  let out = theme.fg(opts.isError ? "error" : "success", label);
  const summary = firstNonEmptyLine(text);
  if (!batch && summary && summary !== "(no output)") {
    out += theme.fg("dim", ` — ${truncateLine(summary, 100)}`);
  }
  if (opts.expanded) {
    const lines = text.split("\n");
    const shown = lines.slice(0, RESULT_PREVIEW_LINES);
    out += `\n${shown.map((l) => theme.fg("dim", l)).join("\n")}`;
    const remaining = lines.length - shown.length;
    if (remaining > 0) out += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
  }
  return out;
}

/** Reuse the prior render component when available (pi renderer idiom). */
function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

const taskField = Type.String({ description: "The task to delegate, with full context" });
const modelField = Type.Optional(Type.String({ description: "Model override (provider/id)" }));
const backgroundField = Type.Optional(
  Type.Boolean({
    description:
      "Run in the background: return immediately with a task id; the result arrives later in a follow-up message (long runs also background automatically).",
  }),
);
const taskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Named agent from the available list" })),
  agent_md: Type.Optional(
    Type.String({
      description:
        "Inline agent definition: markdown with optional frontmatter (name, description, tools, model, thinking) followed by the system prompt. Takes precedence over the generic default. Provide either agent or agent_md, not both.",
    }),
  ),
  task: taskField,
  model: modelField,
  background: backgroundField,
});

const AGENTS_DIR = join(homedir(), ".pi/agent/agents");

export function registerSubagentTools(
  pi: ExtensionAPI,
  agentsDir: string = AGENTS_DIR,
  spawnFn: SpawnFn = defaultSpawn,
  preloadedAgents?: AgentDef[],
  registry?: BackgroundRegistry,
): void {
  const agents = preloadedAgents ?? loadAgents(agentsDir);
  // The description's agent list is fixed at registration, but execute
  // re-reads the directory so edited agent files take effect without
  // reloading the extension.
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
The subagent runs to completion and returns its final response. Use for reviews, research, and any work that benefits from an isolated context.
Subagents still running after ~2 minutes (PI_SUBAGENT_BG_AFTER_MS) move to the background: the tool returns immediately and a follow-up message delivers the result. Pass background: true for known-long work; don't wait or poll — the result comes to you.`,
    promptSnippet: "Delegate a task to a focused subagent (isolated pi session)",
    promptGuidelines: [
      "Use subagent for self-contained work (reviews, research, audits); the subagent only sees the task text you pass, so include all needed context.",
      "For a bespoke specialist, pass agent_md with the exact instructions and tool restrictions instead of forcing a named agent to fit.",
      "Long subagent runs background automatically and their results arrive in follow-up messages — continue other work instead of waiting or polling.",
    ],
    parameters: taskItem,
    renderCall(args, theme, context) {
      // Arguments stream in partially; guard until `task` arrives.
      const task = typeof args?.task === "string" ? args.task : "";
      const text = reuseText(context);
      text.setText(renderSubagentCall(refLabel(args ?? {}), task, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      // On errors pi replaces details with {}; fall back to the call arguments
      // so the agent name survives every path.
      const d = result.details as { agent?: string; backgrounded?: boolean } | undefined;
      const info = { agent: d?.agent ?? refLabel(context?.args ?? {}), backgrounded: d?.backgrounded };
      const text = reuseText(context);
      text.setText(
        renderSubagentResult(
          extractAssistantText(result.content),
          info,
          {
            isPartial: options.isPartial,
            expanded: options.expanded,
            isError: context?.isError ?? false,
          },
          theme,
        ),
      );
      return text;
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const list = loadAgents(agentsDir);
      const agent = resolveAgentDef(list, params);
      // Adoption is wired only when a registry is present; without one the
      // tool waits synchronously exactly as before.
      const options: RunChildOptions = { timeoutMs: parseTimeoutMs(process.env), onUpdate, signal };
      if (registry) {
        options.adoptAfterMs = params.background ? 0 : parseBgAfterMs(process.env);
        options.onAdopted = (handle: AdoptedHandle<ChildRun>) =>
          adoptSubagentTask(registry, agent.name, handle, ctx?.sessionManager?.getSessionDir());
      }
      const run = await runChild(agent, params.task, params.model, options, spawnFn);
      if ("adopted" in run) {
        return {
          content: [{ type: "text", text: backgroundedNotice(agent.name, run.id) }],
          details: { agent: agent.name, backgrounded: true, id: run.id },
        };
      }
      return {
        content: [{ type: "text", text: run.text }],
        details: { agent: agent.name },
        ...(run.usage ? { usage: run.usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: `Run multiple subagents in parallel. Each task gets an isolated pi session.
Available agents:
${agentList}
Each task may instead include agent_md (an inline agent definition) or omit both to use the generic read-only investigator.
Slow tasks background individually after ~2 minutes (PI_SUBAGENT_BG_AFTER_MS); each such result then arrives in its own follow-up message. Pass background: true per task for known-long work.`,
    parameters: Type.Object({
      tasks: Type.Array(taskItem, { minItems: 1, description: "Tasks to run in parallel" }),
    }),
    renderCall(args, theme, context) {
      // Arguments stream in partially; guard until `tasks` is a complete array.
      const names = Array.isArray(args?.tasks) ? args.tasks.map((t) => refLabel(t ?? {})) : [];
      const text = reuseText(context);
      text.setText(renderSubagentsCall(names, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      // Prefer the result's count; fall back to complete call arguments when
      // pi replaced the details (error path).
      const d = result.details as { count?: number; backgrounded?: number } | undefined;
      const tasks = Array.isArray(context?.args?.tasks) ? context.args.tasks : [];
      const info = { count: d?.count ?? (tasks.length || undefined), backgrounded: d?.backgrounded };
      const text = reuseText(context);
      text.setText(
        renderSubagentResult(
          extractAssistantText(result.content),
          info,
          {
            isPartial: options.isPartial,
            expanded: options.expanded,
            isError: context?.isError ?? false,
          },
          theme,
        ),
      );
      return text;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const list = loadAgents(agentsDir);
      const timeoutMs = parseTimeoutMs(process.env);
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      const results = await runWithLimit(
        params.tasks.map((t) => () => {
          const agent = resolveAgentDef(list, t);
          const options: RunChildOptions = { timeoutMs, signal };
          if (registry) {
            options.adoptAfterMs = t.background ? 0 : parseBgAfterMs(process.env);
            options.onAdopted = (handle: AdoptedHandle<ChildRun>) =>
              adoptSubagentTask(registry, agent.name, handle, sessionDir);
          }
          return runChild(agent, t.task, t.model, options, spawnFn);
        }),
        parseConcurrency(process.env),
      );
      const sections = results.map((r, i) => {
        const label = refLabel(params.tasks[i]);
        const body =
          r.status === "rejected"
            ? `ERROR: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
            : "adopted" in r.value
              ? `Still running — backgrounded as ${r.value.id}; the result will arrive in a follow-up message.`
              : r.value.text;
        return `### ${label}\n${body}`;
      });
      // Failed children still spent tokens — recover the spend attached by
      // runChild's rejection instead of dropping it from the batch total.
      // Adopted children's usage rides in their wake messages instead: the
      // inline total covers only what finished here.
      const usage = sumUsages(
        results.map((r) =>
          r.status === "fulfilled"
            ? "adopted" in r.value
              ? undefined
              : r.value.usage
            : (r.reason as { usage?: ChildUsage })?.usage,
        ),
      );
      const backgroundedCount = results.filter((r) => r.status === "fulfilled" && "adopted" in r.value).length;
      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: { count: params.tasks.length, ...(backgroundedCount ? { backgrounded: backgroundedCount } : {}) },
        ...(usage ? { usage } : {}),
      };
    },
  });
}

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

/** Register the extension against pi. Extracted from the default export so
 * tests can drive the full wiring — registry, tools, commands, lifecycle —
 * with a fake pi and injected spawn. */
export function registerSubagentsExtension(
  pi: ExtensionAPI,
  opts: { agentsDir?: string; spawnFn?: SpawnFn; bgSpawnFn?: BashSpawnFn } = {},
): void {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const agents = loadAgents(agentsDir);
  // UI channels arrive with the first event context; the wake channel is pi itself.
  let ui: ExtensionContext["ui"] | undefined;
  const registry = createBackgroundRegistry({
    sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
    notify: (message, level) => ui?.notify(message, level),
    setStatus: (key, text) => ui?.setStatus(key, text),
    wakeEnabled: parseWakeEnabled(process.env),
  });
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });
  pi.on("session_shutdown", (event) => {
    // Every shutdown reason converges here — quit, reload, and session
    // replacement (new/resume/fork): the registry and its children belong to
    // the runtime being torn down, and an orphaned subagent burns tokens with
    // nobody consuming the result. Replacement kills break the promised wake,
    // so they say so; quit and reload need no explanation.
    const killed = registry.killAll();
    if (killed > 0 && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
      ui?.notify(
        `Background tasks killed (${event.reason}): killed ${killed}, their results will not arrive.`,
        "warning",
      );
    }
  });
  registerSubagentTools(pi, agentsDir, opts.spawnFn ?? defaultSpawn, agents, registry);
  // bg shares the registry: one footer count, one shutdown kill, the same wake channel.
  pi.registerTool(createBgTool(registry, { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, spawnFn: opts.bgSpawnFn }));
  // Per-task control, agent side: kill by id; the terminal sees it happen.
  pi.registerTool(
    createKillTaskTool(registry, { onKilled: (id) => ui?.notify(`Background task killed: ${id}`, "warning") }),
  );
  // Per-task control, user side: /tasks lists, /tasks <id> kills.
  pi.registerCommand("tasks", createTasksCommand(registry));
  registerCommandsForAgents(pi, agents);
}

export default function (pi: ExtensionAPI) {
  registerSubagentsExtension(pi);
}
