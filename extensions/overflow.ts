/**
 * Overflow extension — cap oversized tool results so one call can't flood the window.
 *
 * Design (adapted from context-mode's core insight, without its infra):
 * - pi truncates its built-in tools (read/grep/bash cap at ~50 KB), but MCP and
 *   other custom tool results flow into context uncapped — a single Playwright
 *   snapshot or log dump can cost tens of KB that compaction later compresses
 *   away entirely
 * - a tool_result handler replaces content over PI_OVERFLOW_MAX_CHARS (default
 *   10,000, floor 1,000, 0 disables) with head + tail + a pointer: the full
 *   output is stashed beside the session at <sessionDir>/overflow/<callId>.txt,
 *   so it survives compaction and resume — recall never sees it (it searches
 *   session files), the pointer says to read or grep the file instead
 * - field-merge semantics: only content is replaced; details, isError, and
 *   usage pass through untouched, and image parts ride along uncapped
 * - fail-open everywhere: built-in tools, missing session dir, or a failed
 *   stash write all leave the original result alone — the cap must never
 *   discard output without a recoverable pointer
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_CHARS = 10_000;
export const MIN_MAX_CHARS = 1_000;
const ENV_VAR = "PI_OVERFLOW_MAX_CHARS";

/**
 * pi's built-in tool names — they truncate their own output, so capping them
 * would only fight their existing behavior. Mirrors the ToolResultEvent union;
 * unknown future built-ins simply get capped too (harmless: head + tail +
 * pointer). Keep in sync when pi adds tools.
 */
export const BUILT_IN_TOOLS: readonly string[] = ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"];

/** Minimal content-part shape: text parts carry `text`, images pass through. */
type ContentPart = { type: string; text?: unknown };

export function maxCharsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[ENV_VAR]?.trim();
  if (!raw) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_CHARS;
  return n === 0 ? 0 : Math.max(MIN_MAX_CHARS, Math.floor(n));
}

export function isBuiltInTool(name: string): boolean {
  return BUILT_IN_TOOLS.includes(name);
}

/** Total chars across text parts; images contribute nothing to the measure. */
export function textLength(parts: ContentPart[]): number {
  return parts.reduce((n, p) => (p.type === "text" && typeof p.text === "string" ? n + p.text.length : n), 0);
}

/**
 * Split a too-long result into a head and a tail that together fit the budget
 * (80/20 — the head usually carries structure, the tail the final state), cut
 * at a line boundary when one sits in the outer half of each cut region, raw
 * otherwise. `omitted` is what sits between them. Precondition: the caller
 * only invokes this for text longer than `budget` (and `budget >= 5`, so the
 * 80/20 split never overflows — the env floor of 1,000 guarantees both).
 */
export function splitHeadTail(text: string, budget: number): { head: string; tail: string; omitted: number } {
  const headBudget = Math.ceil(budget * 0.8);
  const tailBudget = Math.max(1, Math.floor(budget * 0.2));
  const headRaw = text.slice(0, headBudget);
  const headNl = headRaw.lastIndexOf("\n");
  const head = headNl >= headBudget / 2 ? headRaw.slice(0, headNl + 1) : headRaw;
  const tailRaw = text.slice(Math.max(head.length, text.length - tailBudget));
  const tailNl = tailRaw.indexOf("\n");
  const tail = tailNl !== -1 && tailNl < tailBudget / 2 ? tailRaw.slice(tailNl + 1) : tailRaw;
  return { head, tail, omitted: text.length - head.length - tail.length };
}

/** The replacement text: banner with counts and the recovery path, then head and tail. */
export function renderCappedResult(parts: {
  head: string;
  tail: string;
  omitted: number;
  originalChars: number;
  limit: number;
  filePath: string;
}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return [
    `[overflow] ${fmt(parts.originalChars)}-char tool result capped to ${fmt(parts.head.length + parts.tail.length)} shown chars ` +
      `(limit ${fmt(parts.limit)}); ${fmt(parts.omitted)} chars omitted.`,
    `Full output: ${parts.filePath}`,
    "Recover it with the read tool (offset/limit) or grep the file — the recall tool does not search it.",
    "",
    parts.head,
    `[… ${fmt(parts.omitted)} chars omitted — full output in the file above …]`,
    parts.tail,
  ].join("\n");
}

/** Stash file for one capped call, next to the session so it survives resume. */
export function stashPath(sessionDir: string, toolCallId: string): string {
  const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return join(sessionDir, "overflow", `${safeId}.txt`);
}

export function registerOverflow(pi: ExtensionAPI): void {
  const maxChars = maxCharsFromEnv(process.env);
  if (maxChars <= 0) return;

  pi.on("tool_result", (event, ctx) => {
    try {
      if (isBuiltInTool(event.toolName)) return;
      const parts = event.content as ContentPart[];
      if (textLength(parts) <= maxChars) return;
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      if (!sessionDir) return; // nowhere to stash — never discard without a pointer

      const textParts = parts.filter((p) => p.type === "text" && typeof p.text === "string");
      const images = event.content.filter((p) => p.type === "image");
      // Anything pi's types don't cover (e.g. a text part with a non-string
      // payload) passes through untouched — capping never discards silently.
      const passthrough = event.content.filter(
        (p) => p.type !== "image" && !(p.type === "text" && typeof p.text === "string"),
      );
      const full = textParts.map((p) => p.text as string).join("\n");
      const filePath = stashPath(sessionDir, event.toolCallId);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, full);

      const { head, tail, omitted } = splitHeadTail(full, maxChars);
      const text = renderCappedResult({
        head,
        tail,
        omitted,
        originalChars: full.length,
        limit: maxChars,
        filePath,
      });
      const content: ToolResultEvent["content"] = [{ type: "text", text }, ...images, ...passthrough];
      return { content };
    } catch {
      return; // a failed cap must never break the tool result
    }
  });
}
