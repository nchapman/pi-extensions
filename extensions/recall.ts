/**
 * Recall extension — lossless search over compacted-away session history.
 *
 * Design:
 * - One `recall` tool. Compaction summarizes old turns but pi keeps every raw
 *   entry in the session file forever; this tool makes that archive searchable
 *   again. The archive is defined precisely: `getBranch()` (leaf→root, all raw
 *   entries) minus the ids the session projection still shows (compaction- and
 *   context-edit-aware) — so archived summaries drop in the moment a later
 *   compaction folds them away, and edit-omitted entries stay searchable, all
 *   from one set-diff with zero bookkeeping.
 * - Ranking is hand-rolled BM25 over line-aligned chunks (~3k chars) with
 *   identifier-aware tokenization (`parseHeader` matches "parse header"),
 *   multiplied by a memory-horizon recency decay (score halves every
 *   `PI_RECALL_HALF_LIFE_HOURS` measured from the archive frontier, floored
 *   at `PI_RECALL_RECENCY_FLOOR`) — so the latest decision about a topic
 *   outranks older discussions of it, while rare distinctive terms from far
 *   back still surface. Lexical match is deliberate: recall returns verbatim
 *   text, the regime where models are strongest (NoLiMa), and every hit
 *   carries provenance.
 * - Scope `session` (default) indexes the in-memory branch on demand — always
 *   fresh, branch/rewind-correct, nothing persisted. Scope `project` adds
 *   sibling session files from the cwd-scoped session directory, labeled and
 *   down-ranked (`PI_RECALL_FOREIGN_WEIGHT`), never injected — retrieval is
 *   always model-initiated, so cross-session context can't leak in ambiently.
 * - Cache invariants hold by construction: a plain tool whose results ride at
 *   the tail; no context rewrites, no system-prompt churn, one promptSnippet.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";

export const RECALL_TOOL_NAME = "recall";

// ---------------------------------------------------------------------------
// Config (env with safe defaults; invalid values fall back and warn)
// ---------------------------------------------------------------------------

export interface RecallConfig {
	defaultScope: "session" | "project";
	foreignWeight: number;
	/** Memory horizon: age (from the archive frontier) at which a chunk's score has halved. */
	halfLifeHours: number;
	/** Minimum recency factor so old content fades but never vanishes (1 disables decay). */
	recencyFloor: number;
	chunkChars: number;
	snippetChars: number;
	maxResults: number;
	readChars: number;
	projectMaxBytes: number;
}

const DEFAULTS: RecallConfig = {
	defaultScope: "session",
	foreignWeight: 0.5,
	halfLifeHours: 4,
	recencyFloor: 0.25,
	chunkChars: 3000,
	snippetChars: 400,
	maxResults: 5,
	readChars: 4000,
	projectMaxBytes: 64 * 1024 * 1024,
};

function numFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const v = Number(raw);
	if (!Number.isFinite(v)) {
		console.error(`recall: ${name}=${raw} is not a number — using ${fallback}`);
		return fallback;
	}
	return Math.min(max, Math.max(min, v));
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RecallConfig {
	const scope = env.PI_RECALL_SCOPE?.trim().toLowerCase();
	if (scope !== undefined && scope !== "" && scope !== "session" && scope !== "project") {
		console.error(`recall: PI_RECALL_SCOPE=${scope} is invalid (session|project) — using session`);
	}
	return {
		defaultScope: scope === "project" ? "project" : DEFAULTS.defaultScope,
		foreignWeight: numFromEnv(env, "PI_RECALL_FOREIGN_WEIGHT", DEFAULTS.foreignWeight, 0, 1),
		halfLifeHours: numFromEnv(env, "PI_RECALL_HALF_LIFE_HOURS", DEFAULTS.halfLifeHours, 0.1, 1_000_000),
		recencyFloor: numFromEnv(env, "PI_RECALL_RECENCY_FLOOR", DEFAULTS.recencyFloor, 0, 1),
		chunkChars: Math.floor(numFromEnv(env, "PI_RECALL_CHUNK_CHARS", DEFAULTS.chunkChars, 500, 100_000)),
		snippetChars: Math.floor(numFromEnv(env, "PI_RECALL_SNIPPET_CHARS", DEFAULTS.snippetChars, 100, 10_000)),
		maxResults: Math.floor(numFromEnv(env, "PI_RECALL_MAX_RESULTS", DEFAULTS.maxResults, 1, 25)),
		readChars: Math.floor(numFromEnv(env, "PI_RECALL_READ_CHARS", DEFAULTS.readChars, 500, 100_000)),
		projectMaxBytes: Math.floor(numFromEnv(env, "PI_RECALL_PROJECT_MAX_MB", 64, 4, 4096) * 1024 * 1024),
	};
}

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
	| "user"
	| "assistant"
	| "thinking"
	| "toolCall"
	| "toolResult"
	| "bash"
	| "summary"
	| "branchSummary"
	| "custom";

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
						} else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "" && !block.redacted) {
							sections.push({ kind: "thinking", text: block.thinking });
						} else if (block?.type === "toolCall" && typeof block.name === "string") {
							sections.push({ kind: "toolCall", label: block.name, text: `${block.name}(${stableStringify(block.arguments)})` });
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
			if (Array.isArray(files?.readFiles) && files.readFiles.length > 0) lines.push(`read: ${files.readFiles.join(", ")}`);
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
	origin: "current" | "foreign";
	sessionId: string; // current session id, or the foreign session's id
	sessionLabel: string; // "current session" or "past session <name> <date>"
	file?: string; // session file path for foreign chunks
	line?: number; // 1-based line of the entry in its file (foreign reads)
	kind: RecallKind;
	label?: string;
	timestamp: string;
	text: string;
	charOffset: number;
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

/** Chunk every indexable section of one entry. */
export function chunksFromEntry(
	entry: SessionEntry,
	meta: { origin: "current" | "foreign"; sessionId: string; sessionLabel: string; file?: string; line?: number },
	chunkChars: number,
): RecallChunk[] {
	const chunks: RecallChunk[] = [];
	for (const section of extractEntrySections(entry)) {
		for (const piece of chunkText(section.text, chunkChars)) {
			chunks.push({
				ref: makeRef(entry.id, meta.origin, meta.sessionId),
				entryId: entry.id,
				origin: meta.origin,
				sessionId: meta.sessionId,
				sessionLabel: meta.sessionLabel,
				file: meta.file,
				line: meta.line,
				kind: section.kind,
				label: section.label,
				timestamp: entry.timestamp,
				text: piece.text,
				charOffset: piece.charOffset,
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
		chunks.push(...chunksFromEntry(entry, { origin: "current", sessionId, sessionLabel: "current session" }, config.chunkChars));
	}
	return chunks;
}

/**
 * Entry ids the model can currently see: projection entries that still
 * contribute messages (non-empty = not omitted by compaction or context edit).
 */
export function visibleEntryIds(projection: { entries: Array<{ sourceEntry: SessionEntry; messages: unknown[] }> }): Set<string> {
	const ids = new Set<string>();
	for (const projected of projection.entries) {
		if (projected.messages.length > 0) ids.add(projected.sourceEntry.id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface ScoredChunk {
	chunk: RecallChunk;
	score: number; // weighted, decayed, descending sort key
	rawScore: number; // unweighted BM25
	recencyFactor: number; // 1 at the frontier, halving per half-life, floored
}

interface ChunkTerms {
	tf: Map<string, number>;
	length: number;
}

function indexChunks(chunks: RecallChunk[]): { terms: ChunkTerms[]; df: Map<string, number>; avgLength: number } {
	const terms: ChunkTerms[] = [];
	const df = new Map<string, number>();
	let total = 0;
	for (const chunk of chunks) {
		const tokens = tokenize(chunk.text);
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
		terms.push({ tf, length: tokens.length });
		total += tokens.length;
	}
	return { terms, df, avgLength: chunks.length === 0 ? 0 : total / chunks.length };
}

/**
 * Rank chunks against a query with BM25, then apply the session weight
 * (current = 1.0, foreign = config.foreignWeight) and a memory-horizon
 * recency decay: score × 0.5^(age / halfLife), floored. Age is measured from
 * the archive frontier (newest chunk in the corpus), NOT wall clock — so
 * ordering stays correct across pauses and ranking stays deterministic for
 * repeated queries. Chunks matching no query term are dropped. Ties break
 * toward newer entries, then by ref for stability.
 */
export function rankChunks(
	chunks: RecallChunk[],
	query: string,
	foreignWeight: number,
	halfLifeHours: number = DEFAULTS.halfLifeHours,
	recencyFloor: number = DEFAULTS.recencyFloor,
): ScoredChunk[] {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0 || chunks.length === 0) return [];
	const frontier = Math.max(...chunks.map((c) => tsMs(c.timestamp)));
	const halfLifeMs = halfLifeHours * 3_600_000;
	const { terms, df, avgLength } = indexChunks(chunks);
	const N = chunks.length;
	const results: ScoredChunk[] = [];
	for (let i = 0; i < N; i++) {
		const { tf, length } = terms[i];
		if (length === 0) continue;
		let score = 0;
		let matched = false;
		for (const t of queryTokens) {
			const f = tf.get(t);
			if (!f) continue;
			matched = true;
			const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
			score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength));
		}
		if (!matched) continue;
		const chunk = chunks[i];
		const weight = chunk.origin === "current" ? 1 : foreignWeight;
		const recency = recencyFactor(frontier - tsMs(chunk.timestamp), halfLifeMs, recencyFloor);
		results.push({ chunk, score: score * weight * recency, rawScore: score, recencyFactor: recency });
	}
	results.sort(
		(a, b) => b.score - a.score || b.chunk.timestamp.localeCompare(a.chunk.timestamp) || a.chunk.ref.localeCompare(b.chunk.ref),
	);
	return results;
}

/** Parse an ISO timestamp to epoch ms; malformed or missing → -Infinity (treated as oldest). */
function tsMs(timestamp: string): number {
	const ms = Date.parse(timestamp);
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Exponential memory decay: 1 at the frontier, halving per half-life, never below the floor. */
export function recencyFactor(ageMs: number, halfLifeMs: number, floor: number): number {
	if (!Number.isFinite(ageMs) || ageMs <= 0) return ageMs === 0 ? 1 : floor;
	return Math.max(floor, 0.5 ** (ageMs / halfLifeMs));
}

// ---------------------------------------------------------------------------
// Snippets & formatting (model-facing content)
// ---------------------------------------------------------------------------

/**
 * A window of `maxChars` around the first occurrence of any query token,
 * preferring token-boundary matches so "parse" does not hit "sparse".
 */
export function extractSnippet(text: string, query: string, maxChars: number): string {
	const queryTokens = [...new Set(tokenize(query))].sort((a, b) => b.length - a.length);
	const lower = text.toLowerCase();
	let at = -1;
	for (const t of queryTokens) {
		// Word-boundary match only, so "parse" does not window on "sparse".
		for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
			const before = i === 0 ? " " : lower[i - 1];
			const after = i + t.length >= lower.length ? " " : lower[i + t.length];
			if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
			if (at === -1 || i < at) at = i;
			break;
		}
	}
	let start = 0;
	let end = Math.min(text.length, maxChars);
	if (at !== -1) {
		start = Math.max(0, at - Math.floor(maxChars / 3));
		end = Math.min(text.length, start + maxChars);
		start = Math.max(0, end - maxChars);
	}
	let snippet = text.slice(start, end).replace(/\n{3,}/g, "\n\n").trim();
	if (snippet === "") snippet = "(empty)";
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${snippet}${suffix}`;
}

function shortDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ");
}

export interface SearchHit {
	ref: string;
	kind: RecallKind;
	label?: string;
	sessionLabel: string;
	timestamp: string;
	score: number;
	/** Recency multiplier already folded into score; surfaced so ranking is explainable. */
	recencyFactor?: number;
	snippet: string;
}

export function formatSearchResult(
	hits: SearchHit[],
	meta: {
		archiveEntries: number;
		foreignSessions: number;
		scope: "session" | "project";
		skippedFiles?: number;
		totalMatches?: number;
	},
): string {
	const lines: string[] = [];
	if (hits.length === 0) {
		const where =
			meta.scope === "project"
				? `this session's compacted history plus ${meta.foreignSessions} past session${meta.foreignSessions === 1 ? "" : "s"}`
				: "this session's compacted history";
		const advice = meta.scope === "session" ? `, or scope "project" for past sessions in this directory` : "";
		lines.push(`No matches in ${where}. Try broader terms${advice}.`);
	} else {
		lines.push(`Top ${hits.length} match${hits.length === 1 ? "" : "es"} (of ${meta.archiveEntries} archived entries searched):`);
		for (const [i, hit] of hits.entries()) {
			lines.push(
				`${i + 1}. ${hit.sessionLabel} · ${kindLabel(hit.kind, hit.label)} · ${shortDate(hit.timestamp)} · score ${hit.score.toFixed(1)}${
					hit.recencyFactor !== undefined && hit.recencyFactor < 0.95 ? ` (recency ×${hit.recencyFactor.toFixed(2)})` : ""
				}`,
			);
			lines.push(`   ${hit.snippet.split("\n").join("\n   ")}`);
			lines.push(`   full entry: recall { "mode": "read", "id": "${hit.ref}" }`);
		}
	}
	const skipped = meta.skippedFiles ? ` (${meta.skippedFiles} unreadable session file${meta.skippedFiles === 1 ? "" : "s"} skipped)` : "";
	const limited = (meta.totalMatches ?? hits.length) > hits.length ? "results limited; " : "";
	return `${lines.join("\n")}${skipped}\n(${limited}verbatim excerpts — older context may have changed since)`;
}

export function formatReadResult(
	ref: string,
	header: string,
	text: string,
	offset: number,
	maxChars: number,
): string {
	offset = Math.min(Math.max(0, offset), text.length); // offset past end reads empty, not nonsense
	const slice = text.slice(offset, offset + maxChars);
	const end = Math.min(text.length, offset + slice.length);
	const more = end < text.length ? `\n[truncated — continue with { "mode": "read", "id": "${ref}", "offset": ${end} }]` : "";
	return `${header}\n[chars ${offset}-${end} of ${text.length}]\n${slice}${more}`;
}

// ---------------------------------------------------------------------------
// Project corpus (sibling session files)
// ---------------------------------------------------------------------------

export interface ProjectReader {
	listJsonlFiles(dir: string): Promise<string[]>;
	readFile(file: string): Promise<string>;
	stat(file: string): Promise<{ mtimeMs: number; size: number } | undefined>;
}

export const fsProjectReader: ProjectReader = {
	async listJsonlFiles(dir) {
		const names = await fsp.readdir(dir);
		return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
	},
	async readFile(file) {
		return fsp.readFile(file, "utf8");
	},
	async stat(file) {
		try {
			const s = await fsp.stat(file);
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			return undefined;
		}
	},
};

export interface FileCorpus {
	file: string;
	mtimeMs: number;
	size: number;
	sessionId: string;
	label: string;
	chunks: RecallChunk[];
	entryLines: Map<string, number>;
	bytes: number;
}

/** Parse one session file into chunks + per-entry line numbers. */
export function buildFileCorpus(file: string, content: string, chunkChars = 3000, labelMax = 40): FileCorpus | undefined {
	const lines = content.split("\n");
	let sessionId = path.basename(file, ".jsonl");
	let sessionDate = "";
	let name: string | undefined;
	const chunks: RecallChunk[] = [];
	const entryLines = new Map<string, number>();
	let bytes = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // tolerate trailing partial writes
		}
		const entry = parsed as { type?: string; id?: string; timestamp?: string; cwd?: string; name?: string; summary?: string };
		if (entry?.type === "session") {
			if (typeof entry.id === "string" && entry.id !== "") sessionId = entry.id;
			if (typeof entry.timestamp === "string") sessionDate = entry.timestamp.slice(0, 10);
			continue;
		}
		if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name !== "") {
			name = entry.name;
			continue;
		}
		if (typeof entry?.id !== "string" || entry.id === "") continue;
		entryLines.set(entry.id, i + 1);
		const sessionEntry = parsed as SessionEntry;
		const label = `past session ${name ? `"${name.slice(0, labelMax)}" ` : ""}${sessionDate}`;
		for (const chunk of chunksFromEntry(sessionEntry, { origin: "foreign", sessionId, sessionLabel: label, file }, chunkChars)) {
			chunks.push(chunk);
			bytes += chunk.text.length;
		}
	}
	if (entryLines.size === 0) return undefined; // header-only / empty session
	return { file, mtimeMs: 0, size: content.length, sessionId, label: name ?? sessionId, chunks, entryLines, bytes };
}

/**
 * Corpus cache for project scope: per-file, mtime/size-validated, LRU-evicted
 * by a total-bytes cap. Foreign files are indexed wholesale (all branches) —
 * abandoned approaches are history worth finding, and provenance labels keep
 * them distinguishable.
 */
export class ProjectCorpusCache {
	private files = new Map<string, FileCorpus>();
	private bytes = 0;

	constructor(
		private reader: ProjectReader,
		private maxBytes: number,
		private chunkChars = 3000,
	) {}

	list(): FileCorpus[] {
		return [...this.files.values()];
	}

	totalBytes(): number {
		return this.bytes;
	}

	/** Drop a file from the cache (or erase a tombstone). */
	private evict(file: string) {
		const corpus = this.files.get(file);
		if (corpus) {
			this.bytes -= corpus.bytes;
			this.files.delete(file);
		}
	}

	private insert(corpus: FileCorpus) {
		this.evict(corpus.file); // adjusts bytes when replacing a stale build
		this.files.set(corpus.file, corpus); // re-insert = most recently used
		this.bytes += corpus.bytes;
		while (this.bytes > this.maxBytes && this.files.size > 1) {
			const oldest = this.files.keys().next().value;
			if (oldest === undefined) break;
			this.evict(oldest);
		}
	}

	/**
	 * Ensure the cache reflects the session directory: new or changed files
	 * are (re)built, gone files dropped. Returns how many files were
	 * unreadable (skipped).
	 */
	async refresh(dir: string, skipFile: string | undefined): Promise<number> {
		const files = await this.reader.listJsonlFiles(dir);
		const present = new Set(files);
		for (const cached of [...this.files.keys()]) if (!present.has(cached)) this.evict(cached);
		let skipped = 0;
		for (const file of files) {
			if (file === skipFile) continue; // current session is covered in-memory, branch-correct
			const stat = await this.reader.stat(file);
			if (stat === undefined) {
				skipped++;
				this.evict(file);
				continue;
			}
			const cached = this.files.get(file);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				this.insert(cached); // touch LRU without re-reading
				continue;
			}
			try {
				const content = await this.reader.readFile(file);
				const corpus = buildFileCorpus(file, content, this.chunkChars);
				if (corpus === undefined) {
					skipped++;
					this.evict(file);
					continue;
				}
				this.evict(file);
				corpus.mtimeMs = stat.mtimeMs;
				corpus.size = stat.size;
				this.insert(corpus);
			} catch {
				skipped++;
				this.evict(file);
			}
		}
		return skipped;
	}

	/** Locate a foreign entry's raw line for read mode. */
	locate(refSessionShort: string, entryId: string): { corpus: FileCorpus; line: number } | undefined {
		for (const corpus of this.files.values()) {
			if (!corpus.sessionId.startsWith(refSessionShort)) continue;
			const line = corpus.entryLines.get(entryId);
			if (line !== undefined) return { corpus, line };
		}
		return undefined;
	}

	/** Read one entry line from a cached file through the injected reader. */
	async readEntryLine(corpus: FileCorpus, line: number): Promise<string | undefined> {
		const raw = await this.reader.readFile(corpus.file);
		return raw.split("\n")[line - 1];
	}
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const RecallParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Search terms (search mode). Plain words, identifiers, or exact strings like file paths and error messages" })),
	mode: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("read")], { description: '"search" (default) ranks archived chunks; "read" returns one full entry' })),
	scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("project")], { description: '"session" (default): this session\'s compacted history; "project": also past sessions in this directory (labeled, down-ranked)' })),
	id: Type.Optional(Type.String({ description: "Entry ref from a previous recall result (read mode)" })),
	offset: Type.Optional(Type.Number({ description: "Char offset to continue a long read (read mode, default 0)" })),
	limit: Type.Optional(Type.Number({ description: "Max results (search mode, default 5)" })),
});

const REMINDER_TEXT =
	"Compaction summarized earlier history. Those turns are still searchable verbatim with the `recall` tool — use it when you need details from before the summary (decisions, prior attempts, file paths, command outputs).";

function reuseText(context: { lastComponent?: unknown } | undefined): Text {
	return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Collapsed call row: `recall — query…`. */
export function renderRecallCall(args: { query?: unknown; mode?: unknown; id?: unknown }, theme: Pick<Theme, "fg" | "bold">): string {
	if (args?.mode === "read" || (!args?.query && args?.id)) return theme.fg("toolTitle", theme.bold("recall read"));
	const q = typeof args?.query === "string" ? args.query : "";
	return theme.fg("toolTitle", theme.bold("recall ")) + theme.fg("dim", clip(q, 60));
}

/** Result row: `n hits` collapsed; hit lines when expanded. */
export function renderRecallResult(
	details: { hits?: Array<{ snippet: string }>; read?: { total: number } } | undefined,
	options: { expanded: boolean },
	theme: Pick<Theme, "fg">,
): string {
	if (details?.read) return theme.fg("muted", `read · ${details.read.total.toLocaleString()} chars`);
	const hits = details?.hits ?? [];
	if (hits.length === 0) return theme.fg("dim", "no matches");
	let text = theme.fg("muted", `${hits.length} hit${hits.length === 1 ? "" : "s"}`);
	if (options.expanded) {
		const lines = hits.map((h) => `  ${theme.fg("dim", clip(h.snippet.replace(/\s+/g, " "), 88))}`);
		text += `\n${lines.join("\n")}`;
	}
	return text;
}

export interface RecallDetails {
	mode: "search" | "read";
	scope: "session" | "project";
	hits?: Array<{ ref: string; kind: string; session: string; score: number; snippet: string }>;
	read?: { ref: string; total: number };
}

/** Full text of one entry for read mode (all sections, unchunked). */
function entryFullText(entry: SessionEntry): string {
	return extractEntrySections(entry)
		.map((s) => (s.kind === "toolCall" || s.kind === "toolResult" ? `[${kindLabel(s.kind, s.label)}]\n${s.text}` : s.text))
		.join("\n\n");
}

export function registerRecallTool(
	pi: ExtensionAPI,
	config: RecallConfig = configFromEnv(),
	reader: ProjectReader = fsProjectReader,
): void {
	let reminderPending = false;
	const corpusCache = new ProjectCorpusCache(reader, config.projectMaxBytes, config.chunkChars);

	pi.on("session_start", () => {
		reminderPending = false;
	});
	pi.on("session_compact", () => {
		reminderPending = true;
	});
	pi.on("before_agent_start", () => {
		if (!reminderPending) return;
		reminderPending = false;
		return {
			message: {
				customType: "recall.reminder",
				content: REMINDER_TEXT,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: RECALL_TOOL_NAME,
		label: "Recall",
		description:
			"Search conversation history that is no longer in your context (compacted away). Compaction keeps only a summary in context — the verbatim messages remain on disk and this tool retrieves them. Use it when you need earlier details you cannot see: decisions, prior failed attempts, file paths, command outputs, error strings. mode 'search' (default) takes a query and returns ranked verbatim excerpts with provenance; mode 'read' takes an id from a prior result and returns the full entry. scope 'session' (default) searches this session's compacted history; scope 'project' also searches past sessions in this directory (labeled and down-ranked). Prefer recall over re-deriving or guessing at earlier state.",
		promptSnippet: "recall — search compacted-away session history verbatim (scope 'project' adds past sessions)",
		parameters: RecallParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const mode = params.mode ?? "search";
			if (mode === "read") {
				const details = await readEntry(params, ctx, corpusCache, config);
				return { content: [{ type: "text", text: details.text }], details: details.details };
			}
			return search(params, ctx, corpusCache, config);
		},
		renderCall(args, theme, context) {
			const text = reuseText(context);
			text.setText(renderRecallCall((args ?? {}) as { query?: unknown; mode?: unknown; id?: unknown }, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = reuseText(context);
			text.setText(renderRecallResult(result.details as RecallDetails | undefined, { expanded: options.expanded }, theme));
			return text;
		},
	});
}

// ---------------------------------------------------------------------------
// Tool internals (kept out of the registration closure for testability)
// ---------------------------------------------------------------------------

function errorResult(text: string, details: RecallDetails): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
	return { content: [{ type: "text", text: `Error: ${text}` }], details };
}

async function search(
	params: { query?: string; scope?: "session" | "project"; limit?: number },
	ctx: ExtensionContext,
	corpusCache: ProjectCorpusCache,
	config: RecallConfig,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: RecallDetails }> {
	const query = params.query?.trim() ?? "";
	const scope = params.scope ?? config.defaultScope;
	const limit = Math.floor(
		typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.min(25, Math.max(1, params.limit)) : config.maxResults,
	);
	const details: RecallDetails = { mode: "search", scope };
	if (query === "") {
		return errorResult("query is required in search mode (use mode 'read' with an id to fetch a full entry)", details);
	}

	const sm = ctx.sessionManager;
	const archiveChunks = buildArchiveChunks(sm.getBranch(), visibleEntryIds(sm.buildSessionProjection()), sm.getSessionId(), config);
	if (archiveChunks.length === 0 && scope === "session") {
		const text =
			"Nothing has been compacted yet — your full history is still in context, no archive to search. (Scope 'project' searches past sessions.)";
		return { content: [{ type: "text", text }], details };
	}

	let foreignSessions = 0;
	let skippedFiles = 0;
	let allChunks = archiveChunks;
	if (scope === "project") {
		const dir = sm.getSessionDir();
		let corpora: FileCorpus[] = [];
		try {
			({ corpora, skipped: skippedFiles } = await refreshProjectCache(corpusCache, dir, sm.getSessionFile()));
		} catch (err) {
			return errorResult(`project scope unavailable: ${err instanceof Error ? err.message : String(err)}`, details);
		}
		foreignSessions = corpora.length;
		allChunks = [...archiveChunks, ...corpora.flatMap((c) => c.chunks)];
	}

	const rankedAll = rankChunks(allChunks, query, config.foreignWeight, config.halfLifeHours, config.recencyFloor);
	const ranked = rankedAll.slice(0, limit);
	const hits: SearchHit[] = ranked.map((r) => ({
		ref: r.chunk.ref,
		kind: r.chunk.kind,
		label: r.chunk.label,
		sessionLabel: r.chunk.sessionLabel,
		timestamp: r.chunk.timestamp,
		score: r.score,
		recencyFactor: r.recencyFactor,
		snippet: extractSnippet(r.chunk.text, query, config.snippetChars),
	}));
	const archiveEntries = new Set(allChunks.map((c) => c.ref)).size;
	const text = formatSearchResult(hits, { archiveEntries, foreignSessions, scope, skippedFiles, totalMatches: rankedAll.length });
	return {
		content: [{ type: "text", text }],
		details: { ...details, hits: hits.map((h) => ({ ref: h.ref, kind: h.kind, session: h.sessionLabel, score: h.score, snippet: h.snippet })) },
	};
}

/** Resolve the project cache through the injected reader (test seam). */
async function refreshProjectCache(
	cache: ProjectCorpusCache,
	dir: string,
	skipFile: string | undefined,
): Promise<{ corpora: FileCorpus[]; skipped: number }> {
	const skipped = await cache.refresh(dir, skipFile);
	return { corpora: cache.list(), skipped };
}

async function readEntry(
	params: { id?: string; offset?: number },
	ctx: ExtensionContext,
	corpusCache: ProjectCorpusCache,
	config: RecallConfig,
): Promise<{ text: string; details: RecallDetails }> {
	const details: RecallDetails = { mode: "read", scope: "session" };
	const ref = params.id?.trim() ?? "";
	if (ref === "") return { text: "Error: id is required in read mode (take it from a search result)", details };
	const parsed = parseRef(ref);
	if (parsed === undefined) return { text: `Error: "${ref}" is not a valid ref — use the id value from a recall search result`, details };
	const offset = Math.floor(
		typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0 ? params.offset : 0,
	);

	const sm = ctx.sessionManager;
	if (parsed.sessionIdShort === undefined) {
		const entry = sm.getEntry(parsed.entryId);
		if (entry === undefined) {
			return { text: `Error: entry ${ref} not found on the current branch (refs are branch-local; search again after rewinds)`, details };
		}
		const text = entryFullText(entry);
		return {
			text: formatReadResult(ref, `Entry ${ref} — current session · ${entry.timestamp}`, text, offset, config.readChars),
			details: { ...details, read: { ref, total: text.length } },
		};
	}

	// Foreign ref: refresh cache (cheap once warm) then read the exact line.
	const located = await locateForeignEntry(corpusCache, sm, parsed);
	if (typeof located === "string") return { text: `Error: ${located}`, details };
	const { entry, corpus } = located;
	const text = entryFullText(entry);
	return {
		text: formatReadResult(ref, `Entry ${parsed.entryId} — past session ${corpus.label} · ${entry.timestamp}`, text, offset, config.readChars),
		details: { ...details, scope: "project", read: { ref, total: text.length } },
	};
}

/**
 * Resolve a foreign ref to its parsed entry: refresh the project cache, locate
 * the cached line, re-read it through the injected reader, and verify the id
 * still matches (a rewritten file shifts line numbers silently). Every failure
 * returns a model-facing message instead of throwing.
 */
async function locateForeignEntry(
	corpusCache: ProjectCorpusCache,
	sm: ExtensionContext["sessionManager"],
	parsed: { entryId: string; sessionIdShort?: string },
): Promise<{ entry: SessionEntry; corpus: FileCorpus } | string> {
	try {
		await corpusCache.refresh(sm.getSessionDir(), sm.getSessionFile());
	} catch (err) {
		return `project scope unavailable: ${err instanceof Error ? err.message : String(err)}`;
	}
	const located = corpusCache.locate(parsed.sessionIdShort ?? "", parsed.entryId);
	if (located === undefined) {
		return `entry ${parsed.entryId}.${parsed.sessionIdShort} not found in past sessions (refs are stable per session file; search again to refresh)`;
	}
	let entryLine: string | undefined;
	try {
		entryLine = await corpusCache.readEntryLine(located.corpus, located.line);
	} catch (err) {
		return `session file unreadable: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (entryLine === undefined) return "session file changed since indexing — search again to refresh refs";
	try {
		const entry = JSON.parse(entryLine) as SessionEntry;
		if (entry.id !== parsed.entryId) return "session file changed since indexing — search again to refresh refs";
		return { entry, corpus: located.corpus };
	} catch {
		return `session file line ${located.line} is unreadable`;
	}
}

export default registerRecallTool;
