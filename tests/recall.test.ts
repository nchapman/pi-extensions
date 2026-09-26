import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	buildArchiveChunks,
	buildFileCorpus,
	chunkText,
	chunksFromEntry,
	configFromEnv,
	fsProjectReader,
	extractEntrySections,
	extractSnippet,
	formatReadResult,
	formatSearchResult,
	kindLabel,
	parseRef,
	ProjectCorpusCache,
	rankChunks,
	recencyFactor,
	carryForwardFileLists,
	effectiveCompactTarget,
	lastCompactionDetails,
	mergeSummaryInstructions,
	SUMMARY_ADDENDUM,
	shouldAutoCompact,
	type SummaryFn,
	registerRecallTool,
	visibleEntryIds,
	renderRecallCall,
	renderRecallResult,
	RECALL_TOOL_NAME,
	tokenize,
	type RecallConfig,
	type SearchHit,
} from "../extensions/recall";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: RecallConfig = {
	defaultScope: "session",
	foreignWeight: 0.5,
	halfLifeHours: 4,
	recencyFloor: 0.25,
	compactTargetTokens: 131_072,
	ownSummaries: true,
	chunkChars: 3000,
	snippetChars: 400,
	maxResults: 5,
	readChars: 4000,
	projectMaxBytes: 64 * 1024 * 1024,
};

let nextId = 0;
function id(): string {
	return (nextId++).toString(16).padStart(8, "0");
}

function msgEntry(
	role: string,
	message: Record<string, unknown>,
	timestamp = "2026-09-26T10:00:00.000Z",
): SessionEntry {
	return { type: "message", id: id(), parentId: null, timestamp, message: { role, ...message } } as unknown as SessionEntry;
}

function compactionEntry(summary: string, firstKeptEntryId: string, timestamp = "2026-09-26T12:00:00.000Z"): SessionEntry {
	return {
		type: "compaction",
		id: id(),
		parentId: null,
		timestamp,
		summary,
		firstKeptEntryId,
		tokensBefore: 100_000,
	} as unknown as SessionEntry;
}

function makePi() {
	const tools = new Map<string, {
		name: string;
		execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
		renderCall?: (args: never, theme: never, context?: never) => unknown;
		renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
	}>();
	const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const pi = {
		registerTool: (t: {
			name: string;
			execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
			renderCall?: (args: never, theme: never, context?: never) => unknown;
			renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
		}) => tools.set(t.name, t),
		registerCommand: () => {},
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => events.set(event, handler),
	} as unknown as ExtensionAPI;
	return { pi, tools, events };
}

/** Same shape visibleEntryIds() consumes in the tool: projection-visible ids. */
function visibleIds(entries: SessionEntry[]): Set<string> {
	return visibleEntryIds({ entries: entries.map((entry) => ({ sourceEntry: entry, messages: [{}] })) });
}

async function fire(events: Map<string, (event?: unknown, ctx?: unknown) => unknown>, name: string, ctx?: unknown, event?: unknown) {
	const handler = events.get(name);
	if (!handler) throw new Error(`no handler registered for ${name}`);
	return handler(event ?? { type: name }, ctx);
}

/** Branch: [header-ish junk, old user, old thinking, compaction, kept user]. */
function sessionCtx(overrides?: {
	branch?: SessionEntry[];
	contextEntries?: SessionEntry[];
	sessionDir?: string;
	sessionFile?: string;
}): ExtensionContext {
	const oldUser = msgEntry("user", { content: "We decided the auth token refresh must use rotation." });
	const oldThinking = msgEntry("assistant", {
		content: [{ type: "thinking", thinking: "Rejected approach B because the KV cache breaks." }],
	});
	const compaction = compactionEntry("## Goal\nFix auth refresh", "kept1");
	const keptUser = msgEntry("user", { content: "Now write the tests." });
	keptUser.id = "kept1";
	const branch = overrides?.branch ?? [oldUser, oldThinking, compaction, keptUser];
	const contextEntries = overrides?.contextEntries ?? [compaction, keptUser];
	const projection = {
		entries: contextEntries.map((entry) => ({ sourceEntry: entry, messages: entry.id === "omitted" ? [] : [{}] })),
		messages: [],
		thinkingLevel: "low",
		model: null,
	};
	return {
		getContextUsage: () => undefined,
		compact: () => {},
		sessionManager: {
			getBranch: () => branch,
			buildSessionProjection: () => projection,
			getSessionId: () => "aaaaaaaa-1111-2222-3333-444444444444",
			getSessionDir: () => overrides?.sessionDir ?? "/sessions/project",
			getSessionFile: () => overrides?.sessionFile ?? "/sessions/project/current.jsonl",
			getEntry: (entryId: string) => branch.find((e) => e.id === entryId),
		},
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
	it("splits camelCase, snake_case, and punctuation identically", () => {
		expect(tokenize("parseHeader")).toEqual(["parse", "header"]);
		expect(tokenize("parse_header")).toEqual(["parse", "header"]);
		expect(tokenize("Parse Header!")).toEqual(["parse", "header"]);
	});

	it("splits digit boundaries and keeps numbers", () => {
		expect(tokenize("utf8Encoding v2")).toEqual(["utf", "8", "encoding", "v", "2"]);
	});

	it("handles acronyms in camelCase", () => {
		expect(tokenize("parseHTTPHeader")).toEqual(["parse", "http", "header"]);
	});

	it("returns no empty tokens", () => {
		expect(tokenize("--- ___ ===")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// extractEntrySections
// ---------------------------------------------------------------------------

describe("extractEntrySections", () => {
	it("extracts user string content", () => {
		const sections = extractEntrySections(msgEntry("user", { content: "hello world" }));
		expect(sections).toEqual([{ kind: "user", text: "hello world" }]);
	});

	it("treats non-string, non-array content as empty", () => {
		expect(extractEntrySections(msgEntry("user", { content: 42 }))).toEqual([]);
	});

	it("drops tool results, custom messages, and inline custom messages with empty text", () => {
		expect(extractEntrySections(msgEntry("toolResult", { toolName: "bash", content: "" }))).toEqual([]);
		expect(extractEntrySections(msgEntry("custom", { customType: "note", content: "" }))).toEqual([]);
		const inline = { type: "custom_message", id: id(), parentId: null, timestamp: "t", customType: "n", content: "" } as unknown as SessionEntry;
		expect(extractEntrySections(inline)).toEqual([]);
	});

	it("extracts assistant text, visible thinking, and tool calls", () => {
		const sections = extractEntrySections(
			msgEntry("assistant", {
				content: [
					{ type: "thinking", thinking: "plan the fix" },
					{ type: "text", text: "Doing it" },
					{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } },
				],
			}),
		);
		expect(sections.map((s) => s.kind)).toEqual(["thinking", "assistant", "toolCall"]);
		expect(sections[2]).toMatchObject({ label: "edit" });
		expect(sections[2].text).toContain("a.ts");
	});

	it("skips redacted thinking and empty text", () => {
		const sections = extractEntrySections(
			msgEntry("assistant", {
				content: [
					{ type: "thinking", thinking: "", redacted: true },
					{ type: "text", text: "" },
				],
			}),
		);
		expect(sections).toEqual([]);
	});

	it("extracts tool results with their tool name", () => {
		const sections = extractEntrySections(
			msgEntry("toolResult", { toolName: "bash", content: [{ type: "text", text: "tests failed" }] }),
		);
		expect(sections).toEqual([{ kind: "toolResult", label: "bash", text: "tests failed" }]);
	});

	it("extracts bash executions including fullOutputPath", () => {
		const sections = extractEntrySections(
			msgEntry("bashExecution", { command: "npm test", output: "1 failed", fullOutputPath: "/tmp/out.txt" }),
		);
		expect(sections[0].kind).toBe("bash");
		expect(sections[0].text).toContain("$ npm test");
		expect(sections[0].text).toContain("/tmp/out.txt");
	});

	it("extracts custom messages", () => {
		const sections = extractEntrySections(msgEntry("custom", { customType: "note", content: "remember X" }));
		expect(sections).toEqual([{ kind: "custom", label: "note", text: "remember X" }]);
	});

	it("extracts compaction summaries with file lists from details", () => {
		const entry = {
			type: "compaction",
			id: id(),
			parentId: null,
			timestamp: "2026-09-26T12:00:00.000Z",
			summary: "did things",
			firstKeptEntryId: "x",
			details: { readFiles: ["/a.ts"], modifiedFiles: ["/b.ts", "/c.ts"] },
		} as unknown as SessionEntry;
		const sections = extractEntrySections(entry);
		expect(sections[0].kind).toBe("summary");
		expect(sections[0].text).toContain("did things");
		expect(sections[0].text).toContain("read: /a.ts");
		expect(sections[0].text).toContain("modified: /b.ts, /c.ts");
	});

	it("extracts branch summaries", () => {
		const entry = { type: "branch_summary", id: id(), parentId: null, timestamp: "t", summary: "alt path" } as unknown as SessionEntry;
		expect(extractEntrySections(entry)).toEqual([{ kind: "branchSummary", text: "alt path" }]);
	});

	it("skips system, metadata, and state entries", () => {
		const system = msgEntry("system", { content: "You are pi" });
		const modelChange = { type: "model_change", id: id(), parentId: null, timestamp: "t" } as unknown as SessionEntry;
		const custom = { type: "custom", id: id(), parentId: null, timestamp: "t", customType: "x", data: {} } as unknown as SessionEntry;
		for (const entry of [system, modelChange, custom]) expect(extractEntrySections(entry)).toEqual([]);
	});

	it("extracts custom_message entries (inline content)", () => {
		const entry = {
			type: "custom_message",
			id: id(),
			parentId: null,
			timestamp: "t",
			customType: "dossier",
			content: "project facts",
			display: true,
		} as unknown as SessionEntry;
		expect(extractEntrySections(entry)).toEqual([{ kind: "custom", label: "dossier", text: "project facts" }]);
	});

	it("stringifies tool-call arguments deterministically (sorted keys, arrays kept, undefined dropped)", () => {
		const sections = extractEntrySections(
			msgEntry("assistant", {
				content: [{ type: "toolCall", name: "edit", arguments: { z: 1, a: ["x", "y"], nested: { d: 2, c: 3 }, skip: undefined } }],
			}),
		);
		expect(sections[0].text).toBe('edit({"a":["x","y"],"nested":{"c":3,"d":2},"z":1})');
	});

	it("returns nothing for messages without a message object", () => {
		const entry = { type: "message", id: id(), parentId: null, timestamp: "t" } as unknown as SessionEntry;
		expect(extractEntrySections(entry)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe("chunkText", () => {
	it("returns a single chunk when under the limit", () => {
		expect(chunkText("short", 100)).toEqual([{ text: "short", charOffset: 0 }]);
	});

	it("returns nothing for empty text", () => {
		expect(chunkText("", 100)).toEqual([]);
	});

	it("splits at line boundaries when possible", () => {
		const text = `${"a".repeat(60)}\n${"b".repeat(60)}\n${"c".repeat(60)}`;
		const chunks = chunkText(text, 100);
		expect(chunks).toHaveLength(3);
		expect(chunks[0].text).toBe(`${"a".repeat(60)}\n`);
		expect(chunks[0].charOffset).toBe(0);
		expect(chunks[1].charOffset).toBe(61);
		for (const c of chunks) expect(text.slice(c.charOffset, c.charOffset + c.text.length)).toBe(c.text);
	});

	it("hard-splits unbroken lines", () => {
		const chunks = chunkText("x".repeat(250), 100);
		expect(chunks).toHaveLength(3);
		expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
	});

	it("reconstruction from offsets yields the original", () => {
		const text = Array.from({ length: 20 }, (_, i) => `line ${i} ${"z".repeat(30)}`).join("\n");
		const chunks = chunkText(text, 200);
		const rebuilt = chunks.map((c) => c.text).join("");
		expect(rebuilt.length).toBeGreaterThanOrEqual(text.length - 20); // newlines kept at cut points
		for (const c of chunks) expect(text.slice(c.charOffset, c.charOffset + c.text.length)).toBe(c.text);
	});
});

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

describe("refs", () => {
	it("current refs are bare entry ids", () => {
		expect(parseRef("abcd1234")).toEqual({ entryId: "abcd1234", sessionIdShort: undefined });
	});

	it("foreign refs carry the session short id", () => {
		expect(parseRef("abcd1234.1e2d")).toEqual({ entryId: "abcd1234", sessionIdShort: "1e2d" });
	});

	it("rejects malformed refs", () => {
		expect(parseRef("not-hex!")).toBeUndefined();
		expect(parseRef(".abcd")).toBeUndefined();
		expect(parseRef("abcd.")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildArchiveChunks
// ---------------------------------------------------------------------------

describe("buildArchiveChunks", () => {
	it("diffs branch against context and chunks the archive", () => {
		const ctx = sessionCtx();
		const chunks = buildArchiveChunks(
			ctx.sessionManager.getBranch(),
			visibleIds(ctx.sessionManager.getBranch().filter((e) => e.type === "compaction" || e.id === "kept1")),
			"sess",
			CONFIG,
		);
		const kinds = new Set(chunks.map((c) => c.kind));
		expect(kinds).contain("user");
		expect(kinds).contain("thinking");
		// The active compaction summary rides in context, so it is NOT archived.
		expect(kinds).not.contain("summary");
		// The kept user message is in context, not archived.
		expect(chunks.every((c) => c.text !== "Now write the tests.")).toBe(true);
	});

	it("archives a summary once a later compaction folds it away", () => {
		const first = compactionEntry("first summary", "k1", "2026-09-26T08:00:00.000Z");
		const second = compactionEntry("second summary", "k1", "2026-09-26T16:00:00.000Z");
		const kept = msgEntry("user", { content: "latest" });
		kept.id = "k1";
		const ctx = sessionCtx({ branch: [first, second, kept], contextEntries: [second, kept] });
		const chunks = buildArchiveChunks(ctx.sessionManager.getBranch(), visibleIds([second, kept]), "sess", CONFIG);
		const summaries = chunks.filter((c) => c.kind === "summary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0].text).toContain("first summary");
	});
});

// ---------------------------------------------------------------------------
// rankChunks (BM25 + session weighting)
// ---------------------------------------------------------------------------

function foreignChunk(text: string, sessionId = "1e2dcafe-0000"): RecallChunkLike {
	return chunksFromEntry(
		{ type: "message", id: id(), parentId: null, timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: text } } as unknown as SessionEntry,
		{ origin: "foreign", sessionId, sessionLabel: "past session old" },
		3000,
	)[0];
}
type RecallChunkLike = ReturnType<typeof chunksFromEntry>[number];

describe("rankChunks", () => {
	// The default sessionCtx archive: only the compaction + kept message are visible.
	function compaction(): SessionEntry {
		return sessionCtx().sessionManager.getBranch().find((e) => e.type === "compaction")!;
	}
	function kept(): SessionEntry {
		return sessionCtx().sessionManager.getBranch().find((e) => e.type === "message" && (e as { id?: string }).id === "kept1")!;
	}

	it("ranks the more relevant chunk first", () => {
		const ctx = sessionCtx();
		const archive = buildArchiveChunks(ctx.sessionManager.getBranch(), visibleIds([compaction(), kept()]), "sess", CONFIG);
		const ranked = rankChunks(archive, "KV cache breaks", 0.5);
		expect(ranked.length).toBeGreaterThan(0);
		expect(ranked[0].chunk.text).toContain("KV cache");
	});

	it("drops chunks matching no query term", () => {
		const ctx = sessionCtx();
		const archive = buildArchiveChunks(ctx.sessionManager.getBranch(), visibleIds([]), "sess", CONFIG);
		expect(rankChunks(archive, "zzzznotpresent", 0.5)).toEqual([]);
	});

	it("matches across identifier boundaries (query phrasing vs code)", () => {
		const entry = msgEntry("user", { content: "the parseHeader function throws" });
		const chunk = chunksFromEntry(entry, { origin: "current", sessionId: "s", sessionLabel: "current session" }, 3000)[0];
		expect(rankChunks([chunk], "parse header", 0.5).length).toBe(1);
	});

	it("penalizes foreign chunks by the configured weight", () => {
		const current = chunksFromEntry(
			msgEntry("user", { content: "rotation policy discussion" }),
			{ origin: "current", sessionId: "s", sessionLabel: "current session" },
			3000,
		)[0];
		const foreign = foreignChunk("rotation policy discussion");
		// Recency decay disabled (floor 1) so this test isolates session weighting.
		const ranked = rankChunks([foreign, current], "rotation policy", 0.5, 1e9, 1);
		expect(ranked[0].chunk.origin).toBe("current");
		expect(ranked[1].rawScore).toBe(ranked[0].rawScore); // identical text ⇒ identical BM25
		expect(ranked[1].score).toBeCloseTo(ranked[0].score * 0.5, 5);
	});

	it("a highly relevant foreign chunk can still outrank a weak current one", () => {
		const current = chunksFromEntry(
			msgEntry("user", { content: "unrelated chatter entirely" }),
			{ origin: "current", sessionId: "s", sessionLabel: "current session" },
			3000,
		)[0];
		const foreign = foreignChunk("migration rollback procedure details");
		const ranked = rankChunks([current, foreign], "migration rollback procedure", 0.5);
		expect(ranked[0].chunk.origin).toBe("foreign");
	});

	it("empty query yields nothing", () => {
		const ctx = sessionCtx();
		const archive = buildArchiveChunks(ctx.sessionManager.getBranch(), visibleIds([]), "sess", CONFIG);
		expect(rankChunks(archive, "  ", 0.5)).toEqual([]);
	});

	it("empty corpus yields nothing", () => {
		expect(rankChunks([], "auth", 0.5)).toEqual([]);
	});

	it("skips chunks that tokenized to nothing instead of dividing by zero", () => {
		const chunk = {
			ref: "aaaaaaaa", entryId: "aaaaaaaa", origin: "current",
			sessionLabel: "current session", kind: "user", timestamp: "2026-09-26T10:00:00.000Z",
			text: "   ",
		} as never;
		expect(rankChunks([chunk as never], "auth", 0.5)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// snippets & formatting
// ---------------------------------------------------------------------------

describe("extractSnippet", () => {
	it("windows around the first query match", () => {
		const text = `${"filler ".repeat(50)}needle here${" more filler".repeat(50)}`;
		const snippet = extractSnippet(text, "needle", 40);
		expect(snippet).toContain("needle");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(42);
	});

	it("ignores substring hits without word boundaries", () => {
		const text = `${"filler ".repeat(50)}sparse data${" more filler".repeat(50)}`;
		const snippet = extractSnippet(text, "parse", 40);
		expect(snippet.startsWith("f")).toBe(true); // head window, not windowed on "sparse"
	});

	it("returns the head when nothing matches", () => {
		const snippet = extractSnippet("abcdef".repeat(200), "zzz", 50);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.startsWith("a")).toBe(true);
	});

	it("marks blank or empty text explicitly instead of rendering an empty window", () => {
		expect(extractSnippet("", "query", 50)).toBe("(empty)");
		expect(extractSnippet("   \n  ", "query", 50)).toBe("(empty)");
	});

	it("collapses blank runs", () => {
		const snippet = extractSnippet("x\n\n\n\n\ny", "y", 400);
		expect(snippet).not.toContain("\n\n\n");
	});
});

describe("formatSearchResult", () => {
	const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
		ref: "abcd1234",
		kind: "toolResult",
		label: "bash",
		sessionLabel: "current session",
		timestamp: "2026-09-26T10:00:00.000Z",
		score: 7.25,
		snippet: "one line\nsecond line",
		...over,
	});

	it("lists hits with provenance, read hint, and pagination note", () => {
		const text = formatSearchResult([hit()], { archiveEntries: 42, foreignSessions: 0, scope: "session" });
		expect(text).toContain("1 match");
		expect(text).toContain("current session");
		expect(text).toContain("tool result (bash)");
		expect(text).toContain('"mode": "read", "id": "abcd1234"');
	});

	it("suggests project scope when nothing matches in session scope", () => {
		const text = formatSearchResult([], { archiveEntries: 42, foreignSessions: 0, scope: "session" });
		expect(text).toContain("No matches");
		expect(text).toContain("project");
	});

	it("mentions skipped files", () => {
		const text = formatSearchResult([hit()], { archiveEntries: 42, foreignSessions: 1, scope: "project", skippedFiles: 2 });
		expect(text).toContain("2 unreadable session files skipped");
	});
});

describe("formatReadResult", () => {
	it("shows the char window and a continuation ref when truncated", () => {
		const text = formatReadResult("abcd1234", "Entry abcd1234 — current session", "x".repeat(10_000), 0, 4000);
		expect(text).toContain("[chars 0-4000 of 10000]");
		expect(text).toContain('"offset": 4000');
	});

	it("omits the continuation note at the end", () => {
		const text = formatReadResult("abcd1234", "header", "short", 0, 4000);
		expect(text).not.toContain("offset");
	});
});

// ---------------------------------------------------------------------------
// Project corpus
// ---------------------------------------------------------------------------

function sessionFile(over: {
	id?: string;
	name?: string;
	entries?: string[];
}): { basename: string; content: string } {
	const sid = over.id ?? "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd";
	const header = JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-20T09:00:00.000Z", cwd: "/p" });
	const lines = [header];
	if (over.name) lines.push(JSON.stringify({ type: "session_info", id: id(), parentId: null, timestamp: "t", name: over.name }));
	for (const entry of over.entries ?? []) lines.push(entry);
	return { basename: `2026-09-20T09-00-00-000Z_${sid}.jsonl`, content: `${lines.join("\n")}\n` };
}

function userLine(text: string): string {
	return JSON.stringify({ type: "message", id: id(), parentId: null, timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: text } });
}

function fakeReader(files: Array<{ basename: string; content: string }>) {
	const dir = "/sessions/project";
	const paths = files.map((f) => `${dir}/${f.basename}`);
	const byPath = new Map(paths.map((p, i) => [p, files[i].content]));
	const stats = new Map(paths.map((p) => [p, { mtimeMs: 1, size: byPath.get(p)!.length }]));
	const readCounts = new Map<string, number>();
	return {
		reader: {
			async listJsonlFiles(d: string) {
				if (d !== dir) throw new Error("ENOENT");
				return [...paths];
			},
			async readFile(file: string) {
				readCounts.set(file, (readCounts.get(file) ?? 0) + 1);
				const content = byPath.get(file);
				if (content === undefined) throw new Error("gone");
				return content;
			},
			async stat(file: string) {
				return stats.get(file);
			},
		},
		dir,
		paths,
		stats,
		readCounts,
		note(file: string) {
			stats.set(file, { mtimeMs: 2, size: (stats.get(file)?.size ?? 0) + 1 });
		},
	};
}

describe("buildFileCorpus", () => {
	it("indexes content, resolves the session name, and records entry lines", () => {
		const f = sessionFile({ name: "Auth rework", entries: [userLine("discussed token rotation at length")] });
		const corpus = buildFileCorpus(`/s/${f.basename}`, f.content)!;
		expect(corpus).toBeDefined();
		expect(corpus.chunks[0].text).toContain("token rotation");
		expect(corpus.chunks[0].origin).toBe("foreign");
		expect(corpus.chunks[0].sessionLabel).toContain("Auth rework");
		expect(corpus.chunks[0].ref).toMatch(/^[0-9a-f]{8}\.1e2d$/);
		expect(corpus.entryLines.get(corpus.chunks[0].entryId)).toBe(3);
	});

	it("returns undefined for header-only files", () => {
		const f = sessionFile({});
		expect(buildFileCorpus(`/s/${f.basename}`, f.content)).toBeUndefined();
	});

	it("falls back to the filename id and blank date when header fields are missing", () => {
		const header = JSON.stringify({ type: "session", version: 3 }); // no id, no timestamp
		const file = "/s/2026-01-02T03-04-05-000Z_abc.jsonl";
		const corpus = buildFileCorpus(file, `${header}\n${userLine("content")}\n`);
		expect(corpus?.sessionId).toBe("2026-01-02T03-04-05-000Z_abc");
		expect(corpus?.chunks[0].sessionLabel).toBe("past session ");
	});

	it("tolerates partially written and id-less lines", () => {
		const f = sessionFile({ entries: [userLine("kept content")] });
		const content = [f.content.split("\n")[0], "{not json…", JSON.stringify({ type: "message", timestamp: "t" }), f.content.trim().split("\n")[1]].join("\n");
		const corpus = buildFileCorpus(`/s/${f.basename}`, content)!;
		expect(corpus.chunks).toHaveLength(1); // only the well-formed, id-bearing entry
		expect(corpus.chunks[0].text).toContain("kept content");
	});
});

describe("ProjectCorpusCache", () => {
	it("caches by mtime+size and skips the current session file", async () => {
		const f1 = sessionFile({ entries: [userLine("past session content")] });
		const current = sessionFile({ id: "cccc0000-0000" });
		const { reader, dir, paths, readCounts } = fakeReader([f1, current]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		const skipped = await cache.refresh(dir, paths[1]); // current file = paths[1]
		expect(skipped).toBe(0);
		expect(cache.list()).toHaveLength(1);
		expect(cache.list()[0].file).toBe(paths[0]);
		await cache.refresh(dir, paths[1]);
		expect(readCounts.get(paths[0])).toBe(1); // stat hit, no re-read
	});

	it("rebuilds a changed file and drops a deleted one", async () => {
		const f1 = sessionFile({ entries: [userLine("alpha content")] });
		const { reader, dir, paths, stats, readCounts, note } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		await cache.refresh(dir, undefined);
		note(paths[0]);
		await cache.refresh(dir, undefined);
		expect(readCounts.get(paths[0])).toBe(2);
		stats.delete(paths[0]);
		reader.listJsonlFiles = async () => [];
		await cache.refresh(dir, undefined);
		expect(cache.list()).toHaveLength(0);
	});

	it("counts unreadable files as skipped", async () => {
		const f1 = sessionFile({});
		const { reader, dir } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		expect(await cache.refresh(dir, undefined)).toBe(1); // header-only = unreadable/skipped
	});

	it("evicts least-recently-used files beyond the byte cap", async () => {
		// Distinct session ids: identical ids would collapse fakeReader's path map
		// into one file and turn this test into a vacuous single-file pass.
		const f1 = sessionFile({ id: "11111111-aaaa-bbbb-cccc-dddddddddddd", entries: [userLine("one")] });
		const f2 = sessionFile({ id: "22222222-aaaa-bbbb-cccc-dddddddddddd", entries: [userLine("two")] });
		const { reader, dir } = fakeReader([f1, f2]);
		const cache = new ProjectCorpusCache(reader, 1); // cap forces eviction down to one file
		await cache.refresh(dir, undefined);
		const survivors = cache.list();
		expect(survivors).toHaveLength(1);
		// The most recently inserted file survives; the older one was evicted.
		expect(survivors[0].file).toContain("22222222-aaaa-bbbb-cccc-dddddddddddd");
		expect(cache.totalBytes()).toBe(survivors[0].bytes);
	});

	it("refresh of an unchanged file touches LRU without re-reading", async () => {
		const f1 = sessionFile({ entries: [userLine("stable content")] });
		const { reader, dir, paths, readCounts } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		await cache.refresh(dir, undefined);
		await cache.refresh(dir, undefined); // stat-identical: no re-read
		expect(readCounts.get(paths[0])).toBe(1);
	});

	it("counts a vanished file (stat miss) as skipped and evicts it", async () => {
		const f1 = sessionFile({ entries: [userLine("content")] });
		const { reader, dir } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		await cache.refresh(dir, undefined);
		expect(cache.list()).toHaveLength(1);
		reader.stat = async () => undefined; // listed but unstat-able
		expect(await cache.refresh(dir, undefined)).toBe(1);
		expect(cache.list()).toHaveLength(0);
	});

	it("counts an unreadable file (read throws) as skipped and evicts it", async () => {
		const f1 = sessionFile({ entries: [userLine("content")] });
		const { reader, dir } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		reader.readFile = async () => {
			throw new Error("permission denied");
		};
		expect(await cache.refresh(dir, undefined)).toBe(1);
		expect(cache.list()).toHaveLength(0);
	});

	it("locates entries by session short id", async () => {
		const f1 = sessionFile({ entries: [userLine("find me")] });
		const { reader, dir } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		await cache.refresh(dir, undefined);
		const corpus = cache.list()[0];
		const entryId = corpus.chunks[0].entryId;
		expect(cache.locate("1e2d", entryId)).toMatchObject({ corpus, line: 2 });
		expect(cache.locate("beef", entryId)).toBeUndefined();
	});
});

// The real filesystem seam behind the injected ProjectReader.
describe("fsProjectReader", () => {
	it("lists only .jsonl files, reads content, and tolerates missing stats", async () => {
		const dir = await mkdtemp(`${tmpdir()}/recall-reader-`);
		try {
			await writeFile(`${dir}/a.jsonl`, "{}\n");
			await writeFile(`${dir}/notes.txt`, "not a session");
			const names = await fsProjectReader.listJsonlFiles(dir);
			expect(names).toEqual([`${dir}/a.jsonl`]);
			expect(await fsProjectReader.readFile(names[0])).toBe("{}\n");
			expect((await fsProjectReader.stat(names[0]))?.size).toBe(3);
			expect(await fsProjectReader.stat(`${dir}/gone.jsonl`)).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

describe("registerRecallTool", () => {
	function setup(config = CONFIG) {
		const { pi, tools, events } = makePi();
		registerRecallTool(pi, config);
		return { tools, events, run: (params: unknown, ctx = sessionCtx()) => tools.get(RECALL_TOOL_NAME)!.execute("t1", params, undefined, undefined, ctx) };
	}

	it("registers the tool with search defaults", async () => {
		const { tools, run } = setup();
		expect(tools.get(RECALL_TOOL_NAME)).toBeDefined();
		const result = (await run({ query: "rotation" })) as { content: Array<{ text: string }>; details: { hits: unknown[] } };
		expect(result.content[0].text).toContain("rotation");
		expect(result.content[0].text).toContain("read");
		expect(result.details.hits.length).toBeGreaterThan(0);
	});

	it("errors when search mode lacks a query", async () => {
		const { run } = setup();
		const result = (await run({})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("Error: query is required");
	});

	it("tells the model when nothing has been compacted yet", async () => {
		const { run } = setup();
		const ctx = sessionCtx({ branch: [], contextEntries: [] });
		const result = (await run({ query: "anything" }, ctx)) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("Nothing has been compacted yet");
	});

	it("read mode returns a full current-session entry with pagination", async () => {
		const { run } = setup({ ...CONFIG, readChars: 30 });
		const ctx = sessionCtx();
		const branch = ctx.sessionManager.getBranch();
		const target = branch.find((e) => e.type === "message" && (e as { message?: { content?: unknown } }).message?.content === "We decided the auth token refresh must use rotation.")!;
		const first = (await run({ mode: "read", id: target.id }, ctx)) as { content: Array<{ text: string }> };
		expect(first.content[0].text).toContain("[chars 0-30 of 52]");
		expect(first.content[0].text).toContain('"offset": 30');
		const second = (await run({ mode: "read", id: target.id, offset: 10 }, ctx)) as { content: Array<{ text: string }> };
		expect(second.content[0].text).toContain("[chars 10-40 of 52]");
		const clamped = (await run({ mode: "read", id: target.id, offset: -5 }, ctx)) as { content: Array<{ text: string }> };
		expect(clamped.content[0].text).toContain("[chars 0-30 of 52]"); // negative offset sanitizes to 0
	});

	it("clamps the limit param into [1, 25] with the config default as fallback", async () => {
		const { run } = setup();
		const archived1 = msgEntry("user", { content: "we chose rotation for tokens" }, "2026-09-26T09:00:00.000Z");
		const archived2 = msgEntry("user", { content: "rotation confirmed later" }, "2026-09-26T09:30:00.000Z");
		const kept = msgEntry("user", { content: "current turn" }, "2026-09-26T11:00:00.000Z");
		const ctx = sessionCtx({ branch: [archived1, archived2, kept], contextEntries: [kept] });
		const all = (await run({ query: "rotation" }, ctx)) as { details: { hits: unknown[] } }; // default limit (5)
		expect(all.details.hits).toHaveLength(2);
		const zero = (await run({ query: "rotation", limit: 0 }, ctx)) as { details: { hits: unknown[] } };
		expect(zero.details.hits).toHaveLength(1); // floored to 1
		const negative = (await run({ query: "rotation", limit: -3 }, ctx)) as { details: { hits: unknown[] } };
		expect(negative.details.hits).toHaveLength(1);
	});

	it("honors defaultScope: 'project' without an explicit scope param", async () => {
		const foreign = sessionFile({ entries: [userLine("the uniquely findable foreign thing")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, { ...CONFIG, defaultScope: "project" }, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const result = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "uniquely findable" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: { scope: string; hits: Array<{ ref: string }> };
		};
		expect(result.details.scope).toBe("project");
		expect(result.details.hits[0].ref).toContain("."); // dotted = foreign-session ref
	});

	it("read mode requires a valid id", async () => {
		const { run } = setup();
		const noId = (await run({ mode: "read" })) as { content: Array<{ text: string }> };
		expect(noId.content[0].text).toContain("Error: id is required");
		const badId = (await run({ mode: "read", id: "not-hex!" })) as { content: Array<{ text: string }> };
		expect(badId.content[0].text).toContain("not a valid ref");
	});

	it("read mode reports unknown current refs explicitly", async () => {
		const { run } = setup();
		const result = (await run({ mode: "read", id: "deadbeef" })) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("not found on the current branch");
	});

	it("project scope merges foreign sessions with down-ranking", async () => {
		const foreign = sessionFile({ name: "Old work", entries: [userLine("migration rollback procedure from last week")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, { ...CONFIG, defaultScope: "session" }, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		// Session-scope query misses the foreign-only content.
		const sessionOnly = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "migration rollback" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(sessionOnly.content[0].text).toContain("No matches");
		// Project scope finds it, labeled as a past session.
		const project = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "migration rollback", scope: "project" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: { hits: Array<{ session: string }> };
		};
		expect(project.content[0].text).toContain("past session");
		expect(project.content[0].text).toContain("Old work");
		expect(project.details.hits[0].session).toContain("past session");
	});

	it("project scope errors clearly when the session dir is missing", async () => {
		const missing = {
			listJsonlFiles: async () => {
				throw new Error("ENOENT: no such directory");
			},
			readFile: async () => "",
			stat: async () => undefined,
		};
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, missing);
		const result = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "x", scope: "project" }, undefined, undefined, sessionCtx())) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0].text).toContain("project scope unavailable");
	});

	it("foreign reads resolve through the file line map", async () => {
		const foreign = sessionFile({ entries: [userLine("the exact foreign detail we need to read fully")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "exact foreign detail", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;
		expect(ref).toMatch(/\./);
		const read = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(read.content[0].text).toContain("the exact foreign detail we need to read fully");
	});

	it("fires a one-shot reminder after compaction", async () => {
		const { events } = setup();
		const ctx = sessionCtx();
		await fire(events, "session_compact", ctx);
		const first = (await fire(events, "before_agent_start", ctx)) as { message: { content: string } } | undefined;
		expect(first?.message.content).toContain("recall");
		// Not-miss-a-beat contract: the reminder forces re-orientation from the freshest
		// ground truth (kept messages), not just the possibly-stale summary.
		expect(first?.message.content).toContain("Re-orient");
		expect(first?.message.content).toContain("most recent messages");
		const second = await fire(events, "before_agent_start", ctx);
		expect(second).toBeUndefined();
	});

	it("session_start clears a pending reminder", async () => {
		const { events } = setup();
		const ctx = sessionCtx();
		await fire(events, "session_compact", ctx);
		await fire(events, "session_start", ctx);
		expect(await fire(events, "before_agent_start", ctx)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Renderers & config
// ---------------------------------------------------------------------------

describe("renderers", () => {
	const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

	it("call row shows the query, or read mode", () => {
		expect(renderRecallCall({ query: "token rotation" }, theme)).toContain("token rotation");
		expect(renderRecallCall({ mode: "read", id: "x" }, theme)).toContain("recall read");
		expect(renderRecallCall({ query: 42 }, theme)).not.toContain("42"); // non-string query renders bare
	});

	it("clips long queries in the collapsed call row", () => {
		const row = renderRecallCall({ query: "x".repeat(100) }, theme);
		expect(row).toContain("…");
		expect(row.length).toBeLessThan(100);
	});

	it("registered render adapters reuse the previous Text component in place", () => {
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG);
		const tool = tools.get(RECALL_TOOL_NAME)!;
		const callCtx: { lastComponent?: unknown } = {};
		const first = tool.renderCall!({ query: "auth" } as never, theme as never, callCtx as never);
		expect(first).toBeInstanceOf(Text);
		callCtx.lastComponent = first;
		const second = tool.renderCall!({ query: "tokens" } as never, theme as never, callCtx as never);
		expect(second).toBe(first); // same component object, updated in place
		const resultCtx: { lastComponent?: unknown } = {};
		const resultA = tool.renderResult!({ details: { hits: [{ snippet: "a" }] } } as never, { expanded: true } as never, theme as never, resultCtx as never);
		expect(resultA).toBeInstanceOf(Text);
		resultCtx.lastComponent = resultA;
		expect(tool.renderResult!({ details: { hits: [] } } as never, { expanded: true } as never, theme as never, resultCtx as never)).toBe(resultA);
	});

	it("result row shows hit count and expands to snippets", () => {
		const collapsed = renderRecallResult({ hits: [{ snippet: "abc" }, { snippet: "def" }] }, { expanded: false }, theme);
		expect(collapsed).toContain("2 hits");
		const expanded = renderRecallResult({ hits: [{ snippet: "a b c" }] }, { expanded: true }, theme);
		expect(expanded).toContain("a b c");
		expect(renderRecallResult(undefined, { expanded: false }, theme)).toContain("no matches");
		expect(renderRecallResult({ read: { total: 1234 } }, { expanded: false }, theme)).toContain("1,234 chars");
	});
});

describe("configFromEnv", () => {
	it("applies defaults with a clean env", () => {
		const config = configFromEnv({});
		expect(config.defaultScope).toBe("session");
		expect(config.foreignWeight).toBe(0.5);
	});

	it("reads scope and weights, clamping numbers", () => {
		const config = configFromEnv({ PI_RECALL_SCOPE: "project", PI_RECALL_FOREIGN_WEIGHT: "0.8", PI_RECALL_MAX_RESULTS: "99" });
		expect(config.defaultScope).toBe("project");
		expect(config.foreignWeight).toBe(0.8);
		expect(config.maxResults).toBe(25);
	});

	it("falls back on invalid values", () => {
		const config = configFromEnv({ PI_RECALL_SCOPE: "bogus", PI_RECALL_FOREIGN_WEIGHT: "nope" });
		expect(config.defaultScope).toBe("session");
		expect(config.foreignWeight).toBe(0.5);
	});

	it("non-boolean flag values fall back with an explicit error", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const config = configFromEnv({ PI_RECALL_COMPACT_OWN: "maybe" });
			expect(config.ownSummaries).toBe(true); // default preserved
			expect(err).toHaveBeenCalledWith(expect.stringContaining("PI_RECALL_COMPACT_OWN=maybe"));
		} finally {
			err.mockRestore();
		}
	});

	it("parses truthy and falsy flag spellings", () => {
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "1" }).ownSummaries).toBe(true);
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "true" }).ownSummaries).toBe(true);
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "0" }).ownSummaries).toBe(false);
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "no" }).ownSummaries).toBe(false);
	});
});

// kindLabel sanity for model-facing labels
describe("kindLabel", () => {
	it("labels tool sections with their tool name", () => {
		expect(kindLabel("toolResult", "bash")).toBe("tool result (bash)");
		expect(kindLabel("summary")).toContain("compaction summary");
	});

	it("labels every entry kind, with and without optional labels", () => {
		expect(kindLabel("user")).toBe("user message");
		expect(kindLabel("assistant")).toBe("assistant");
		expect(kindLabel("thinking")).toBe("assistant thinking");
		expect(kindLabel("toolCall", "edit")).toBe("tool call (edit)");
		expect(kindLabel("toolCall")).toBe("tool call");
		expect(kindLabel("toolResult")).toBe("tool result");
		expect(kindLabel("bash")).toBe("bash execution");
		expect(kindLabel("branchSummary")).toContain("branch summary");
		expect(kindLabel("custom", "todo")).toBe("injected context (todo)");
		expect(kindLabel("custom")).toBe("injected context");
	});
});



// ---------------------------------------------------------------------------
// Recency decay (memory horizon)
// ---------------------------------------------------------------------------

describe("recency decay", () => {
	const NOW = "2026-09-26T18:00:00.000Z";
	const chunkAt = (text: string, iso: string) =>
		chunksFromEntry(msgEntry("user", { content: text }, iso), { origin: "current", sessionId: "s", sessionLabel: "current session" }, 3000)[0];

	it("recencyFactor halves per half-life and never drops below the floor", () => {
		const H = 4 * 3_600_000;
		expect(recencyFactor(0, H, 0.25)).toBe(1);
		expect(recencyFactor(H, H, 0.25)).toBeCloseTo(0.5, 6);
		expect(recencyFactor(2 * H, H, 0.25)).toBeCloseTo(0.25, 6); // exactly at floor
		expect(recencyFactor(200 * H, H, 0.25)).toBe(0.25); // floored, not zero
		expect(recencyFactor(Number.NaN, H, 0.25)).toBe(0.25);
		expect(recencyFactor(-1, H, 0.25)).toBe(0.25); // future/invalid → oldest-safe
	});

	it("the latest of three same-topic decisions wins", () => {
		const old = chunkAt("we decided to use a sidecar index for recall", "2026-09-26T06:00:00.000Z");
		const mid = chunkAt("we decided to use the set-diff for recall instead of a sidecar", "2026-09-26T09:00:00.000Z");
		const late = chunkAt("final decision: set-diff plus projection visibility for recall", "2026-09-26T12:00:00.000Z");
		const ranked = rankChunks([old, mid, late], "decision recall", 0.5, 4, 0.25);
		expect(ranked[0].chunk.text).toContain("final decision");
		expect(ranked.map((r) => r.chunk.timestamp)).toEqual([...ranked.map((r) => r.chunk.timestamp)].sort().reverse());
	});

	it("a verbose old discussion loses to a terse recent decision despite higher raw BM25", () => {
		const verbose = chunkAt(
			"cache cache cache policy policy. " + "cache policy details. ".repeat(40),
			"2026-09-26T02:00:00.000Z",
		);
		const terse = chunkAt("cache policy: keep manual compaction", NOW);
		const ranked = rankChunks([verbose, terse], "cache policy", 0.5, 4, 0.25);
		expect(ranked[0].chunk.text).toContain("manual compaction");
		expect(ranked[0].rawScore).toBeLessThan(ranked[1].rawScore); // recency flipped it
	});

	it("a distinctive old term still beats a vague recent mention (floor keeps old content findable)", () => {
		const old = chunkAt("the zephyrhead traceback pointed at line 88", "2026-09-01T10:00:00.000Z");
		const recent = chunkAt("we looked at a traceback earlier", NOW);
		const ranked = rankChunks([old, recent], "zephyrhead traceback", 0.5, 4, 0.25);
		expect(ranked[0].chunk.text).toContain("zephyrhead");
	});

	it("ages are measured from the archive frontier, not wall clock (weekend-safe)", () => {
		const make = (shiftDays: number) => [
			chunkAt("first pass at the ranking design", isoAdd("2026-09-22T10:00:00.000Z", shiftDays)),
			chunkAt("second pass at the ranking design", isoAdd("2026-09-26T10:00:00.000Z", shiftDays)),
		];
		const thisWeek = rankChunks(make(0), "ranking design", 0.5, 4, 0.25);
		const afterWeekend = rankChunks(make(30), "ranking design", 0.5, 4, 0.25);
		// Identical relative positions along the continuum ⇒ identical scores,
		// no matter how far the whole archive sits in the past.
		expect(afterWeekend[0].score).toBeCloseTo(thisWeek[0].score, 9);
		expect(afterWeekend[0].chunk.text).toContain("second pass");
	});

	it("search output annotates decayed hits and omits the note for frontier hits", () => {
		const withFactor = formatSearchResult(
			[{ ref: "a1", kind: "user", sessionLabel: "current session", timestamp: NOW, score: 4.2, recencyFactor: 0.62, snippet: "s" }],
			{ archiveEntries: 10, foreignSessions: 0, scope: "session", totalMatches: 1 },
		);
		expect(withFactor).toContain("(recency ×0.62)");
		const frontier = formatSearchResult(
			[{ ref: "a1", kind: "user", sessionLabel: "current session", timestamp: NOW, score: 4.2, recencyFactor: 1, snippet: "s" }],
			{ archiveEntries: 10, foreignSessions: 0, scope: "session", totalMatches: 1 },
		);
		expect(frontier).not.toContain("recency");
	});

	it("config parses the new knobs with clamps", () => {
		expect(configFromEnv({ PI_RECALL_HALF_LIFE_HOURS: "12" }).halfLifeHours).toBe(12);
		expect(configFromEnv({ PI_RECALL_RECENCY_FLOOR: "0.4" }).recencyFloor).toBe(0.4);
		expect(configFromEnv({ PI_RECALL_HALF_LIFE_HOURS: "0" }).halfLifeHours).toBeCloseTo(0.1, 9); // clamped to min
		expect(configFromEnv({ PI_RECALL_RECENCY_FLOOR: "5" }).recencyFloor).toBe(1); // clamped to max (decay off)
		expect(configFromEnv({ PI_RECALL_RECENCY_FLOOR: "nope" }).recencyFloor).toBe(0.25); // invalid → default
	});
});

function isoAdd(iso: string, days: number): string {
	return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Context budget & compaction ownership
// ---------------------------------------------------------------------------

describe("context budget", () => {
	it("effectiveCompactTarget picks the smaller of config target and window headroom", () => {
		expect(effectiveCompactTarget(131_072, 200_000)).toBe(131_072);
		expect(effectiveCompactTarget(131_072, 100_000)).toBe(95_904); // window-bound
		expect(effectiveCompactTarget(500_000, 200_000)).toBe(195_904); // big target clamps to window
		expect(effectiveCompactTarget(0, 200_000)).toBeUndefined(); // disabled
		expect(effectiveCompactTarget(131_072, 4096)).toBeUndefined(); // window nonsense
		expect(effectiveCompactTarget(131_072, 4097)).toBe(1); // boundary: just above headroom
		expect(effectiveCompactTarget(131_072, 0)).toBeUndefined();
	});

	it("shouldAutoCompact gates on tokens, target, and in-flight state", () => {
		expect(shouldAutoCompact(150_000, 200_000, 131_072, false)).toBe(true);
		expect(shouldAutoCompact(100_000, 200_000, 131_072, false)).toBe(false);
		expect(shouldAutoCompact(null, 200_000, 131_072, false)).toBe(false); // tokens unknown
		expect(shouldAutoCompact(150_000, 200_000, 131_072, true)).toBe(false); // already compacting
		expect(shouldAutoCompact(150_000, 200_000, 0, false)).toBe(false); // disabled
		expect(shouldAutoCompact(131_072, 200_000, 131_072, false)).toBe(false); // exactly at target: not over
	});
});

describe("summary instructions", () => {
	it("uses the addendum alone when no user focus exists", () => {
		expect(mergeSummaryInstructions(SUMMARY_ADDENDUM, undefined)).toBe(SUMMARY_ADDENDUM);
		expect(mergeSummaryInstructions(SUMMARY_ADDENDUM, "  ")).toBe(SUMMARY_ADDENDUM);
	});

	it("appends user focus after the addendum", () => {
		const merged = mergeSummaryInstructions(SUMMARY_ADDENDUM, "focus on the auth refactor");
		expect(merged.startsWith(SUMMARY_ADDENDUM)).toBe(true);
		expect(merged).toContain("User focus for this compaction: focus on the auth refactor");
	});

	it("does not duplicate the addendum our own trigger already passed through", () => {
		const viaTrigger = mergeSummaryInstructions(SUMMARY_ADDENDUM, SUMMARY_ADDENDUM);
		expect(viaTrigger).toBe(SUMMARY_ADDENDUM);
	});
});

describe("file-list carry-forward", () => {
	const ops = (read: string[], written: string[], edited: string[]) => ({ read: new Set(read), written: new Set(written), edited: new Set(edited) });

	it("derives lists from current operations alone", () => {
		expect(carryForwardFileLists(undefined, ops(["a", "c"], ["d"], ["b"]))).toEqual({
			readFiles: ["a", "c"],
			modifiedFiles: ["b", "d"],
		});
	});

	it("unions with the previous compaction's lists and drops reads that became modified", () => {
		const prev = { readFiles: ["a", "old.txt"], modifiedFiles: ["b"] };
		expect(carryForwardFileLists(prev, ops(["a", "c"], ["d"], []))).toEqual({
			readFiles: ["a", "c", "old.txt"],
			modifiedFiles: ["b", "d"],
		});
	});

	it("drops a previously-read file that is now modified (lands only in modifiedFiles)", () => {
		expect(carryForwardFileLists({ readFiles: ["a"], modifiedFiles: [] }, ops([], ["a"], []))).toEqual({
			readFiles: [],
			modifiedFiles: ["a"],
		});
	});

	it("ignores malformed previous details", () => {
		expect(carryForwardFileLists("nonsense", ops(["a"], [], []))).toEqual({ readFiles: ["a"], modifiedFiles: [] });
	});

	it("lastCompactionDetails finds the most recent compaction entry", () => {
		const c1 = compactionEntry("one", "k1");
		(c1 as { details?: unknown }).details = { readFiles: ["one.txt"], modifiedFiles: [] };
		const c2 = compactionEntry("two", "k2");
		(c2 as { details?: unknown }).details = { readFiles: ["two.txt"], modifiedFiles: [] };
		expect(lastCompactionDetails([c1, msgEntry("user", { content: "hi" }), c2])).toEqual({ readFiles: ["two.txt"], modifiedFiles: [] });
		expect(lastCompactionDetails([msgEntry("user", { content: "hi" })])).toBeUndefined();
	});
});

describe("auto-compact wiring", () => {
	function setup(usage: { tokens: number | null; contextWindow: number } | undefined) {
		const compactCalls: Array<Record<string, unknown>> = [];
		const ctx = {
			getContextUsage: () => usage,
			compact: (opts: Record<string, unknown>) => compactCalls.push(opts),
		};
		return { ctx, compactCalls };
	}

	it("triggers compaction once when the settled context exceeds the target", async () => {
		const { ctx, compactCalls } = setup({ tokens: 150_000, contextWindow: 200_000 });
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG);
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0].customInstructions).toBe(SUMMARY_ADDENDUM);
		// In-flight: no second trigger until the first completes.
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(1);
		(onCompleteOf(compactCalls[0]) as () => void)();
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(2);
	});

	it("never triggers from before_agent_start even over budget — ctx.compact() would abort/race the starting run", async () => {
		const { ctx, compactCalls } = setup({ tokens: 190_000, contextWindow: 200_000 });
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG);
		await fire(events, "before_agent_start", ctx);
		expect(compactCalls).toHaveLength(0);
	});

	it("does not trigger below the target, on unknown tokens, or when disabled", async () => {
		const below = setup({ tokens: 100_000, contextWindow: 200_000 });
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG);
		await fire(events, "agent_settled", below.ctx);
		expect(below.compactCalls).toHaveLength(0);

		const unknown = setup({ tokens: null, contextWindow: 200_000 });
		await fire(events, "agent_settled", unknown.ctx);
		expect(unknown.compactCalls).toHaveLength(0);

		const disabled = setup({ tokens: 190_000, contextWindow: 200_000 });
		const off = makePi();
		registerRecallTool(off.pi, { ...CONFIG, compactTargetTokens: 0 });
		await fire(off.events, "agent_settled", disabled.ctx);
		expect(disabled.compactCalls).toHaveLength(0);
	});

	it("session_compact clears the in-flight flag", async () => {
		const { ctx, compactCalls } = setup({ tokens: 150_000, contextWindow: 200_000 });
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG);
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(1);
		await fire(events, "session_compact", ctx);
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(2);
	});

	it("a failed compaction clears the in-flight flag via onError and leaves a breadcrumb", async () => {
		const crumbs: string[] = [];
		const { ctx, compactCalls } = setup({ tokens: 150_000, contextWindow: 200_000 });
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (line) => crumbs.push(line) });
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(1);
		(compactCalls[0].onError as (err: Error) => void)(new Error("auth expired"));
		expect(crumbs).toEqual([expect.stringContaining("budget trigger failed: auth expired")]);
		await fire(events, "agent_settled", ctx);
		expect(compactCalls).toHaveLength(2);
	});

	it("session_compact_failed appends a breadcrumb unless the user cancelled", async () => {
		const crumbs: string[] = [];
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (line) => crumbs.push(line) });
		await fire(events, "session_compact_failed", undefined, { type: "session_compact_failed", reason: "threshold", errorMessage: "summarizer blew up", aborted: false });
		await fire(events, "session_compact_failed", undefined, { type: "session_compact_failed", reason: "manual", aborted: true });
		expect(crumbs).toEqual([expect.stringContaining("compaction failed (threshold): summarizer blew up")]);
	});
});

describe("compaction summary ownership", () => {
	const SIGNAL = new AbortController().signal;

	function beforeCompactEvent(overrides: Record<string, unknown> = {}) {
		return {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "kept1",
				messagesToSummarize: [{ role: "user", content: "do the thing" }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 150_000,
				previousSummary: "## Goal\n- Earlier",
				fileOps: { read: new Set(["read1.ts"]), written: new Set(["wrote1.ts"]), edited: new Set() },
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
			branchEntries: [compactionEntry("old summary", "k0")],
			reason: "threshold",
			willRetry: false,
			signal: SIGNAL,
			...overrides,
		};
	}

	function hookCtx() {
		return {
			model: { id: "test-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: { "x-test": "1" } }) },
			thinkingLevel: undefined,
		};
	}

	it("generates the summary with recall-aware instructions and carried file lists", async () => {
		const calls: unknown[] = [];
		const summarize: SummaryFn = async (args) => {
			calls.push(args);
			return { text: "## Goal\n- Recall-aware summary", usage: { totalTokens: 42 } };
		};
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { summarize });
		const result = (await fire(events, "session_before_compact", hookCtx(), beforeCompactEvent())) as {
			compaction: Record<string, unknown>;
		};
		const args = calls[0] as { customInstructions: string; apiKey?: string; previousSummary?: string };
		expect(args.customInstructions.startsWith(SUMMARY_ADDENDUM)).toBe(true);
		expect(args.apiKey).toBe("sk-test");
		expect(args.previousSummary).toBe("## Goal\n- Earlier");
		expect(result.compaction.summary).toBe("## Goal\n- Recall-aware summary");
		expect(result.compaction.firstKeptEntryId).toBe("kept1");
		expect(result.compaction.tokensBefore).toBe(150_000);
		// Previous compaction entry has no details → lists come from fileOps alone.
		expect(result.compaction.details).toEqual({ readFiles: ["read1.ts"], modifiedFiles: ["wrote1.ts"] });
	});

	it("re-ceives the auto-compact trigger's addendum verbatim, never wrapped as user focus", async () => {
		const calls: unknown[] = [];
		const summarize: SummaryFn = async (args) => {
			calls.push(args);
			return { text: "## Goal\n- ok", usage: { totalTokens: 1 } };
		};
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { summarize });
		// The budget trigger passes SUMMARY_ADDENDUM itself as customInstructions.
		await fire(events, "session_before_compact", hookCtx(), beforeCompactEvent({ customInstructions: SUMMARY_ADDENDUM }));
		const args = calls[0] as { customInstructions: string };
		expect(args.customInstructions).toBe(SUMMARY_ADDENDUM);
		expect(args.customInstructions).not.toContain("User focus");
	});

	it("falls back to pi's default (undefined) on failure, empty text, or missing model — each leaving a breadcrumb; opt-out stays silent", async () => {
		const crumbs: string[] = [];
		const failing: SummaryFn = async () => {
			throw new Error("model exploded");
		};
		const a = makePi();
		registerRecallTool(a.pi, CONFIG, undefined, { summarize: failing, logCompactionError: (l) => crumbs.push(l) });
		expect(await fire(a.events, "session_before_compact", hookCtx(), beforeCompactEvent())).toBeUndefined();

		const empty: SummaryFn = async () => ({ text: "   ", usage: {} });
		const b = makePi();
		registerRecallTool(b.pi, CONFIG, undefined, { summarize: empty, logCompactionError: (l) => crumbs.push(l) });
		expect(await fire(b.events, "session_before_compact", hookCtx(), beforeCompactEvent())).toBeUndefined();

		const c = makePi();
		registerRecallTool(c.pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
		expect(await fire(c.events, "session_before_compact", { ...hookCtx(), model: undefined }, beforeCompactEvent())).toBeUndefined();

		expect(crumbs).toEqual([
			expect.stringContaining("fell back to pi default: model exploded"),
			expect.stringContaining("fell back to pi default: summarizer returned empty text"),
			expect.stringContaining("fell back to pi default: no model on session context"),
		]);

		const never: SummaryFn = async () => {
			throw new Error("must not be called");
		};
		const quiet: string[] = [];
		const d = makePi();
		registerRecallTool(d.pi, { ...CONFIG, ownSummaries: false }, undefined, { summarize: never, logCompactionError: (l) => quiet.push(l) });
		expect(await fire(d.events, "session_before_compact", hookCtx(), beforeCompactEvent())).toBeUndefined();
		expect(quiet).toEqual([]);
	});

	it("declines when auth resolution fails, leaving a breadcrumb", async () => {
		const crumbs: string[] = [];
		const summarize: SummaryFn = async () => ({ text: "unused", usage: {} });
		const ctx = { ...hookCtx(), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key configured" }) } };
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { summarize, logCompactionError: (l) => crumbs.push(l) });
		expect(await fire(events, "session_before_compact", ctx, beforeCompactEvent())).toBeUndefined();
		expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: auth unavailable (no key configured)")]);
	});

	it("merges user focus from /compact into the addendum", async () => {
		const calls: unknown[] = [];
		const summarize: SummaryFn = async (args) => {
			calls.push(args);
			return { text: "s", usage: {} };
		};
		const { pi, events } = makePi();
		registerRecallTool(pi, CONFIG, undefined, { summarize });
		await fire(events, "session_before_compact", hookCtx(), beforeCompactEvent({ customInstructions: "focus on auth" }));
		expect((calls[0] as { customInstructions: string }).customInstructions).toContain("User focus for this compaction: focus on auth");
	});

	it("config parses the budget knobs", () => {
		expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "60000" }).compactTargetTokens).toBe(60000);
		expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "0" }).compactTargetTokens).toBe(0);
		expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "nope" }).compactTargetTokens).toBe(131_072);
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "0" }).ownSummaries).toBe(false);
		expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "nope" }).ownSummaries).toBe(true); // invalid → default with warning
	});
});

function onCompleteOf(call: Record<string, unknown>): unknown {
	return call.onComplete;
}

// ---------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------

describe("review regressions", () => {
	it("tokenizes digit-to-letter boundaries (sha256hash)", () => {
		expect(tokenize("sha256hash")).toEqual(["sha", "256", "hash"]);
		expect(tokenize("base64encode")).toEqual(["base", "64", "encode"]);
	});

	it("breaks ranking ties by ref ascending when score and timestamp are equal", () => {
		const mk = (ref: string): RecallChunkLike =>
			chunksFromEntry(
				{
					type: "message",
					id: ref,
					parentId: null,
					timestamp: "2026-09-26T10:00:00.000Z",
					message: { role: "user", content: "identical content about tokens" },
				} as unknown as SessionEntry,
				{ origin: "current", sessionId: "s", sessionLabel: "current session" },
				3000,
			)[0];
		// Pass in non-ref order to prove the sort, not input order, wins.
		const ranked = rankChunks([mk("000000ff"), mk("00000009"), mk("00000001")], "identical content", 0.5);
		expect(ranked.map((r) => r.chunk.ref)).toEqual(["00000001", "00000009", "000000ff"]);
	});

	it("clamps read offsets past end instead of rendering nonsense windows", () => {
		const text = formatReadResult("ab", "H", "short", 50, 4000);
		expect(text).toContain("[chars 5-5 of 5]");
	});

	it("keeps LRU byte accounting exact across a rebuild", async () => {
		const f1 = sessionFile({ entries: [userLine("alpha content that is long enough to matter")] });
		const { reader, dir, paths, note } = fakeReader([f1]);
		const cache = new ProjectCorpusCache(reader, 64 * 1024 * 1024);
		await cache.refresh(dir, undefined);
		const before = cache.totalBytes();
		expect(before).toBe(cache.list().reduce((n, c) => n + c.bytes, 0));
		note(paths[0]); // mtime+size change → rebuild
		await cache.refresh(dir, undefined);
		expect(cache.totalBytes()).toBe(cache.list().reduce((n, c) => n + c.bytes, 0));
	});

	it("read mode converts a failing reader into an explicit error, never a throw", async () => {
		const foreign = sessionFile({ entries: [userLine("findable foreign text")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;
		reader.readFile = async () => {
			throw new Error("disk went away");
		};
		const read = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(read.content[0].text).toContain("Error:");
		expect(read.content[0].text).toContain("disk went away");
	});

	it("detects a rewritten foreign file by verifying the entry id at read time", async () => {
		const foreign = sessionFile({ entries: [userLine("the original entry text"), userLine("a second entry")] });
		const { reader, dir, note } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "original entry", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;
		// Simulate a prepend that shifts line numbers: same stat-invalidating change,
		// but the reader now serves shifted content under the old cache.
		const shifted = `${JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd", timestamp: "2026-09-20T09:00:00.000Z", cwd: "/p" })}\n${userLine("shift line")}\n${userLine("the original entry text")}\n${userLine("a second entry")}\n`;
		const path0 = (await reader.listJsonlFiles(dir))[0];
		reader.readFile = async () => shifted;
		note(path0);
		const read = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		// The rebuild reindexes the shifted file with fresh entry ids, so the old ref
		// must miss — never silently return the shifted entry under the old ref.
		expect(read.content[0].text).toContain("Error:");
	});

	it("reports an unreadable session line instead of throwing bad JSON", async () => {
		const foreign = sessionFile({ entries: [userLine("findable foreign text")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;
		reader.readFile = async () => "not json at all\n"; // line 1 is garbage
		const read = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(read.content[0].text).toContain("Error:");
		expect(read.content[0].text).toMatch(/unreadable|changed since indexing/);
	});

	it("read mode converts a refresh failure into an explicit project-scope error", async () => {
		const foreign = sessionFile({ entries: [userLine("findable foreign text")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;
		reader.listJsonlFiles = async () => {
			throw new Error("ENOENT: no such directory");
		};
		const read = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(read.content[0].text).toContain("Error:");
		expect(read.content[0].text).toContain("project scope unavailable");
	});

	it("read mode detects a truncated file and a swapped entry id at the indexed line", async () => {
		const foreign = sessionFile({ entries: [userLine("the target entry")] });
		const { reader, dir } = fakeReader([foreign]);
		const { pi, tools } = makePi();
		registerRecallTool(pi, CONFIG, reader);
		const ctx = sessionCtx({ sessionDir: dir });
		const search = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { query: "target entry", scope: "project" }, undefined, undefined, ctx)) as {
			details: { hits: Array<{ ref: string }> };
		};
		const ref = search.details.hits[0].ref;

		// Truncation: indexed line 2 no longer exists (stats unchanged, cache not rebuilt).
		reader.readFile = async () => JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd" });
		const truncated = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(truncated.content[0].text).toContain("changed since indexing");

		// Swap: line 2 parses but holds a different entry id — never return wrong data.
		reader.readFile = async () => `${JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd" })}\n${userLine("a different entry")}\n`;
		const swapped = (await tools.get(RECALL_TOOL_NAME)!.execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(swapped.content[0].text).toContain("changed since indexing");
	});

	it("entries omitted from context by edits remain searchable (projection-aware diff)", async () => {
		const omitted = msgEntry("user", { content: "the secret context-edit omitted detail about invoices" });
		omitted.id = "omitted"; // fixture projects no messages for this id
		const branch = [omitted];
		const projection = { entries: [{ sourceEntry: omitted, messages: [] }], messages: [], thinkingLevel: "low", model: null };
		const ids = visibleEntryIds(projection as never);
		expect(ids.has("omitted")).toBe(false);
		const chunks = buildArchiveChunks(branch, ids, "sess", CONFIG);
		expect(chunks.some((c) => c.text.includes("invoices"))).toBe(true);
	});

	it("notes truncated results only when matches were actually cut", () => {
		const hit = (): SearchHit => ({
			ref: "abcd1234",
			kind: "user",
			sessionLabel: "current session",
			timestamp: "2026-09-26T10:00:00.000Z",
			score: 5,
			snippet: "s",
		});
		const complete = formatSearchResult([hit()], { archiveEntries: 42, foreignSessions: 0, scope: "session", totalMatches: 1 });
		expect(complete).not.toContain("results limited");
		const cut = formatSearchResult([hit()], { archiveEntries: 42, foreignSessions: 0, scope: "session", totalMatches: 7 });
		expect(cut).toContain("results limited");
		const foreignMiss = formatSearchResult([], { archiveEntries: 42, foreignSessions: 3, scope: "project" });
		expect(foreignMiss).not.toContain('scope "project"');
	});

	it("buildFileCorpus honors the chunk size", () => {
		const entry = userLine(`${"long line of text ".repeat(200)}`);
		const f = sessionFile({ entries: [entry] });
		const small = buildFileCorpus(`/s/${f.basename}`, f.content, 200)!;
		expect(small.chunks.length).toBeGreaterThan(1);
		const large = buildFileCorpus(`/s/${f.basename}`, f.content, 1_000_000)!;
		expect(large.chunks.length).toBe(1);
	});
});
