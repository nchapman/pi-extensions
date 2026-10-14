/** Entries → sections → chunks: identifier-aware tokenization, section
 * extraction from raw session entries, line-aligned chunking, and the archive
 * definition itself — branch entries the session projection no longer shows. */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { chunkKey } from "../../lib/vecstore";
import type { RecallConfig } from "./config";

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Split identifiers before tokenizing so `parseHeader`, `parse_header`, and
 * "parse header" all produce the same terms. Splits camelCase boundaries,
 * digit boundaries, and collapses runs of non-alphanumerics.
 */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return spaced.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Entry → sections (one entry may yield several content sections)
// ---------------------------------------------------------------------------

export type RecallKind =
  "user" | "assistant" | "thinking" | "toolCall" | "toolResult" | "bash" | "summary" | "branchSummary" | "custom";

export interface EntrySection {
  kind: RecallKind;
  /** Tool name for toolCall/toolResult sections; customType for custom. */
  label?: string;
  text: string;
}

export function kindLabel(kind: RecallKind, label?: string): string {
  switch (kind) {
    case "user":
      return "user message";
    case "assistant":
      return "assistant";
    case "thinking":
      return "assistant thinking";
    case "toolCall":
      return `tool call${label ? ` (${label})` : ""}`;
    case "toolResult":
      return `tool result${label ? ` (${label})` : ""}`;
    case "bash":
      return "bash execution";
    case "summary":
      return "compaction summary (digest of earlier turns)";
    case "branchSummary":
      return "branch summary (digest of an abandoned branch)";
    case "custom":
      return `injected context${label ? ` (${label})` : ""}`;
  }
}

/** Deterministic JSON with sorted keys so equivalent args tokenize stably. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Extract indexable text sections from a raw session entry. System messages
 * (prompt boilerplate), usage/model-change metadata, redacted thinking, and
 * plain state entries are skipped — only content a reader would want back.
 */
export function extractEntrySections(entry: SessionEntry): EntrySection[] {
  switch (entry.type) {
    case "message": {
      const msg = (entry as { message?: { role?: string } }).message;
      if (!msg || typeof msg !== "object") return [];
      const m = msg as Record<string, unknown>;
      switch (m.role) {
        case "user": {
          const sections: EntrySection[] = [{ kind: "user", text: textOfBlocks(m.content) }];
          return sections.filter((sec) => sec.text !== "");
        }
        case "assistant": {
          const sections: EntrySection[] = [];
          for (const block of (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>) {
            if (block?.type === "text" && typeof block.text === "string" && block.text !== "") {
              sections.push({ kind: "assistant", text: block.text });
            } else if (
              block?.type === "thinking" &&
              typeof block.thinking === "string" &&
              block.thinking !== "" &&
              !block.redacted
            ) {
              sections.push({ kind: "thinking", text: block.thinking });
            } else if (block?.type === "toolCall" && typeof block.name === "string") {
              sections.push({
                kind: "toolCall",
                label: block.name,
                text: `${block.name}(${stableStringify(block.arguments)})`,
              });
            }
          }
          return sections;
        }
        case "toolResult": {
          const text = textOfBlocks(m.content);
          if (text === "") return [];
          const sections: EntrySection[] = [
            { kind: "toolResult", label: typeof m.toolName === "string" ? m.toolName : undefined, text },
          ];
          return sections;
        }
        case "bashExecution": {
          const command = typeof m.command === "string" ? m.command : "";
          const output = typeof m.output === "string" ? m.output : "";
          const full = typeof m.fullOutputPath === "string" ? `\n(full output at ${m.fullOutputPath})` : "";
          const sections: EntrySection[] = [{ kind: "bash", text: `$ ${command}\n${output}${full}` }];
          return sections.filter((sec) => sec.text.trim() !== "$");
        }
        case "custom": {
          const text = textOfBlocks(m.content);
          if (text === "") return [];
          const sections: EntrySection[] = [
            { kind: "custom", label: typeof m.customType === "string" ? m.customType : undefined, text },
          ];
          return sections;
        }
        default:
          return []; // system, summary-role projections, unknown roles
      }
    }
    case "compaction": {
      const e = entry as { summary?: unknown; details?: unknown };
      let text = typeof e.summary === "string" ? e.summary : "";
      const files = e.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
      const lines: string[] = [];
      if (Array.isArray(files?.readFiles) && files.readFiles.length > 0)
        lines.push(`read: ${files.readFiles.join(", ")}`);
      if (Array.isArray(files?.modifiedFiles) && files.modifiedFiles.length > 0)
        lines.push(`modified: ${files.modifiedFiles.join(", ")}`);
      if (lines.length > 0) text += `\n${lines.join("\n")}`;
      return text === "" ? [] : [{ kind: "summary", text }];
    }
    case "branch_summary": {
      const text = (entry as { summary?: unknown }).summary;
      return typeof text === "string" && text !== "" ? [{ kind: "branchSummary", text }] : [];
    }
    case "custom_message": {
      const text = textOfBlocks((entry as { content?: unknown }).content);
      if (text === "") return [];
      return [{ kind: "custom", label: (entry as { customType?: unknown }).customType as string | undefined, text }];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface TextChunk {
  text: string;
  charOffset: number;
}

/**
 * Split text into chunks of at most `maxChars`, preferring line boundaries.
 * Long unbroken lines are hard-split. Offsets index into the original text.
 */
export function chunkText(text: string, maxChars: number): TextChunk[] {
  if (text.length <= maxChars) return text === "" ? [] : [{ text, charOffset: 0 }];
  const chunks: TextChunk[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text.length - offset <= maxChars) {
      chunks.push({ text: text.slice(offset), charOffset: offset });
      break;
    }
    const window = text.slice(offset, offset + maxChars);
    const lastNewline = window.lastIndexOf("\n");
    const cut = lastNewline > maxChars * 0.5 ? offset + lastNewline + 1 : offset + maxChars;
    chunks.push({ text: text.slice(offset, cut), charOffset: offset });
    offset = cut;
  }
  return chunks;
}

/** A single indexable unit: one chunk of one section of one entry. */
export interface RecallChunk {
  ref: string; // stable read reference (entryId, or entryId.sess for foreign)
  entryId: string;
  /** Content hash identity — the semantic cache key, stable across sessions that parse the same entry. */
  key: string;
  origin: "current" | "foreign";
  sessionLabel: string; // "current session" or "past session <name> <date>"
  kind: RecallKind;
  label?: string;
  timestamp: string;
  text: string;
}

function makeRef(entryId: string, origin: "current" | "foreign", sessionId: string): string {
  if (origin === "current") return entryId;
  return `${entryId}.${sessionId.slice(0, 4)}`;
}

/** Parse a ref back into its locating parts; undefined when malformed. */
export function parseRef(ref: string): { entryId: string; sessionIdShort?: string } | undefined {
  const idx = ref.indexOf(".");
  // Entry ids are hex (possibly full UUID fallbacks) and never contain dots.
  const parts = idx === -1 ? [ref] : [ref.slice(0, idx), ref.slice(idx + 1)];
  if (parts[0] === "" || /[^0-9a-f-]/i.test(parts[0])) return undefined;
  if (parts.length === 2 && (parts[1] === "" || /[^0-9a-f-]/i.test(parts[1]))) return undefined;
  return { entryId: parts[0], sessionIdShort: parts[1] };
}

/** Chunk every indexable section of one entry, keyed by content hash. */
export function chunksFromEntry(
  entry: SessionEntry,
  meta: { origin: "current" | "foreign"; sessionId: string; sessionLabel: string },
  chunkChars: number,
): RecallChunk[] {
  const chunks: RecallChunk[] = [];
  for (const [sectionIdx, section] of extractEntrySections(entry).entries()) {
    for (const [chunkIdx, piece] of chunkText(section.text, chunkChars).entries()) {
      chunks.push({
        ref: makeRef(entry.id, meta.origin, meta.sessionId),
        entryId: entry.id,
        key: chunkKey(meta.sessionId, entry.id, sectionIdx, chunkIdx, piece.text),
        origin: meta.origin,
        sessionLabel: meta.sessionLabel,
        kind: section.kind,
        label: section.label,
        timestamp: entry.timestamp,
        text: piece.text,
      });
    }
  }
  return chunks;
}

/**
 * The searchable archive of the current session: branch entries that are NOT
 * visible to the model. Visibility comes from the session projection
 * (compaction-aware AND context-edit-aware: omitted entries project no
 * messages), so this is exact — archived summaries drop in here the moment a
 * later compaction folds them away, and edit-omitted entries stay searchable.
 */
export function buildArchiveChunks(
  branch: SessionEntry[],
  visibleEntryIds: Set<string>,
  sessionId: string,
  config: Pick<RecallConfig, "chunkChars">,
): RecallChunk[] {
  const inContext = visibleEntryIds;
  const chunks: RecallChunk[] = [];
  for (const entry of branch) {
    if (inContext.has(entry.id)) continue;
    chunks.push(
      ...chunksFromEntry(entry, { origin: "current", sessionId, sessionLabel: "current session" }, config.chunkChars),
    );
  }
  return chunks;
}

/**
 * Entry ids the model can currently see: projection entries that still
 * contribute messages (non-empty = not omitted by compaction or context edit).
 */
export function visibleEntryIds(projection: {
  entries: Array<{ sourceEntry: SessionEntry; messages: unknown[] }>;
}): Set<string> {
  const ids = new Set<string>();
  for (const projected of projection.entries) {
    if (projected.messages.length > 0) ids.add(projected.sourceEntry.id);
  }
  return ids;
}
