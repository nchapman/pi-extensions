import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { chunkKey, KEY_HEX } from "../lib/vecstore";
import {
  buildArchiveChunks,
  buildFileCorpus,
  chunkText,
  chunksFromEntry,
  collectFileOps,
  configFromEnv,
  draftPreparation,
  fsProjectReader,
  extractEntrySections,
  extractSnippet,
  formatReadResult,
  formatSearchResult,
  kindLabel,
  parseRef,
  ProjectCorpusCache,
  type ProjectReader,
  rankChunks,
  type RecallChunk,
  type EmbedSeam,
  type VectorStoreLike,
  semanticRankedKeys,
  fuseHybrid,
  recencyFactor,
  carryForwardFileLists,
  effectiveCompactTarget,
  lastCompactionDetails,
  buildSummarizationPrompt,
  salvageLengthStoppedSummary,
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
import { TODO_TOOL_NAME } from "../extensions/todo";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: RecallConfig = {
  defaultScope: "session",
  foreignWeight: 0.5,
  halfLifeHours: 4,
  recencyFloor: 0.25,
  compactTargetTokens: 131_072,
  compactTargetRatio: 0.7,
  ownSummaries: true,
  summaryChars: 5_000,
  summaryThinking: "high",
  chunkChars: 3000,
  snippetChars: 400,
  maxResults: 5,
  readChars: 4000,
  projectMaxBytes: 64 * 1024 * 1024,
  embedEnabled: false, // per-test: hybrid tests opt in with injected fakes — never a real worker
  embedDtype: "q8",
  embedWeight: 0.7,
  embedForeignMaxBytes: 32 * 1024 * 1024,
  embedModelDir: "/virtual/models",
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
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp,
    message: { role, ...message },
  } as unknown as SessionEntry;
}

function compactionEntry(
  summary: string,
  firstKeptEntryId: string,
  timestamp = "2026-09-26T12:00:00.000Z",
): SessionEntry {
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
  const tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<unknown>;
      renderCall?: (args: never, theme: never, context?: never) => unknown;
      renderResult?: (result: never, options: never, theme: never, context?: never) => unknown;
    }
  >();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const pi = {
    registerTool: (t: {
      name: string;
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<unknown>;
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

async function fire(
  events: Map<string, (event?: unknown, ctx?: unknown) => unknown>,
  name: string,
  ctx?: unknown,
  event?: unknown,
) {
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
    const inline = {
      type: "custom_message",
      id: id(),
      parentId: null,
      timestamp: "t",
      customType: "n",
      content: "",
    } as unknown as SessionEntry;
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
    const entry = {
      type: "branch_summary",
      id: id(),
      parentId: null,
      timestamp: "t",
      summary: "alt path",
    } as unknown as SessionEntry;
    expect(extractEntrySections(entry)).toEqual([{ kind: "branchSummary", text: "alt path" }]);
  });

  it("skips system, metadata, and state entries", () => {
    const system = msgEntry("system", { content: "You are pi" });
    const modelChange = { type: "model_change", id: id(), parentId: null, timestamp: "t" } as unknown as SessionEntry;
    const custom = {
      type: "custom",
      id: id(),
      parentId: null,
      timestamp: "t",
      customType: "x",
      data: {},
    } as unknown as SessionEntry;
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
        content: [
          {
            type: "toolCall",
            name: "edit",
            arguments: { z: 1, a: ["x", "y"], nested: { d: 2, c: 3 }, skip: undefined },
          },
        ],
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
    {
      type: "message",
      id: id(),
      parentId: null,
      timestamp: "2026-09-20T10:00:00.000Z",
      message: { role: "user", content: text },
    } as unknown as SessionEntry,
    { origin: "foreign", sessionId, sessionLabel: "past session old" },
    3000,
  )[0];
}
type RecallChunkLike = ReturnType<typeof chunksFromEntry>[number];

describe("rankChunks", () => {
  // The default sessionCtx archive: only the compaction + kept message are visible.
  function compaction(): SessionEntry {
    return sessionCtx()
      .sessionManager.getBranch()
      .find((e) => e.type === "compaction")!;
  }
  function kept(): SessionEntry {
    return sessionCtx()
      .sessionManager.getBranch()
      .find((e) => e.type === "message" && (e as { id?: string }).id === "kept1")!;
  }

  it("ranks the more relevant chunk first", () => {
    const ctx = sessionCtx();
    const archive = buildArchiveChunks(
      ctx.sessionManager.getBranch(),
      visibleIds([compaction(), kept()]),
      "sess",
      CONFIG,
    );
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
    const chunk = chunksFromEntry(
      entry,
      { origin: "current", sessionId: "s", sessionLabel: "current session" },
      3000,
    )[0];
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
      ref: "aaaaaaaa",
      entryId: "aaaaaaaa",
      origin: "current",
      sessionLabel: "current session",
      kind: "user",
      timestamp: "2026-09-26T10:00:00.000Z",
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
    const text = formatSearchResult([hit()], {
      archiveEntries: 42,
      foreignSessions: 1,
      scope: "project",
      skippedFiles: 2,
    });
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

function sessionFile(over: { id?: string; name?: string; entries?: string[] }): { basename: string; content: string } {
  const sid = over.id ?? "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd";
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sid,
    timestamp: "2026-09-20T09:00:00.000Z",
    cwd: "/p",
  });
  const lines = [header];
  if (over.name)
    lines.push(JSON.stringify({ type: "session_info", id: id(), parentId: null, timestamp: "t", name: over.name }));
  for (const entry of over.entries ?? []) lines.push(entry);
  return { basename: `2026-09-20T09-00-00-000Z_${sid}.jsonl`, content: `${lines.join("\n")}\n` };
}

function userLine(text: string): string {
  return JSON.stringify({
    type: "message",
    id: id(),
    parentId: null,
    timestamp: "2026-09-20T10:00:00.000Z",
    message: { role: "user", content: text },
  });
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
    const content = [
      f.content.split("\n")[0],
      "{not json…",
      JSON.stringify({ type: "message", timestamp: "t" }),
      f.content.trim().split("\n")[1],
    ].join("\n");
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
    return {
      tools,
      events,
      run: (params: unknown, ctx = sessionCtx()) =>
        tools.get(RECALL_TOOL_NAME)!.execute("t1", params, undefined, undefined, ctx),
    };
  }

  it("registers the tool with search defaults", async () => {
    const { tools, run } = setup();
    expect(tools.get(RECALL_TOOL_NAME)).toBeDefined();
    const result = (await run({ description: "rotation" })) as {
      content: Array<{ text: string }>;
      details: { hits: unknown[] };
    };
    expect(result.content[0].text).toContain("rotation");
    expect(result.content[0].text).toContain("read");
    expect(result.details.hits.length).toBeGreaterThan(0);
  });

  it("errors when search mode has neither description nor queries", async () => {
    const { run } = setup();
    const result = (await run({})) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("Error: description (or queries) is required");
  });

  it("tells the model when nothing has been compacted yet", async () => {
    const { run } = setup();
    const ctx = sessionCtx({ branch: [], contextEntries: [] });
    const result = (await run({ description: "anything" }, ctx)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("Nothing has been compacted yet");
  });

  it("read mode returns a full current-session entry with pagination", async () => {
    const { run } = setup({ ...CONFIG, readChars: 30 });
    const ctx = sessionCtx();
    const branch = ctx.sessionManager.getBranch();
    const target = branch.find(
      (e) =>
        e.type === "message" &&
        (e as { message?: { content?: unknown } }).message?.content ===
          "We decided the auth token refresh must use rotation.",
    )!;
    const first = (await run({ mode: "read", id: target.id }, ctx)) as { content: Array<{ text: string }> };
    expect(first.content[0].text).toContain("[chars 0-30 of 52]");
    expect(first.content[0].text).toContain('"offset": 30');
    const second = (await run({ mode: "read", id: target.id, offset: 10 }, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(second.content[0].text).toContain("[chars 10-40 of 52]");
    const clamped = (await run({ mode: "read", id: target.id, offset: -5 }, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(clamped.content[0].text).toContain("[chars 0-30 of 52]"); // negative offset sanitizes to 0
  });

  it("clamps the limit param into [1, 25] with the config default as fallback", async () => {
    const { run } = setup();
    const archived1 = msgEntry("user", { content: "we chose rotation for tokens" }, "2026-09-26T09:00:00.000Z");
    const archived2 = msgEntry("user", { content: "rotation confirmed later" }, "2026-09-26T09:30:00.000Z");
    const kept = msgEntry("user", { content: "current turn" }, "2026-09-26T11:00:00.000Z");
    const ctx = sessionCtx({ branch: [archived1, archived2, kept], contextEntries: [kept] });
    const all = (await run({ description: "rotation" }, ctx)) as { details: { hits: unknown[] } }; // default limit (5)
    expect(all.details.hits).toHaveLength(2);
    const zero = (await run({ description: "rotation", limit: 0 }, ctx)) as { details: { hits: unknown[] } };
    expect(zero.details.hits).toHaveLength(1); // floored to 1
    const negative = (await run({ description: "rotation", limit: -3 }, ctx)) as { details: { hits: unknown[] } };
    expect(negative.details.hits).toHaveLength(1);
  });

  it("honors defaultScope: 'project' without an explicit scope param", async () => {
    const foreign = sessionFile({ entries: [userLine("the uniquely findable foreign thing")] });
    const { reader, dir } = fakeReader([foreign]);
    const { pi, tools } = makePi();
    registerRecallTool(pi, { ...CONFIG, defaultScope: "project" }, reader);
    const ctx = sessionCtx({ sessionDir: dir });
    const result = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "uniquely findable" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
      details: { scope: string; hits: Array<{ ref: string }> };
    };
    expect(result.details.scope).toBe("project");
    expect(result.details.hits[0].ref).toContain("."); // dotted = foreign-session ref
  });

  it("drops chunks that quote the description verbatim — the search's own echo", async () => {
    // Real echo shape: an assistant toolCall whose arguments serialize the
    // description with JSON escapes (quotes, newline) — the haystack decode
    // must see through them. Pre-fix the echo wins on BM25 term coverage
    // AND recency: the question served back as its own top answer.
    const description = 'A "bug" where the worker process\nnever exits and blocks shutdown ECHOFINGERPRINT';
    const genuine = msgEntry(
      "user",
      { content: "the worker process never exits and blocks shutdown because the stdin watcher never fires" },
      "2026-09-26T09:00:00.000Z",
    );
    const echo = msgEntry(
      "assistant",
      { content: [{ type: "toolCall", name: RECALL_TOOL_NAME, arguments: { description } }] },
      "2026-09-26T11:00:00.000Z",
    );
    const kept = msgEntry("user", { content: "current turn" }, "2026-09-26T12:00:00.000Z");
    const ctx = sessionCtx({ branch: [genuine, echo, compactionEntry("", "k"), kept], contextEntries: [kept] });
    const { run } = setup();
    const result = (await run({ description }, ctx)) as { details: { hits: Array<{ snippet: string }> } };
    expect(result.details.hits.length).toBeGreaterThan(0);
    expect(result.details.hits.some((h) => h.snippet.includes("ECHOFINGERPRINT"))).toBe(false);
    expect(result.details.hits[0].snippet).toContain("stdin watcher");
  });

  it("filters at exactly 32 normalized chars but not one fewer", async () => {
    // Load-bearing boundary: at 32 the quote is an echo fingerprint; at 31 it
    // is a legitimate exact term whose verbatim chunks may be the real target.
    // The genuine hit shares the terms reordered, never the full needle.
    const runBoundary = async (needle: string) => {
      const echo = msgEntry("user", { content: `recall it: ${needle}` }, "2026-09-26T11:00:00.000Z");
      const genuine = msgEntry(
        "user",
        { content: "notes about uvwxyz0123, klmnopqrst, and abcdefhij ordering" },
        "2026-09-26T09:00:00.000Z",
      );
      const kept = msgEntry("user", { content: "current turn" }, "2026-09-26T12:00:00.000Z");
      const ctx = sessionCtx({ branch: [genuine, echo, compactionEntry("", "k"), kept], contextEntries: [kept] });
      const { run } = setup();
      return (await run({ description: needle }, ctx)) as { details: { hits: Array<{ snippet: string }> } };
    };
    const at32 = await runBoundary("abcdefghij klmnopqrst uvwxyz0123"); // 32 after normalization
    expect(at32.details.hits.some((h) => h.snippet.includes("abcdefghij klmnopqrst"))).toBe(false);
    expect(at32.details.hits.some((h) => h.snippet.includes("uvwxyz0123"))).toBe(true);
    const at31 = await runBoundary("abcdefghij klmnopqrst uvwxyz012"); // 31: verbatim chunk is a legit hit
    expect(at31.details.hits.some((h) => h.snippet.includes("abcdefghij klmnopqrst"))).toBe(true);
  });

  it("echo exclusion also covers foreign sessions quoting the description", async () => {
    const description = "a slow grinding data migration that we eventually throttled ECHOFINGERPRINT";
    const foreign = sessionFile({
      entries: [
        userLine("the data migration ran slowly until we throttled it to one core"),
        userLine(`bash recall --description "${description}"`),
      ],
    });
    const { reader, dir } = fakeReader([foreign]);
    const { pi, tools } = makePi();
    registerRecallTool(pi, CONFIG, reader);
    const ctx = sessionCtx({ sessionDir: dir });
    const result = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description, scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ snippet: string }> };
    };
    expect(result.details.hits.some((h) => h.snippet.includes("ECHOFINGERPRINT"))).toBe(false);
    expect(result.details.hits.some((h) => h.snippet.includes("one core"))).toBe(true);
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
    const foreign = sessionFile({
      name: "Old work",
      entries: [userLine("migration rollback procedure from last week")],
    });
    const { reader, dir } = fakeReader([foreign]);
    const { pi, tools } = makePi();
    registerRecallTool(pi, { ...CONFIG, defaultScope: "session" }, reader);
    const ctx = sessionCtx({ sessionDir: dir });
    // Session-scope query misses the foreign-only content.
    const sessionOnly = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "migration rollback" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(sessionOnly.content[0].text).toContain("No matches");
    // Project scope finds it, labeled as a past session.
    const project = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "migration rollback", scope: "project" }, undefined, undefined, ctx)) as {
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
    const result = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "x", scope: "project" }, undefined, undefined, sessionCtx())) as {
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "exact foreign detail", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;
    expect(ref).toMatch(/\./);
    const read = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
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

// ---------------------------------------------------------------------------
// Semantic side (hybrid search + embedding catch-up)
// ---------------------------------------------------------------------------

/** Toy vector space: one axis per topic, believable dot-product similarity. */
const VDIM = 8;
function vec(...axes: number[]): Float32Array {
  const v = new Float32Array(VDIM);
  axes.forEach((a, i) => (v[i] = a));
  return v;
}

function fakeEmbedSeam(overrides: { queryVector?: Float32Array } = {}) {
  // Mutable state so tests can flip failure modes between settles; kill is
  // running-aware so it stays idempotent like the real client.
  const state = {
    failQuery: false,
    failEmbed: false,
    disposed: false,
    queryVector: overrides.queryVector ?? vec(1),
    running: false,
  };
  const calls = {
    started: 0,
    killed: 0,
    queries: [] as string[],
    embeds: [] as Array<Array<{ key: string; text: string }>>,
  };
  const seam = {
    calls,
    state,
    get available() {
      return true;
    },
    start: () => {
      calls.started++;
      state.running = true;
      return true;
    },
    async query(text: string) {
      calls.queries.push(text);
      return state.failQuery ? undefined : state.queryVector;
    },
    async embed(items: readonly { key: string; text: string }[]) {
      calls.embeds.push([...items]);
      return state.failEmbed ? undefined : items.map((item) => ({ key: item.key, vector: vec(1) }));
    },
    kill: () => {
      if (!state.running) return;
      state.running = false;
      calls.killed++;
    },
    dispose: () => {
      state.disposed = true;
      if (!state.running) return;
      state.running = false;
      calls.killed++;
    },
  };
  return seam as unknown as EmbedSeam & { calls: typeof calls; state: typeof state };
}

function fakeVectorStore(seed: Array<{ key: string; vector: Float32Array }> = []) {
  const RECORD_BYTES = KEY_HEX / 2 + VDIM * 4; // mirrors the real store's record size
  const vectors = new Map(seed.map((s) => [s.key, s.vector] as const));
  const calls = {
    added: [] as Array<{ key: string; vector: Float32Array }>,
    closed: 0,
    compactions: [] as Array<Set<string>>,
  };
  const store = {
    calls,
    vectors,
    has: (keys: readonly string[]) => new Set(keys.filter((k) => vectors.has(k))),
    async add(items: readonly { key: string; vector: Float32Array }[]) {
      calls.added.push(...items);
      for (const item of items) vectors.set(item.key, item.vector);
    },
    async compact(keep: ReadonlySet<string>) {
      calls.compactions.push(new Set(keep));
      let reclaimed = 0;
      for (const key of vectors.keys())
        if (!keep.has(key)) {
          vectors.delete(key);
          reclaimed++;
        }
      return reclaimed * RECORD_BYTES;
    },
    topK(query: Float32Array, candidates: Iterable<string>, k: number) {
      const hits: Array<{ key: string; similarity: number }> = [];
      for (const key of candidates) {
        const v = vectors.get(key);
        if (v === undefined) continue;
        let dot = 0;
        for (let i = 0; i < VDIM; i++) dot += query[i] * v[i];
        hits.push({ key, similarity: dot });
      }
      hits.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1));
      return hits.slice(0, k);
    },
    async close() {
      calls.closed++;
    },
  };
  return store as unknown as VectorStoreLike & { calls: typeof calls; vectors: Map<string, Float32Array> };
}

/** Branch with two archived user messages — one lexical target, one semantic target — plus a kept tail. */
function hybridCtx() {
  const semantic = msgEntry("user", { content: "Fluffy curled up asleep in the corner of the rug." });
  const lexical = msgEntry("user", { content: "rotate the tokens on every refresh" });
  const compaction = compactionEntry("## Goal\nHybrid", "kept1");
  const kept = msgEntry("user", { content: "now continue" });
  kept.id = "kept1";
  return {
    ctx: sessionCtx({ branch: [semantic, lexical, compaction, kept], contextEntries: [compaction, kept] }),
    semantic,
    lexical,
  };
}

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
function firstKey(entry: SessionEntry): string {
  return chunksFromEntry(entry, { origin: "current", sessionId: SID, sessionLabel: "current session" }, 3000)[0].key;
}

/** settle loop: flush the fire-and-forget catch-up chains */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("semantic hybrid search", () => {
  async function hybridSetup(
    embedSeam: EmbedSeam,
    store: VectorStoreLike,
    configOverrides: Partial<RecallConfig> = {},
  ) {
    const { pi, tools, events } = makePi();
    registerRecallTool(pi, { ...CONFIG, embedEnabled: true, ...configOverrides } as RecallConfig, fsProjectReader, {
      embed: embedSeam,
      openStore: async () => store,
    });
    // Open the semantic side (a session_start on the default branch) so the
    // search path sees non-null vector support; its catch-up round touches
    // only default-branch keys, never the hybrid test branch's.
    await fire(events, "session_start", sessionCtx());
    await flush();
    return {
      run: (params: unknown, ctx = sessionCtx()) =>
        tools.get(RECALL_TOOL_NAME)!.execute("t", params, undefined, undefined, ctx),
    };
  }

  it("surfaces a semantic hit that shares no query terms, marked as semantic", async () => {
    const { ctx, semantic } = hybridCtx();
    const store = fakeVectorStore([{ key: firstKey(semantic), vector: vec(1) }]);
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, store);
    const result = (await run({ description: "kitten napping sunny spot" }, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toContain("Fluffy");
    expect(result.content[0].text).toContain("· sem");
  });
  it("echo exclusion covers the semantic side — fused candidates come from the filtered list", async () => {
    const description = "a cat sleeping somewhere warm and sunny all afternoon ECHOFINGERPRINT";
    const echo = msgEntry("assistant", {
      content: [{ type: "toolCall", name: RECALL_TOOL_NAME, arguments: { description } }],
    });
    const semantic = msgEntry("user", { content: "Fluffy curled up asleep in the corner of the rug." });
    const compaction = compactionEntry("## Goal\nHybrid", "kept1");
    const kept = msgEntry("user", { content: "now continue" });
    kept.id = "kept1";
    const ctx = sessionCtx({ branch: [semantic, echo, compaction, kept], contextEntries: [compaction, kept] });
    // The query vector aligns MORE with the echo's vector than the genuine
    // hit's — unfiltered, the echo wins the semantic side outright (and BM25:
    // it contains the whole description). The filter must remove it before
    // both candidate lists are built.
    const store = fakeVectorStore([
      { key: firstKey(semantic), vector: vec(0.5, 0.5) },
      { key: firstKey(echo), vector: vec(1) },
    ]);
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, store);
    const result = (await run({ description }, ctx)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("Fluffy");
    expect(result.content[0].text).toContain("· sem");
    expect(result.content[0].text.includes("ECHOFINGERPRINT")).toBe(false);
  });

  it("ranks a both-match above single-side hits and marks it", async () => {
    const { ctx, semantic, lexical } = hybridCtx();
    const store = fakeVectorStore([
      { key: firstKey(semantic), vector: vec(1) },
      { key: firstKey(lexical), vector: vec(0.5, 0.5) }, // partially aligned AND lexically matching
    ]);
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, store);
    const result = (await run({ description: "rotate tokens" }, ctx)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("· lex+sem");
    expect(result.content[0].text.indexOf("rotate")).toBeLessThan(result.content[0].text.indexOf("Fluffy"));
  });

  it("fails open to lexical-only when the query embed times out", async () => {
    const { ctx } = hybridCtx();
    const lexicalRun = (await (function () {
      const { pi, tools } = makePi();
      registerRecallTool(pi, CONFIG);
      return tools.get(RECALL_TOOL_NAME)!.execute("t", { description: "rotate tokens" }, undefined, undefined, ctx);
    })()) as { content: Array<{ text: string }> };
    const embed = fakeEmbedSeam();
    embed.state.failQuery = true;
    const { run } = await hybridSetup(embed, fakeVectorStore());
    const hybridRun = (await run({ description: "rotate tokens" }, ctx)) as { content: Array<{ text: string }> };
    expect(hybridRun.content[0].text).toBe(lexicalRun.content[0].text);
    expect(embed.calls.queries).toHaveLength(1);
  });

  it("skips the vector side entirely at weight 0", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, fakeVectorStore(), { embedWeight: 0 });
    await run({ description: "rotate tokens" }, ctx);
    expect(embed.calls.queries).toHaveLength(0);
  });

  it("leaves ranking untouched when nothing is cached yet", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, fakeVectorStore());
    const result = (await run({ description: "rotate tokens" }, ctx)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("rotate");
    expect(result.content[0].text).not.toContain("· sem");
  });

  it("routes description to the semantic side and queries to BM25", async () => {
    const { ctx, semantic } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const store = fakeVectorStore([{ key: firstKey(semantic), vector: vec(1) }]);
    const { run } = await hybridSetup(embed, store);
    // Zero token overlap with the lexical entry ("rotate the tokens on every
    // refresh") — the rotate hit below is reachable ONLY if BM25 saw the
    // queries; a regression to description-fed BM25 drops it entirely.
    const result = (await run({ description: "kitten napping sunny spot", queries: ["rotate", "tokens"] }, ctx)) as {
      content: Array<{ text: string }>;
    };
    // The embedding model received the natural-language description…
    expect(embed.calls.queries[0]).toBe("kitten napping sunny spot");
    // …BM25 received only the keywords, and the cat entry surfaces via
    // vectors only (its terms match neither query).
    expect(result.content[0].text).toContain("rotate");
    expect(result.content[0].text).toContain("Fluffy");
    expect(result.content[0].text).toContain("· sem");
  });

  it("with no queries, the description feeds both sides", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, fakeVectorStore());
    const result = (await run({ description: "rotate tokens" }, ctx)) as { content: Array<{ text: string }> };
    expect(embed.calls.queries[0]).toBe("rotate tokens");
    expect(result.content[0].text).toContain("rotate");
  });

  it("with no description, the joined queries feed both sides", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, fakeVectorStore());
    const result = (await run({ queries: ["rotate", "tokens"] }, ctx)) as { content: Array<{ text: string }> };
    expect(embed.calls.queries[0]).toBe("rotate tokens");
    expect(result.content[0].text).toContain("rotate");
  });

  it("blank queries and blank description degrade gracefully", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam({ queryVector: vec(1) });
    const { run } = await hybridSetup(embed, fakeVectorStore());
    // All-blank queries after trim/filter → same as omitted → description feeds both.
    const blanks = (await run({ description: "rotate tokens", queries: ["  ", ""] }, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(blanks.content[0].text).toContain("rotate");
    expect(embed.calls.queries[0]).toBe("rotate tokens");
    // A blank entry among real ones is dropped, not fatal.
    const mixed = (await run({ queries: ["", "rotate tokens"] }, ctx)) as { content: Array<{ text: string }> };
    expect(mixed.content[0].text).toContain("rotate");
    expect(embed.calls.queries[0]).toBe("rotate tokens");
    // Whitespace-only description with no queries → the required-arg error.
    const empty = (await run({ description: "   " }, ctx)) as { content: Array<{ text: string }> };
    expect(empty.content[0].text).toContain("Error: description (or queries) is required");
  });
});

describe("embedding catch-up wiring", () => {
  function catchUpSetup(
    configOverrides: Partial<RecallConfig> = {},
    reader: ProjectReader = fsProjectReader,
    seed: Array<{ key: string; vector: Float32Array }> = [],
  ) {
    const store = fakeVectorStore(seed);
    const embed = fakeEmbedSeam();
    const openedFiles: string[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, { ...CONFIG, embedEnabled: true, ...configOverrides } as RecallConfig, reader, {
      embed,
      openStore: async (file) => {
        openedFiles.push(file);
        return store;
      },
    });
    return { events, store, embed, openedFiles };
  }

  it("session_start opens the store, starts the worker, and embeds archived chunks", async () => {
    const { ctx, semantic, lexical } = hybridCtx();
    const { events, store, embed, openedFiles } = catchUpSetup();
    await fire(events, "session_start", ctx);
    await flush();
    expect(openedFiles).toEqual([`${ctx.sessionManager.getSessionDir()}/recall-vectors.bin`]);
    expect(embed.calls.started).toBe(1);
    const embeddedTexts = embed.calls.embeds[0].map((i) => i.text);
    expect(embeddedTexts.some((t) => t.includes("Fluffy"))).toBe(true);
    expect(embeddedTexts.some((t) => t.includes("rotate"))).toBe(true);
    expect(store.calls.added).toHaveLength(embed.calls.embeds[0].length);
    expect(embed.calls.embeds[0].some((i) => i.key === firstKey(semantic))).toBe(true);
    expect(embed.calls.embeds[0].some((i) => i.key === firstKey(lexical))).toBe(true);
  });

  it("a settle after everything is cached embeds nothing new", async () => {
    const { ctx } = hybridCtx();
    const { events, embed } = catchUpSetup();
    await fire(events, "session_start", ctx);
    await flush();
    await fire(events, "agent_settled", ctx);
    await flush();
    expect(embed.calls.embeds).toHaveLength(1); // only the session_start round
  });

  it("a failed embed round retries on the next settle", async () => {
    const { ctx } = hybridCtx();
    const { events, embed, store } = catchUpSetup();
    embed.state.failEmbed = true;
    await fire(events, "session_start", ctx);
    await flush();
    expect(store.calls.added).toHaveLength(0);
    embed.state.failEmbed = false;
    await fire(events, "agent_settled", ctx);
    await flush();
    expect(store.calls.added.length).toBeGreaterThan(0);
  });

  it("store open failure disables the semantic side without breaking search", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx } = hybridCtx();
      const embed = fakeEmbedSeam();
      const { pi, events, tools } = makePi();
      registerRecallTool(pi, { ...CONFIG, embedEnabled: true } as RecallConfig, fsProjectReader, {
        embed,
        openStore: async () => {
          throw new Error("disk full");
        },
      });
      await fire(events, "session_start", ctx);
      await flush();
      expect(embed.calls.started).toBe(0); // spawn only after the store opens
      const result = (await tools
        .get(RECALL_TOOL_NAME)!
        .execute("t", { description: "rotate tokens" }, undefined, undefined, ctx)) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0].text).toContain("rotate");
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("a ctx staled mid-session_start by a session replacement does not break catch-up", async () => {
    // pi -p forks the latest session in the cwd: session_start fires, the
    // replacement invalidates the ctx facade, and the async catch-up chain
    // used to touch ctx after an await and throw staleness. The manager is
    // captured synchronously, so a ctx that goes stale immediately after the
    // handler body must not break the round.
    const base = hybridCtx();
    let stale = false;
    const ctx = {
      ...base.ctx,
      get sessionManager() {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        return base.ctx.sessionManager;
      },
    };
    const { events, store, embed } = catchUpSetup();
    await fire(events, "session_start", ctx);
    stale = true; // replacement lands while openStore is still in flight
    await flush();
    expect(store.calls.added.length).toBeGreaterThan(0);
    expect(embed.calls.started).toBe(1);
  });

  it("session_shutdown kills the worker and closes the store exactly once", async () => {
    const { ctx } = hybridCtx();
    const { events, embed, store } = catchUpSetup();
    await fire(events, "session_start", ctx);
    await flush();
    await fire(events, "session_shutdown", ctx);
    await fire(events, "session_shutdown", ctx);
    expect(embed.calls.killed).toBe(1);
    expect(store.calls.closed).toBe(1);
  });

  it("a replacement session_start tears down the previous store and respawns", async () => {
    const { ctx } = hybridCtx();
    const embed = fakeEmbedSeam();
    const first = fakeVectorStore();
    const second = fakeVectorStore(); // one store per session dir
    let openCount = 0;
    const { pi, events } = makePi();
    registerRecallTool(pi, { ...CONFIG, embedEnabled: true } as RecallConfig, fsProjectReader, {
      embed,
      openStore: async () => (openCount++ === 0 ? first : second),
    });
    await fire(events, "session_start", ctx);
    await flush();
    await fire(events, "session_start", ctx); // new/resume/fork in the same process
    await flush();
    expect(first.calls.closed).toBe(1); // replaced session's handle closed, not leaked
    expect(second.calls.closed).toBe(0); // the new session's store stays open
    expect(embed.calls.killed).toBe(1); // old worker killed…
    expect(embed.calls.started).toBe(2); // ...and a fresh one spawned
    expect(embed.calls.embeds).toHaveLength(2); // both sessions ran catch-up
  });

  it("embeds foreign sessions within the byte budget, newest first", async () => {
    const f1 = sessionFile({ entries: [userLine("foreign embed me please")] });
    const { reader, dir } = fakeReader([f1]);
    const { ctx } = hybridCtx();
    const withDir = sessionCtx({
      branch: ctx.sessionManager.getBranch(),
      contextEntries: [ctx.sessionManager.getBranch()[2], ctx.sessionManager.getBranch()[3]],
      sessionDir: dir,
      sessionFile: `${dir}/current.jsonl`,
    });

    // Budget 0: current session only.
    const zero = catchUpSetup({ defaultScope: "project", embedForeignMaxBytes: 0 }, reader);
    await fire(zero.events, "session_start", withDir);
    await flush();
    expect(zero.embed.calls.embeds[0].some((i) => i.text.includes("foreign embed me"))).toBe(false);

    // Budget allows the foreign file: its chunks join the queue.
    const budgeted = catchUpSetup({ defaultScope: "project", embedForeignMaxBytes: 1024 * 1024 }, reader);
    await fire(budgeted.events, "session_start", withDir);
    await flush();
    expect(budgeted.embed.calls.embeds[0].some((i) => i.text.includes("foreign embed me"))).toBe(true);
  });

  it("compaction keeps the full corpus view, not the embed budget", async () => {
    const sid = "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd";
    const foreignText = "foreign chunk beyond the embed budget but inside the corpus view ".repeat(40); // <chunkChars, single chunk
    const line = userLine(foreignText); // one id for both the file and the key derivation
    const f1 = sessionFile({ id: sid, entries: [line] }); // ~2.9KB file: alone exceeds a 1KB embed budget
    const { reader, dir } = fakeReader([f1]);
    const { ctx } = hybridCtx();
    const withDir = sessionCtx({
      branch: ctx.sessionManager.getBranch(),
      contextEntries: [ctx.sessionManager.getBranch()[2], ctx.sessionManager.getBranch()[3]],
      sessionDir: dir,
      sessionFile: `${dir}/current.jsonl`,
    });
    const foreignEntry = JSON.parse(line) as { id: string };
    const foreignKey = chunkKey(sid, foreignEntry.id, 0, 0, foreignText);
    const deadKey = "0123456789abcdef0123456789abcdef"; // a deleted session's vector
    const setup = catchUpSetup({ defaultScope: "project", embedForeignMaxBytes: 1024 }, reader, [
      { key: foreignKey, vector: vec(1) },
      { key: deadKey, vector: vec(1) },
    ]);
    await fire(setup.events, "session_start", withDir);
    await flush();
    // The budget skipped the foreign file for embedding…
    expect(setup.embed.calls.embeds.flat().some((i) => i.key === foreignKey)).toBe(false);
    // …but compaction kept its vector anyway, dropped only the dead key, and kept current-session chunks live.
    expect(setup.store.calls.compactions).toHaveLength(1);
    const keep = setup.store.calls.compactions[0];
    expect(keep.has(foreignKey)).toBe(true);
    expect(keep.has(deadKey)).toBe(false);
    expect([...keep].length).toBeGreaterThan(1); // current-session archive chunks are live too
    expect(setup.store.vectors.has(deadKey)).toBe(false);
    expect(setup.store.vectors.has(foreignKey)).toBe(true);
  });

  it("a corpus refresh failure skips compaction without breaking the session", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f1 = sessionFile({ entries: [userLine("foreign text")] });
      const { reader } = fakeReader([f1]);
      reader.listJsonlFiles = async () => {
        throw new Error("dir gone");
      };
      const { ctx } = hybridCtx();
      const setup = catchUpSetup({ defaultScope: "project" }, reader, [{ key: "0".repeat(32), vector: vec(1) }]);
      await fire(setup.events, "session_start", ctx);
      await flush();
      expect(setup.store.calls.compactions).toHaveLength(0); // fail open, no rewrite
      expect(setup.embed.calls.embeds.length).toBeGreaterThanOrEqual(1); // catch-up still ran
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("session scope never compacts — its corpus view would drop every foreign vector", async () => {
    const f1 = sessionFile({ entries: [userLine("foreign vector kept through a session-scope detour")] });
    const { reader, dir } = fakeReader([f1]);
    const { ctx } = hybridCtx();
    const withDir = sessionCtx({
      branch: ctx.sessionManager.getBranch(),
      contextEntries: [ctx.sessionManager.getBranch()[2], ctx.sessionManager.getBranch()[3]],
      sessionDir: dir,
      sessionFile: `${dir}/current.jsonl`,
    });
    const seeded = catchUpSetup({ defaultScope: "session" }, reader, [{ key: "0".repeat(32), vector: vec(1) }]);
    await fire(seeded.events, "session_start", withDir);
    await flush();
    expect(seeded.store.calls.compactions).toHaveLength(0);
    expect(seeded.store.vectors.has("0".repeat(32))).toBe(true);
  });

  it("skips foreign embedding when the scope is session-only", async () => {
    const f1 = sessionFile({ entries: [userLine("never embed foreign")] });
    const { reader, dir } = fakeReader([f1]);
    const { ctx } = hybridCtx();
    const withDir = sessionCtx({
      branch: ctx.sessionManager.getBranch(),
      contextEntries: [ctx.sessionManager.getBranch()[2], ctx.sessionManager.getBranch()[3]],
      sessionDir: dir,
      sessionFile: `${dir}/current.jsonl`,
    });
    const { events, embed } = catchUpSetup({ embedForeignMaxBytes: 1024 * 1024 }, reader); // scope stays "session"
    await fire(events, "session_start", withDir);
    await flush();
    expect(embed.calls.embeds[0].some((i) => i.text.includes("never embed foreign"))).toBe(false);
  });
});

describe("semantic ranking policy", () => {
  const policy = { foreignWeight: 0.5, halfLifeHours: 4, recencyFloor: 0.25, embedWeight: 0.7 };

  function chunked(text: string, timestamp: string, origin: "current" | "foreign" = "current"): RecallChunk {
    return {
      ref: "r",
      entryId: "e",
      key: chunkKey(SID, "e", 0, 0, text),
      origin,
      sessionLabel: origin === "current" ? "current session" : "past session",
      kind: "user",
      timestamp,
      text,
    };
  }

  it("semanticRankedKeys down-weights foreign and decayed chunks", () => {
    const now = "2026-05-01T12:00:00Z";
    const current = chunked("current discussion", now);
    const foreign = chunked("foreign discussion", now, "foreign");
    const old = chunked("old discussion", "2026-05-01T04:00:00Z"); // 8h old: past several half-lives
    const byKey = new Map([current, foreign, old].map((c) => [c.key, c]));
    const hits = [
      { key: foreign.key, similarity: 0.8 },
      { key: old.key, similarity: 0.9 },
      { key: current.key, similarity: 0.5 },
    ];
    const ranked = semanticRankedKeys(hits, byKey, policy, Date.parse(now));
    // current: 0.5×1; foreign: 0.8×0.5=0.4; old: 0.9×0.25(floor)≈0.225 — raw order reversed.
    expect(ranked[0]).toBe(current.key);
    expect(ranked[1]).toBe(foreign.key);
    expect(ranked[2]).toBe(old.key);
  });

  it("fuseHybrid returns the lexical ranking untouched without semantic keys", () => {
    const lexical = rankChunks([chunked("alpha beta", "2026-05-01T12:00:00Z")], "alpha", 0.5);
    const out = fuseHybrid(lexical, [], new Map(), policy, 0);
    expect(out.map((r) => r.chunk.key)).toEqual(lexical.map((r) => r.chunk.key));
    expect(out.every((r) => r.sides === undefined)).toBe(true);
  });

  it("fuseHybrid carries provenance and lexical rawScores", () => {
    const c = chunked("alpha beta", "2026-05-01T12:00:00Z");
    const byKey = new Map([[c.key, c]]);
    const lexical = rankChunks([c], "alpha", 0.5);
    const fused = fuseHybrid(lexical, [c.key], byKey, policy, Date.parse("2026-05-01T12:00:00Z"));
    expect(fused[0].sides).toBe("both");
    expect(fused[0].rawScore).toBe(lexical[0].rawScore);
    // Keys not in the corpus are dropped, not fatal.
    expect(fuseHybrid(lexical, ["missing-key"], byKey, policy, 0)).toHaveLength(1);
  });
});

describe("chunk key identity", () => {
  it("is stable across the current→foreign session transition", () => {
    const entry = msgEntry("user", { content: "the exact same text" });
    const current = chunksFromEntry(
      entry,
      { origin: "current", sessionId: SID, sessionLabel: "current session" },
      3000,
    );
    const foreign = chunksFromEntry(
      entry,
      { origin: "foreign", sessionId: SID, sessionLabel: "past session later" },
      3000,
    );
    expect(current[0].key).toBe(foreign[0].key);
  });
});

describe("embed config", () => {
  it("defaults to enabled q8 with a 0.7 fusion weight", () => {
    const config = configFromEnv({});
    expect(config.embedEnabled).toBe(true);
    expect(config.embedDtype).toBe("q8");
    expect(config.embedWeight).toBe(0.15);
    expect(config.embedForeignMaxBytes).toBe(32 * 1024 * 1024);
    expect(config.embedModelDir).toBe(`${process.env.HOME}/.pi/agent/models`);
  });

  it("PI_RECALL_EMBED=0 disables the semantic side", () => {
    expect(configFromEnv({ PI_RECALL_EMBED: "0" }).embedEnabled).toBe(false);
  });

  it("PI_RECALL_EMBED_WEIGHT defaults to the binary-tuned 0.15 and clamps", () => {
    expect(configFromEnv({}).embedWeight).toBe(0.15);
    expect(configFromEnv({ PI_RECALL_EMBED_WEIGHT: "0.4" }).embedWeight).toBe(0.4);
    expect(configFromEnv({ PI_RECALL_EMBED_WEIGHT: "9" }).embedWeight).toBe(2);
  });

  it("invalid dtype falls back with an explicit error; weights clamp", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(configFromEnv({ PI_RECALL_EMBED_DTYPE: "int4" }).embedDtype).toBe("q8");
      expect(configFromEnv({ PI_RECALL_EMBED_DTYPE: "fp16" }).embedDtype).toBe("fp16");
      expect(configFromEnv({ PI_RECALL_EMBED_WEIGHT: "9" }).embedWeight).toBe(2);
      expect(configFromEnv({ PI_RECALL_EMBED_MAX_MB: "0" }).embedForeignMaxBytes).toBe(0);
      expect(configFromEnv({ PI_RECALL_MODEL_DIR: "/custom/models" }).embedModelDir).toBe("/custom/models");
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe("renderers", () => {
  const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as never;

  it("call row shows the description (or joined queries), or read mode", () => {
    expect(renderRecallCall({ description: "token rotation" }, theme)).toContain("token rotation");
    expect(renderRecallCall({ mode: "read", id: "x" }, theme)).toContain("recall read");
    expect(renderRecallCall({ description: 42 }, theme)).not.toContain("42"); // non-string renders bare
    expect(renderRecallCall({ queries: ["rotate", "tokens"] }, theme)).toContain("rotate · tokens");
    expect(renderRecallCall({ description: "   ", queries: ["rotate"] }, theme)).toContain("rotate"); // trimmed
  });

  it("clips long queries in the collapsed call row", () => {
    const row = renderRecallCall({ description: "x".repeat(100) }, theme);
    expect(row).toContain("…");
    expect(row.length).toBeLessThan(100);
  });

  it("registered render adapters reuse the previous Text component in place", () => {
    const { pi, tools } = makePi();
    registerRecallTool(pi, CONFIG);
    const tool = tools.get(RECALL_TOOL_NAME)!;
    const callCtx: { lastComponent?: unknown } = {};
    const first = tool.renderCall!({ description: "auth" } as never, theme as never, callCtx as never);
    expect(first).toBeInstanceOf(Text);
    callCtx.lastComponent = first;
    const second = tool.renderCall!({ description: "tokens" } as never, theme as never, callCtx as never);
    expect(second).toBe(first); // same component object, updated in place
    const resultCtx: { lastComponent?: unknown } = {};
    const resultA = tool.renderResult!(
      { details: { hits: [{ snippet: "a" }] } } as never,
      { expanded: true } as never,
      theme as never,
      resultCtx as never,
    );
    expect(resultA).toBeInstanceOf(Text);
    resultCtx.lastComponent = resultA;
    expect(
      tool.renderResult!(
        { details: { hits: [] } } as never,
        { expanded: true } as never,
        theme as never,
        resultCtx as never,
      ),
    ).toBe(resultA);
  });

  it("result row shows hit count and expands to snippets", () => {
    const collapsed = renderRecallResult(
      { hits: [{ snippet: "abc" }, { snippet: "def" }] },
      { expanded: false },
      theme,
    );
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
    const config = configFromEnv({
      PI_RECALL_SCOPE: "project",
      PI_RECALL_FOREIGN_WEIGHT: "0.8",
      PI_RECALL_MAX_RESULTS: "99",
    });
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
    chunksFromEntry(
      msgEntry("user", { content: text }, iso),
      { origin: "current", sessionId: "s", sessionLabel: "current session" },
      3000,
    )[0];

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
      [
        {
          ref: "a1",
          kind: "user",
          sessionLabel: "current session",
          timestamp: NOW,
          score: 4.2,
          recencyFactor: 0.62,
          snippet: "s",
        },
      ],
      { archiveEntries: 10, foreignSessions: 0, scope: "session", totalMatches: 1 },
    );
    expect(withFactor).toContain("(recency ×0.62)");
    const frontier = formatSearchResult(
      [
        {
          ref: "a1",
          kind: "user",
          sessionLabel: "current session",
          timestamp: NOW,
          score: 4.2,
          recencyFactor: 1,
          snippet: "s",
        },
      ],
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
  it("effectiveCompactTarget picks the smallest of token cap, window ratio, and window headroom", () => {
    expect(effectiveCompactTarget(256_000, 400_000)).toBe(256_000); // token cap wins: 70% is 280k
    expect(effectiveCompactTarget(256_000, 200_000)).toBe(140_000); // ratio wins: 70% is 140k
    expect(effectiveCompactTarget(131_072, 100_000)).toBe(70_000); // ratio beats window headroom
    expect(effectiveCompactTarget(131_072, 200_000)).toBe(131_072); // explicit cap below ratio bound
    expect(effectiveCompactTarget(131_072, 100_000, 0)).toBe(95_904); // ratio off: window-bound
    expect(effectiveCompactTarget(500_000, 200_000, 0)).toBe(195_904); // big target clamps to window
    expect(effectiveCompactTarget(256_000, 200_000, 1)).toBe(195_904); // ratio 1: headroom wins
    expect(effectiveCompactTarget(256_000, 200_000, Number.NaN)).toBe(195_904); // nonsense ratio: ignored
    expect(effectiveCompactTarget(100_000, 1_000_000)).toBe(100_000); // huge window: cap wins over 700k
    expect(effectiveCompactTarget(0, 200_000)).toBeUndefined(); // disabled
    expect(effectiveCompactTarget(131_072, 4096)).toBeUndefined(); // window nonsense
    expect(effectiveCompactTarget(131_072, 0)).toBeUndefined();
  });

  it("effectiveCompactTarget disables targets one compaction could never reach", () => {
    // The kept tail alone (pi default 20k) plus headroom sets the floor.
    const floor = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens + 4_096;
    expect(effectiveCompactTarget(floor, 1_000_000)).toBe(floor); // exactly at the floor: achievable
    expect(effectiveCompactTarget(floor - 1, 1_000_000)).toBeUndefined(); // below: would re-draft forever
    expect(effectiveCompactTarget(131_072, 20_000)).toBeUndefined(); // tiny window: every bound unachievable
    expect(effectiveCompactTarget(131_072, 4097)).toBeUndefined(); // boundary: just above headroom, still unachievable
  });

  it("shouldAutoCompact gates on tokens, target, ratio, and in-flight state", () => {
    expect(shouldAutoCompact(150_000, 200_000, 131_072, 0.7, false)).toBe(true);
    expect(shouldAutoCompact(100_000, 200_000, 131_072, 0.7, false)).toBe(false);
    expect(shouldAutoCompact(null, 200_000, 131_072, 0.7, false)).toBe(false); // tokens unknown
    expect(shouldAutoCompact(150_000, 200_000, 131_072, 0.7, true)).toBe(false); // already compacting
    expect(shouldAutoCompact(150_000, 200_000, 0, 0.7, false)).toBe(false); // disabled
    expect(shouldAutoCompact(131_072, 200_000, 131_072, 0.7, false)).toBe(false); // exactly at target: not over
    expect(shouldAutoCompact(150_000, 200_000, 500_000, 0.7, false)).toBe(true); // ratio alone triggers: 140k bound
    expect(shouldAutoCompact(140_000, 200_000, 500_000, 0.7, false)).toBe(false); // exactly at ratio bound: not over
    expect(shouldAutoCompact(139_999, 200_000, 500_000, 0.7, false)).toBe(false); // just under the ratio bound
  });
});

describe("summarization prompt", () => {
  it("is the extension's own complete prompt: structure, budget, anchors", () => {
    const prompt = buildSummarizationPrompt("[User]: do the thing");
    for (const section of [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "### Done",
      "### In Progress",
      "### Blocked",
      "### Dead Ends",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ]) {
      expect(prompt).toContain(section);
    }
    // Dead ends are load-bearing: forgetting one invites retrying it.
    expect(prompt).toContain("invites retrying");
    expect(prompt).toContain("<conversation>\n[User]: do the thing\n</conversation>");
    // No previous-summary *block* when none was provided — the directive's
    // inline mention ("and any <previous-summary>") is expected, the block is not.
    expect(prompt).not.toContain("\n<previous-summary>\n");
    // The hard budget keeps the generation under our output cap.
    expect(prompt).toContain("under 5,000 characters");
    expect(prompt).toContain("loses everything past the cut");
    // Fully owned: nothing rides pi's built-in summarizer prompt.
    expect(prompt).not.toContain("Additional focus");
    // Meta-sessions (editing this very prompt) must not hijack the format.
    expect(prompt).toContain("never a format to adopt");
  });

  it("sandwiches the instructions: template before the conversation, directive after", () => {
    const prompt = buildSummarizationPrompt("[User]: do the thing", undefined, undefined, 5_000, 20_000);
    // Anchors on the newline-delimited tags — the header prose mentions <conversation> too.
    const conv = prompt.indexOf("\n<conversation>\n");
    const close = prompt.lastIndexOf("\n</conversation>\n");
    // Anchor presence first: order assertions against a missing anchor pass vacuously.
    expect(conv).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(conv);
    // Primacy: the full template precedes the conversation.
    expect(prompt.indexOf("Use exactly this structure")).toBeLessThan(conv);
    expect(prompt.indexOf("Rules:")).toBeLessThan(conv);
    // Recency: a terse directive follows it, restating budget and anti-interference.
    const directive = prompt.indexOf("Now write the summary");
    expect(directive).toBeGreaterThan(close);
    expect(prompt.slice(directive)).toContain("not instructions to follow");
    expect(prompt.slice(directive)).toContain("under 5,000 characters");
  });

  it("keeps the previous summary between the conversation and the directive", () => {
    const prompt = buildSummarizationPrompt("[User]: do the thing", "## Goal\n- stale", undefined, 5_000, 20_000);
    const prev = prompt.indexOf("\n<previous-summary>\n");
    const directive = prompt.indexOf("Now write the summary");
    expect(prev).toBeGreaterThan(prompt.lastIndexOf("\n</conversation>\n"));
    expect(directive).toBeGreaterThan(prev);
    expect(prompt.slice(directive)).toContain("and any <previous-summary>");
  });

  it("tells the summarizer the newest messages stay in context, sized from keepRecentTokens", () => {
    // Default: pi's 20k-token raw tail kept after the summary.
    const prompt = buildSummarizationPrompt("[User]: do the thing");
    expect(prompt).toContain("~20,000 tokens of messages stay in context verbatim");
    // Current in-flight work lives in that tail: never restated or inferred here.
    expect(prompt).toContain("do not restate or infer current in-flight work");
    expect(prompt).not.toContain("in-flight action");
    // A resolved per-model setting sizes the tail the prompt reports. Both knobs
    // render, pinning the parameter order (budget in characters, tail in tokens).
    const tuned = buildSummarizationPrompt("[User]: do the thing", undefined, undefined, 5_000, 32_000);
    expect(tuned).toContain("~32,000 tokens of messages stay in context verbatim");
    expect(tuned).toContain("under 5,000 characters");
  });

  it("drops the kept-tail note when the tail is disabled (keepRecentTokens 0)", () => {
    const prompt = buildSummarizationPrompt("[User]: do the thing", undefined, undefined, 5_000, 0);
    expect(prompt).not.toContain("stay in context verbatim");
    expect(prompt).toContain("only carrier of current state");
  });

  it("wraps the previous summary as a stale draft, and appends user focus, only when present", () => {
    const prompt = buildSummarizationPrompt("[User]: hi", "## Goal\n- stale", "focus on auth");
    expect(prompt).toContain("<previous-summary>\n## Goal\n- stale\n</previous-summary>");
    expect(prompt).toContain("User focus for this compaction: focus on auth");
  });
});

describe("length-stopped summary salvage", () => {
  const MARKER = "[summary truncated at the output cap — use recall for missing detail]";

  it("rejects a partial too small to be a map", () => {
    expect(salvageLengthStoppedSummary("partial", 5_000)).toBeNull();
    // Exactly at the floor (25% of budget) is enough; one under is not.
    expect(salvageLengthStoppedSummary("x".repeat(1_250), 5_000)).not.toBeNull();
    expect(salvageLengthStoppedSummary("x".repeat(1_249), 5_000)).toBeNull();
    expect(salvageLengthStoppedSummary("", 5_000)).toBeNull();
  });

  it("accepts an in-budget partial verbatim, marked as truncated", () => {
    const partial = "## Goal\n- " + "x".repeat(2_000);
    const salvaged = salvageLengthStoppedSummary(partial, 5_000)!;
    expect(salvaged.startsWith(partial)).toBe(true);
    expect(salvaged.endsWith(`\n\n${MARKER}`)).toBe(true);
  });

  it("trims an over-budget partial at a line boundary inside the budget", () => {
    const partial = ["## Goal", "- line one", "- line two", "- line three"]
      .concat(Array.from({ length: 200 }, (_, i) => `- filler ${i} ${"y".repeat(40)}`))
      .join("\n");
    const salvaged = salvageLengthStoppedSummary(partial, 5_000)!;
    expect(salvaged.length).toBeLessThanOrEqual(5_000);
    expect(salvaged.endsWith(`\n\n${MARKER}`)).toBe(true);
    // The cut lands between lines: every retained line is an exact member of
    // the original (a mid-line hard cut would leave a prefix line — a substring
    // `toContain` would miss it, set membership catches it).
    const partialLines = partial.split("\n");
    const body = salvaged.slice(0, salvaged.indexOf("\n\n[summary truncated"));
    for (const line of body.split("\n")) expect(partialLines).toContain(line);
    // The head of the map survives the trim.
    expect(body.startsWith("## Goal\n- line one")).toBe(true);
  });

  it("hard-cuts when the over-budget window has no line boundary", () => {
    const salvaged = salvageLengthStoppedSummary("z".repeat(9_000), 5_000)!;
    expect(salvaged.length).toBeLessThanOrEqual(5_000);
    expect(salvaged.endsWith(`\n\n${MARKER}`)).toBe(true);
  });
});

describe("file-list carry-forward", () => {
  const ops = (read: string[], written: string[], edited: string[]) => ({
    read: new Set(read),
    written: new Set(written),
    edited: new Set(edited),
  });

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
    expect(lastCompactionDetails([c1, msgEntry("user", { content: "hi" }), c2])).toEqual({
      readFiles: ["two.txt"],
      modifiedFiles: [],
    });
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
    // The trigger passes no customInstructions: summary ownership lives in the hook.
    expect(compactCalls[0].customInstructions).toBeUndefined();
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
    await fire(events, "session_compact_failed", undefined, {
      type: "session_compact_failed",
      reason: "threshold",
      errorMessage: "summarizer blew up",
      aborted: false,
    });
    await fire(events, "session_compact_failed", undefined, {
      type: "session_compact_failed",
      reason: "manual",
      aborted: true,
    });
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
        messagesToSummarize: [{ role: "user", content: "older-span work" }],
        turnPrefixMessages: [{ role: "user", content: "split turn prefix" }],
        isSplitTurn: true,
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

  interface CapturedCall {
    model: unknown;
    context: { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
    options: Record<string, unknown>;
  }

  function hookCtx(
    complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      model: { id: "test-model", reasoning: false },
      modelRegistry: {
        complete:
          complete ??
          (async () => {
            throw new Error("complete must be provided");
          }),
      },
      thinkingLevel: undefined,
      ...overrides,
    };
  }

  function okComplete(calls: CapturedCall[]) {
    return async (model: unknown, context: unknown, options?: unknown) => {
      calls.push({
        model,
        context: context as CapturedCall["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      return {
        content: [{ type: "text", text: "## Goal\n- Recall-aware summary" }],
        usage: { totalTokens: 42 },
        stopReason: "stop",
      };
    };
  }

  /** A todo tool-result snapshot on the branch, as the todo extension records it. */
  function todoSnapshotEntry(todos: Array<{ content: string; status: string }>) {
    return msgEntry("toolResult", { toolName: TODO_TOOL_NAME, details: { todos } });
  }

  it("generates the summary with the extension's own prompt via modelRegistry.complete", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG); // default summarize path
    const result = (await fire(events, "session_before_compact", hookCtx(okComplete(calls)), beforeCompactEvent())) as {
      compaction: Record<string, unknown>;
    };
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.model).toEqual({ id: "test-model", reasoning: false });
    // One user message carrying the whole prompt: serialized conversation is
    // chronological (older spans, then the split-turn prefix), previous summary
    // wrapped as a stale draft, our section structure inside.
    expect(call.context.messages).toHaveLength(1);
    expect(call.context.messages[0].role).toBe("user");
    const prompt = call.context.messages[0].content[0].text;
    expect(prompt.indexOf("older-span work")).toBeLessThan(prompt.indexOf("split turn prefix"));
    expect(prompt).toContain("<previous-summary>\n## Goal\n- Earlier\n</previous-summary>");
    expect(prompt).toContain("## Next Steps");
    expect(prompt).toContain("under 5,000 characters");
    // pi's own summarizer conventions: one-off prompt (no cache writes), bounded
    // output, fresh routing id, abortable.
    expect(call.options.maxTokens).toBe(24_576);
    expect(call.options.cacheRetention).toBe("none");
    expect(call.options.sessionId).toEqual(expect.any(String));
    expect(call.options.signal).toBe(SIGNAL);
    expect(call.options.reasoning).toBeUndefined();
    expect(result.compaction.summary).toBe("## Goal\n- Recall-aware summary");
    expect(result.compaction.firstKeptEntryId).toBe("kept1");
    expect(result.compaction.tokensBefore).toBe(150_000);
    expect(result.compaction.usage).toEqual({ totalTokens: 42 });
    // Previous compaction entry has no details → lists come from fileOps alone.
    expect(result.compaction.details).toEqual({ readFiles: ["read1.ts"], modifiedFiles: ["wrote1.ts"] });
  });

  it("sizes the prompt's kept-tail note from the resolved compaction settings", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const event = beforeCompactEvent();
    event.preparation.settings.keepRecentTokens = 32_000;
    await fire(events, "session_before_compact", hookCtx(okComplete(calls)), event);
    const prompt = calls[0].context.messages[0].content[0].text;
    expect(prompt).toContain("~32,000 tokens of messages stay in context verbatim");
  });

  it("leaves pi-triggered summaries plan-less — the todo reminder is the carrier", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const branchEntries = [
      todoSnapshotEntry([{ content: "write the fix", status: "completed" }]),
      todoSnapshotEntry([
        { content: "write the fix", status: "completed" },
        { content: "run the tests", status: "in_progress" },
      ]),
    ];
    const result = (await fire(
      events,
      "session_before_compact",
      hookCtx(okComplete(calls)),
      beforeCompactEvent({ branchEntries }),
    )) as { compaction: { summary: string } };

    // The map carries no plan: current state rides separately, after the kept tail.
    const { summary } = result.compaction;
    expect(summary.startsWith("## Goal\n- Recall-aware summary")).toBe(true);
    expect(summary).not.toContain("## Current Plan");
    // Full budget for the map, and the prompt points plan state at its own message.
    const prompt = calls[0].context.messages[0].content[0].text;
    expect(prompt).toContain(`under ${CONFIG.summaryChars.toLocaleString("en-US")} characters`);
    expect(prompt).toContain("re-injected separately after compaction");
  });

  it("leaves the summary unchanged when there is no todo state", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const result = (await fire(
      events,
      "session_before_compact",
      hookCtx(okComplete(calls)),
      beforeCompactEvent({ branchEntries: [compactionEntry("old", "k0"), todoSnapshotEntry([])] }),
    )) as { compaction: { summary: string } };

    expect(result.compaction.summary).toBe("## Goal\n- Recall-aware summary");
    const prompt = calls[0].context.messages[0].content[0].text;
    expect(prompt).toContain("under 5,000 characters");
  });

  it("forwards the pinned thinking level only when the model reasons; 'session' mirrors the session", async () => {
    for (const [knob, model, thinkingLevel, expected] of [
      // Default "high" pins regardless of the session's (possibly low) level.
      ["high", { id: "test-model", reasoning: true }, "off", "high"],
      ["high", { id: "test-model", reasoning: false }, "high", undefined],
      // "session" mirrors the session level; off/absent → unset.
      ["session", { id: "test-model", reasoning: true }, "high", "high"],
      ["session", { id: "test-model", reasoning: true }, "off", undefined],
    ] as const) {
      const calls: CapturedCall[] = [];
      const { pi, events } = makePi();
      registerRecallTool(pi, { ...CONFIG, summaryThinking: knob });
      await fire(
        events,
        "session_before_compact",
        hookCtx(okComplete(calls), { model, thinkingLevel }),
        beforeCompactEvent(),
      );
      expect(calls[0].options.reasoning, `${knob} ${JSON.stringify(model)} @ ${String(thinkingLevel)}`).toBe(expected);
    }
  });

  it("passes /compact focus through as user focus", async () => {
    const calls: unknown[] = [];
    const summarize: SummaryFn = async (args) => {
      calls.push(args);
      return { text: "s", usage: {} };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { summarize });
    await fire(
      events,
      "session_before_compact",
      hookCtx(),
      beforeCompactEvent({ customInstructions: "focus on auth" }),
    );
    expect((calls[0] as { userFocus?: string }).userFocus).toBe("focus on auth");
  });

  it("falls back on a length-stopped generation, leaving a breadcrumb", async () => {
    const crumbs: string[] = [];
    const capped = async () => ({ content: [{ type: "text", text: "partial" }], usage: {}, stopReason: "length" });
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(events, "session_before_compact", hookCtx(capped), beforeCompactEvent())).toBeUndefined();
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: summarizer hit the output cap")]);
  });

  it("commits a salvaged partial on a length-stop instead of skipping compaction", async () => {
    const crumbs: string[] = [];
    const calls: CapturedCall[] = [];
    // A cut mid-generation that still streamed a substantial map: better than
    // no checkpoint (mid-run drafts have no fallback at all).
    const partial = "## Goal\n- " + "x".repeat(2_000);
    const capped = async (model: unknown, context: unknown, options?: unknown) => {
      calls.push({
        model,
        context: context as CapturedCall["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      return { content: [{ type: "text", text: partial }], usage: { totalTokens: 7 }, stopReason: "length" };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    const result = (await fire(events, "session_before_compact", hookCtx(capped), beforeCompactEvent())) as {
      compaction: { summary: string; usage: unknown };
    };
    // Non-reasoning model: no thinking was pinned, so there is nothing to retry —
    // the substantial partial is the checkpoint, marked as truncated.
    expect(calls).toHaveLength(1);
    expect(result.compaction.summary.startsWith(partial)).toBe(true);
    expect(result.compaction.summary).toContain("[summary truncated at the output cap");
    expect(result.compaction.summary.length).toBeLessThanOrEqual(CONFIG.summaryChars);
    expect(result.compaction.usage).toEqual({ totalTokens: 7 });
    expect(crumbs).toEqual([]);
  });

  it("retries a starved length-stop with thinking dropped, then uses the clean retry", async () => {
    const crumbs: string[] = [];
    const calls: CapturedCall[] = [];
    // Reasoning shares the output allocation: the pinned level burned the cap
    // before any text streamed; the retry frees it for summary text.
    const responses = [
      { content: [], usage: {}, stopReason: "length" },
      {
        content: [{ type: "text", text: "## Goal\n- Recovered without thinking" }],
        usage: { totalTokens: 9 },
        stopReason: "stop",
      },
    ];
    const complete = async (model: unknown, context: unknown, options?: unknown) => {
      calls.push({
        model,
        context: context as CapturedCall["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    const result = (await fire(
      events,
      "session_before_compact",
      hookCtx(complete, { model: { id: "test-model", reasoning: true } }),
      beforeCompactEvent(),
    )) as { compaction: { summary: string } };
    expect(calls).toHaveLength(2);
    expect(calls[0].options.reasoning).toBe("high"); // CONFIG pins "high"
    expect(calls[1].options.reasoning).toBeUndefined();
    // A completed generation is used as-is — no truncation marker.
    expect(result.compaction.summary).toBe("## Goal\n- Recovered without thinking");
    expect(crumbs).toEqual([]);
  });

  it("salvages the thinking-free retry when it also length-stops", async () => {
    const crumbs: string[] = [];
    const calls: CapturedCall[] = [];
    const substantial = "## Progress\n- " + "x".repeat(1_500);
    const responses = [
      { content: [{ type: "text", text: "tiny" }], usage: {}, stopReason: "length" },
      { content: [{ type: "text", text: substantial }], usage: { totalTokens: 11 }, stopReason: "length" },
    ];
    const complete = async (model: unknown, context: unknown, options?: unknown) => {
      calls.push({
        model,
        context: context as CapturedCall["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    const result = (await fire(
      events,
      "session_before_compact",
      hookCtx(complete, { model: { id: "test-model", reasoning: true } }),
      beforeCompactEvent(),
    )) as { compaction: { summary: string } };
    expect(calls).toHaveLength(2);
    expect(result.compaction.summary.startsWith(substantial)).toBe(true);
    expect(result.compaction.summary).toContain("[summary truncated at the output cap");
    expect(crumbs).toEqual([]);
  });

  it("still falls back when both the partial and the thinking-free retry come up empty", async () => {
    const crumbs: string[] = [];
    const calls: CapturedCall[] = [];
    const capped = async (model: unknown, context: unknown, options?: unknown) => {
      calls.push({
        model,
        context: context as CapturedCall["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      return { content: [{ type: "text", text: "tiny" }], usage: {}, stopReason: "length" };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(
      await fire(
        events,
        "session_before_compact",
        hookCtx(capped, { model: { id: "test-model", reasoning: true } }),
        beforeCompactEvent(),
      ),
    ).toBeUndefined();
    expect(calls).toHaveLength(2); // pinned-level attempt, then the thinking-free retry
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: summarizer hit the output cap")]);
  });

  it("falls back on a resolved error completion, keeping its message — even with partial text", async () => {
    const crumbs: string[] = [];
    // complete() resolves (never rejects) provider failures, keeping partial content —
    // that text must never become the session checkpoint.
    const errored = async () => ({
      content: [{ type: "text", text: "truncated mid-sentence" }],
      usage: {},
      stopReason: "error",
      errorMessage: "500 upstream",
    });
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(events, "session_before_compact", hookCtx(errored), beforeCompactEvent())).toBeUndefined();
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: 500 upstream")]);
  });

  it("falls back on a resolved aborted completion, staying silent (user cancel)", async () => {
    const crumbs: string[] = [];
    const controller = new AbortController();
    controller.abort();
    // A real cancel aborts the signal, and complete() then resolves aborted.
    const aborted = async () => ({ content: [], usage: {}, stopReason: "aborted", errorMessage: "aborted" });
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(
      await fire(events, "session_before_compact", hookCtx(aborted), beforeCompactEvent({ signal: controller.signal })),
    ).toBeUndefined();
    expect(crumbs).toEqual([]);
  });

  it("falls back when the model emits a tool call instead of a summary", async () => {
    const crumbs: string[] = [];
    const tooling = async () => ({
      content: [{ type: "toolCall", id: "t1", tool: "recall", args: {} }],
      usage: {},
      stopReason: "toolUse",
    });
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(events, "session_before_compact", hookCtx(tooling), beforeCompactEvent())).toBeUndefined();
    expect(crumbs).toEqual([
      expect.stringContaining("fell back to pi default: Summarization attempted to call a tool"),
    ]);
  });

  it("plumbs the configured character budget into the prompt", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, { ...CONFIG, summaryChars: 3_000 });
    await fire(events, "session_before_compact", hookCtx(okComplete(calls)), beforeCompactEvent());
    const prompt = (calls[0].context.messages[0].content as { type: string; text: string }[])[0].text;
    expect(prompt).toContain("under 3,000 characters");
  });

  it("retries a transient provider failure in place and keeps ownership", async () => {
    const crumbs: string[] = [];
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) return { content: [], usage: {}, stopReason: "error", errorMessage: "connection error" };
      return { content: [{ type: "text", text: "our summary" }], usage: {}, stopReason: "stop" };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l), retryDelayMs: 0 });
    const result = (await fire(events, "session_before_compact", hookCtx(flaky), beforeCompactEvent())) as {
      compaction: { summary: string };
    };
    expect(calls).toBe(2);
    expect(result.compaction.summary).toBe("our summary");
    expect(crumbs).toEqual([]);
  });

  it("gives up after three transient attempts and falls back with a crumb", async () => {
    const crumbs: string[] = [];
    let calls = 0;
    const alwaysDown = async () => {
      calls++;
      return { content: [], usage: {}, stopReason: "error", errorMessage: "connection error" };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l), retryDelayMs: 0 });
    expect(await fire(events, "session_before_compact", hookCtx(alwaysDown), beforeCompactEvent())).toBeUndefined();
    expect(calls).toBe(3);
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: connection error")]);
  });

  it("does not retry deterministic failures (output cap)", async () => {
    const crumbs: string[] = [];
    let calls = 0;
    const capped = async () => {
      calls++;
      return { content: [{ type: "text", text: "partial" }], usage: {}, stopReason: "length" };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l), retryDelayMs: 0 });
    expect(await fire(events, "session_before_compact", hookCtx(capped), beforeCompactEvent())).toBeUndefined();
    expect(calls).toBe(1);
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: summarizer hit the output cap")]);
  });

  it("does not retry custom summarize seams (unflagged errors)", async () => {
    const crumbs: string[] = [];
    let calls = 0;
    const summarize: SummaryFn = async () => {
      calls++;
      throw new Error("custom seam failure");
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, {
      summarize,
      logCompactionError: (l) => crumbs.push(l),
      retryDelayMs: 0,
    });
    expect(await fire(events, "session_before_compact", hookCtx(), beforeCompactEvent())).toBeUndefined();
    expect(calls).toBe(1);
    expect(crumbs).toEqual([expect.stringContaining("fell back to pi default: custom seam failure")]);
  });

  it("clamps maxTokens to the model's declared output cap", async () => {
    const calls: CapturedCall[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    await fire(
      events,
      "session_before_compact",
      hookCtx(okComplete(calls), { model: { id: "small-model", reasoning: false, maxTokens: 2048 } }),
      beforeCompactEvent(),
    );
    expect(calls[0].options.maxTokens).toBe(2048);
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
    expect(
      await fire(c.events, "session_before_compact", { ...hookCtx(), model: undefined }, beforeCompactEvent()),
    ).toBeUndefined();

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
    registerRecallTool(d.pi, { ...CONFIG, ownSummaries: false }, undefined, {
      summarize: never,
      logCompactionError: (l) => quiet.push(l),
    });
    expect(await fire(d.events, "session_before_compact", hookCtx(), beforeCompactEvent())).toBeUndefined();
    expect(quiet).toEqual([]);
  });

  it("stays silent on an aborted signal (user cancel, not a failure)", async () => {
    const crumbs: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const failing: SummaryFn = async () => {
      throw new Error("aborted mid-flight");
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { summarize: failing, logCompactionError: (l) => crumbs.push(l) });
    expect(
      await fire(events, "session_before_compact", hookCtx(), beforeCompactEvent({ signal: controller.signal })),
    ).toBeUndefined();
    expect(crumbs).toEqual([]);
  });

  it("config parses the budget knobs", () => {
    expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "60000" }).compactTargetTokens).toBe(60000);
    expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "0" }).compactTargetTokens).toBe(0);
    expect(configFromEnv({ PI_RECALL_COMPACT_TARGET: "nope" }).compactTargetTokens).toBe(256_000);
    expect(configFromEnv({ PI_RECALL_COMPACT_RATIO: "0.8" }).compactTargetRatio).toBe(0.8);
    expect(configFromEnv({ PI_RECALL_COMPACT_RATIO: "0" }).compactTargetRatio).toBe(0); // ratio off
    expect(configFromEnv({ PI_RECALL_COMPACT_RATIO: "3" }).compactTargetRatio).toBe(1); // clamped
    expect(configFromEnv({ PI_RECALL_COMPACT_RATIO: "nope" }).compactTargetRatio).toBe(0.7); // invalid → default
    expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "0" }).ownSummaries).toBe(false);
    expect(configFromEnv({ PI_RECALL_COMPACT_OWN: "nope" }).ownSummaries).toBe(true); // invalid → default with warning
  });

  it("config parses the summary-thinking knob", () => {
    // Default off: no thinking requested — the sandwich layout carries template
    // adherence at 0 reasoning tokens, so the whole output cap is summary text.
    expect(configFromEnv({}).summaryThinking).toBe("off");
    expect(configFromEnv({ PI_RECALL_SUMMARY_THINKING: "session" }).summaryThinking).toBe("session");
    expect(configFromEnv({ PI_RECALL_SUMMARY_THINKING: "off" }).summaryThinking).toBe("off");
    expect(configFromEnv({ PI_RECALL_SUMMARY_THINKING: "low" }).summaryThinking).toBe("low");
    expect(configFromEnv({ PI_RECALL_SUMMARY_THINKING: "HIGH" }).summaryThinking).toBe("high");
    expect(configFromEnv({ PI_RECALL_SUMMARY_THINKING: "turbo" }).summaryThinking).toBe("off"); // invalid → default
  });

  it("config parses the summary character budget", () => {
    expect(configFromEnv({}).summaryChars).toBe(5_000);
    expect(configFromEnv({ PI_RECALL_SUMMARY_CHARS: "3000" }).summaryChars).toBe(3_000);
    expect(configFromEnv({ PI_RECALL_SUMMARY_CHARS: "10" }).summaryChars).toBe(500); // clamped
    expect(configFromEnv({ PI_RECALL_SUMMARY_CHARS: "999999" }).summaryChars).toBe(20_000); // clamped
  });

  it("pins the summarization thinking level independently of the session", async () => {
    const cases = [
      ["off", { id: "test-model", reasoning: true }, "off"],
      ["low", { id: "test-model", reasoning: true }, "low"],
      // Explicit "session" mirrors whatever the session runs.
      ["session", { id: "test-model", reasoning: true }, "high"],
    ] as const;
    for (const [knob, model, expectedLevel] of cases) {
      const calls: unknown[] = [];
      const summarize: SummaryFn = async (args) => {
        calls.push(args);
        return { text: "s", usage: {} };
      };
      const { pi, events } = makePi();
      registerRecallTool(pi, { ...CONFIG, summaryThinking: knob }, undefined, { summarize });
      await fire(
        events,
        "session_before_compact",
        { ...hookCtx(), model, thinkingLevel: "high" },
        beforeCompactEvent(),
      );
      expect((calls[0] as { thinkingLevel?: string }).thinkingLevel, knob).toBe(expectedLevel);
    }
    // Default pins "high" even when the session runs "low" — a low-effort
    // summarizer freestyles the template on long inputs (measured on glm-5.3).
    const calls: unknown[] = [];
    const summarize: SummaryFn = async (args) => {
      calls.push(args);
      return { text: "s", usage: {} };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { summarize });
    await fire(
      events,
      "session_before_compact",
      { ...hookCtx(), model: { id: "test-model", reasoning: true }, thinkingLevel: "low" },
      beforeCompactEvent(),
    );
    expect((calls[0] as { thinkingLevel?: string }).thinkingLevel).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Mid-run compaction (turn_end boundary drafts)
// ---------------------------------------------------------------------------

describe("mid-run compaction preparation", () => {
  const user = (text: string) => ({ role: "user", content: text });
  const toolResult = () => ({ role: "toolResult", toolCallId: "t1", content: "output" });
  const assistant = (text: string, calls: unknown[] = []) => ({
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), ...calls],
  });
  const readCall = (p: string) => ({ type: "toolCall", id: "t1", name: "read", arguments: { path: p } });

  /** Projected entry over a raw entry, projecting exactly `messages`. */
  const proj = (sourceEntry: SessionEntry, messages: unknown[]) =>
    ({ sourceEntry, messages }) as unknown as Parameters<typeof draftPreparation>[0][number];

  const entryOf = (messages: unknown[], label = "e") => {
    const e = msgEntry("message", { label }, "2026-09-26T10:00:00.000Z");
    return proj(e, messages);
  };

  it("cuts to keep the recent tail and summarizes the older span", () => {
    const u1 = entryOf([user("x".repeat(8000))]); // ~2000 tokens
    const a1 = entryOf([assistant("y".repeat(1600))]); // ~400 tokens
    const u2 = entryOf([user("z".repeat(800))]); // ~200 tokens
    const a2 = entryOf([assistant("w".repeat(800))]); // ~200 tokens
    const prep = draftPreparation([u1, a1, u2, a2], 400);
    expect(prep).toBeDefined();
    expect(prep!.firstKeptEntryId).toBe(u2.sourceEntry.id);
    expect(prep!.messages).toEqual([u1.messages[0], a1.messages[0]]);
    expect(prep!.previousSummary).toBeUndefined();
  });

  it("folds the split-turn prefix into the same chronological span, never cutting at a tool result", () => {
    // One user-message span larger than keepRecentTokens: the cut lands at an
    // assistant message mid-span (pi's "split turn"), its trailing tool result
    // stays kept, and the whole prefix — user message included — is summarized.
    const u1 = entryOf([user("we need to fix the wasm error boundary")]);
    const a1 = entryOf([assistant("looking…")]);
    const a2 = entryOf([assistant("big edit turn", [readCall("src/lib.rs")]), toolResult()]);
    const tr = entryOf([toolResult()]);
    const prep = draftPreparation([u1, a1, a2, tr], 1);
    expect(prep!.firstKeptEntryId).toBe(a2.sourceEntry.id);
    expect(prep!.messages).toEqual([u1.messages[0], a1.messages[0]]);
  });

  it("starts after the newest projected compaction and carries its summary", () => {
    const comp = proj(compactionEntry("## Goal\n- earlier era", "k0"), [{ role: "compactionSummary", content: "x" }]);
    const u1 = entryOf([user("x".repeat(800))]);
    const a1 = entryOf([assistant("y".repeat(400))]);
    const prep = draftPreparation([comp, u1, a1], 1);
    expect(prep!.firstKeptEntryId).toBe(a1.sourceEntry.id);
    expect(prep!.messages).toEqual([u1.messages[0]]);
    expect(prep!.previousSummary).toBe("## Goal\n- earlier era");
  });

  it("returns undefined when there is nothing to compact", () => {
    // Session smaller than the kept tail.
    const u1 = entryOf([user("tiny")]);
    expect(draftPreparation([u1], 20_000)).toBeUndefined();
    // No valid cut point at all (tool results only).
    expect(draftPreparation([entryOf([toolResult()])], 1)).toBeUndefined();
  });

  it("returns undefined when the cut entry has no id or the newest entry is a compaction", () => {
    const u1 = entryOf([user("x".repeat(400))]);
    const idless = entryOf([assistant("y".repeat(4000))]);
    delete (idless.sourceEntry as { id?: string }).id;
    expect(draftPreparation([u1, idless], 1)).toBeUndefined();

    // Post-draft shape: nothing new to compact after the newest compaction.
    const compLast = proj(compactionEntry("just compacted", "k1"), [{ role: "compactionSummary", content: "x" }]);
    expect(draftPreparation([entryOf([user("hi")]), compLast], 1)).toBeUndefined();
  });

  it("counts system messages in the token walk but never summarizes them", () => {
    const e1 = entryOf([{ role: "system", content: "x".repeat(400) }, user("go")]);
    const e2 = entryOf([assistant("y".repeat(400))]);
    const prep = draftPreparation([e1, e2], 1);
    expect(prep!.firstKeptEntryId).toBe(e2.sourceEntry.id);
    expect(prep!.messages).toEqual([user("go")]);
  });
});

describe("collectFileOps", () => {
  it("collects read/write/edit paths from assistant tool calls only", () => {
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", name: "write", arguments: { path: "b.ts" } },
          { type: "toolCall", name: "edit", arguments: { path: "c.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", name: "read", arguments: {} },
          { type: "text", text: "note" },
        ],
      },
    ] as never[];
    expect(collectFileOps(messages)).toEqual({
      read: new Set(["a.ts"]),
      written: new Set(["b.ts"]),
      edited: new Set(["c.ts"]),
    });
  });
});

describe("mid-run compaction wiring (turn_end)", () => {
  const OVER = { tokens: 150_000, contextWindow: 200_000 };

  /** Projection shaped like a long over-budget run: compaction, user turn, then a churn of big assistant turns. */
  function longRunProjection() {
    const comp = {
      sourceEntry: compactionEntry("## Goal\n- earlier era", "k0"),
      messages: [{ role: "compactionSummary", content: "x" }],
    };
    const big = (label: string, path?: string) => ({
      sourceEntry: msgEntry("assistant", { label }),
      messages: [
        {
          role: "assistant",
          content: [
            ...(path ? [{ type: "toolCall", id: `t-${label}`, name: "read", arguments: { path } }] : []),
            { type: "text", text: `${label}\n${"x".repeat(40_000)}` }, // ~10k tokens each
          ],
        },
      ],
    });
    const entries = [
      comp,
      {
        sourceEntry: msgEntry("user", { content: "fix all the seams" }),
        messages: [{ role: "user", content: "fix all the seams" }],
      },
      big("t1"),
      big("t2", "read1.ts"),
      big("t3"),
      big("t4", "read2.ts"),
    ];
    return entries as unknown as Parameters<typeof draftPreparation>[0];
  }

  function turnEndEvent(overrides: Record<string, unknown> = {}, contextEntries = longRunProjection()) {
    return {
      type: "turn_end",
      turnIndex: 3,
      message: { role: "assistant" },
      toolResults: [],
      messageEntryId: "m1",
      toolResultEntryIds: [],
      outcome: "completed",
      entries: [],
      continue: false,
      context: { contextEntries, contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
      ...overrides,
    };
  }

  function turnEndCtx(
    usage: { tokens: number | null; contextWindow: number } | undefined = OVER,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      getContextUsage: () => usage,
      compact: () => {},
      model: { id: "test-model", reasoning: false },
      modelRegistry: {
        complete: async () => ({
          content: [{ type: "text", text: "## Goal\n- mid-run summary" }],
          usage: { totalTokens: 7 },
          stopReason: "stop",
        }),
      },
      thinkingLevel: undefined,
      sessionManager: { getBranch: () => [] },
      ...overrides,
    };
  }

  it("proposes a compaction draft mid-run — entries only, no forced continuation", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const result = (await fire(events, "turn_end", turnEndCtx(), turnEndEvent())) as
      { entries: unknown[]; continue?: boolean } | undefined;
    expect(result).toBeDefined();
    expect(result!.continue).toBeUndefined(); // pi's own continuation decision stands
    const [draft] = result!.entries as Array<Record<string, unknown>>;
    expect(draft.type).toBe("compaction");
    expect(draft.summary).toBe("## Goal\n- mid-run summary");
    expect(typeof draft.firstKeptEntryId).toBe("string");
    expect(draft.usage).toEqual({ totalTokens: 7 });
    // No todo state on the branch — the draft stands alone, no plan message.
    expect(result!.entries).toHaveLength(1);
  });

  it("chains the current plan as a message after the draft — drafts fire no session_compact, so nothing else carries it", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const branch = [
      {
        type: "custom",
        customType: "todo.state",
        data: { todos: [{ content: "survive compaction", status: "in_progress" }] },
      },
    ];
    const result = (await fire(
      events,
      "turn_end",
      turnEndCtx(OVER, { sessionManager: { getBranch: () => branch } }),
      turnEndEvent(),
    )) as { entries: Array<Record<string, unknown>> };

    // Plan-less compaction first, then the plan carrier at the recent position.
    expect(result.entries[0].type).toBe("compaction");
    expect(result.entries[0].summary).not.toContain("## Current Plan");
    const planMessage = result.entries[1] as {
      type: string;
      customType: string;
      content: string;
      display: boolean;
    };
    expect(planMessage.type).toBe("custom_message");
    expect(planMessage.customType).toBe("todo.plan");
    expect(planMessage.content).toContain("## Current Plan");
    expect(planMessage.content).toContain("[>] survive compaction");
    expect(planMessage.display).toBe(false);
  });

  it("summarizes the projection chronologically with the previous compaction summary, and unions file lists", async () => {
    const calls: unknown[] = [];
    const summarize: SummaryFn = async (args) => {
      calls.push(args);
      return { text: "summary", usage: { totalTokens: 1 } };
    };
    const { pi, events } = makePi();
    const branch = [compactionEntry("old", "k0")];
    (branch[0] as { details?: unknown }).details = { readFiles: ["old.txt"], modifiedFiles: [] };
    registerRecallTool(pi, CONFIG, undefined, { summarize });
    const result = (await fire(
      events,
      "turn_end",
      turnEndCtx(OVER, { sessionManager: { getBranch: () => branch } }),
      turnEndEvent(),
    )) as {
      entries: Array<Record<string, unknown>>;
    };
    const args = calls[0] as {
      messages: Array<{ role: string }>;
      previousSummary?: string;
      userFocus?: string;
      keptRecentTokens?: number;
    };
    expect(args.messages.every((m) => m.role !== "system")).toBe(true);
    expect(args.messages[0].role).toBe("user");
    expect(args.previousSummary).toBe("## Goal\n- earlier era");
    expect(args.userFocus).toBeUndefined();
    // Drafts cannot see resolved per-model settings — always pi's default tail.
    expect(args.keptRecentTokens).toBe(20_000);
    expect(result.entries[0].details).toEqual({ readFiles: ["old.txt", "read1.ts"], modifiedFiles: [] });
  });

  it("skips when the turn ended naturally — the settled trigger owns idle compaction", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const event = turnEndEvent({
      context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
    });
    expect(await fire(events, "turn_end", turnEndCtx(), event)).toBeUndefined();
  });

  it("skips aborted or error turns — recovery owns those, and a cancel must not pay for a summary", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    expect(await fire(events, "turn_end", turnEndCtx(), turnEndEvent({ outcome: "aborted" }))).toBeUndefined();
    expect(await fire(events, "turn_end", turnEndCtx(), turnEndEvent({ outcome: "error" }))).toBeUndefined();
  });

  it("skips below the target, on unknown tokens, and when disabled", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    expect(
      await fire(events, "turn_end", turnEndCtx({ tokens: 100_000, contextWindow: 200_000 }), turnEndEvent()),
    ).toBeUndefined();
    expect(
      await fire(events, "turn_end", turnEndCtx({ tokens: null, contextWindow: 200_000 }), turnEndEvent()),
    ).toBeUndefined();
    const off = makePi();
    registerRecallTool(off.pi, { ...CONFIG, compactTargetTokens: 0 });
    expect(await fire(off.events, "turn_end", turnEndCtx(), turnEndEvent())).toBeUndefined();
  });

  it("stays out of the way when summary ownership is disabled — no draft fallback exists", async () => {
    const never: SummaryFn = async () => {
      throw new Error("must not be called");
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, { ...CONFIG, ownSummaries: false }, undefined, { summarize: never });
    expect(await fire(events, "turn_end", turnEndCtx(), turnEndEvent())).toBeUndefined();
  });

  it("a summarizer failure leaves a breadcrumb and the next turn tries again", async () => {
    const crumbs: string[] = [];
    let fail = true;
    const summarize: SummaryFn = async () => {
      if (fail) throw new Error("auth expired");
      return { text: "second try", usage: {} };
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { summarize, logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(events, "turn_end", turnEndCtx(), turnEndEvent())).toBeUndefined();
    expect(crumbs).toEqual([expect.stringContaining("mid-run compaction skipped: auth expired")]);
    fail = false;
    const result = (await fire(events, "turn_end", turnEndCtx(), turnEndEvent())) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(result.entries[0].summary).toBe("second try");
    expect(crumbs).toHaveLength(1);
  });

  it("skips on empty summary text with a breadcrumb, and stays silent on abort", async () => {
    const crumbs: string[] = [];
    const empty: SummaryFn = async () => ({ text: "   ", usage: {} });
    const a = makePi();
    registerRecallTool(a.pi, CONFIG, undefined, { summarize: empty, logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(a.events, "turn_end", turnEndCtx(), turnEndEvent())).toBeUndefined();
    expect(crumbs).toEqual([expect.stringContaining("summarizer returned empty text")]);

    const controller = new AbortController();
    controller.abort();
    const failing: SummaryFn = async () => {
      throw new Error("aborted mid-flight");
    };
    const b = makePi();
    registerRecallTool(b.pi, CONFIG, undefined, { summarize: failing, logCompactionError: (l) => crumbs.push(l) });
    expect(
      await fire(b.events, "turn_end", turnEndCtx(OVER, { signal: controller.signal }), turnEndEvent()),
    ).toBeUndefined();
    expect(crumbs).toHaveLength(1); // no crumb for the user cancel
  });

  it("skips without a model, leaving a breadcrumb", async () => {
    const crumbs: string[] = [];
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { logCompactionError: (l) => crumbs.push(l) });
    expect(await fire(events, "turn_end", turnEndCtx(OVER, { model: undefined }), turnEndEvent())).toBeUndefined();
    expect(crumbs).toEqual([expect.stringContaining("no model on session context")]);
  });

  it("does not re-trigger while the post-draft context is below the target", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    // First turn over budget proposes the draft; the next turn sees the
    // compacted context and stays quiet.
    const ctx = turnEndCtx();
    let usage = { tokens: 150_000, contextWindow: 200_000 };
    (ctx as { getContextUsage: () => unknown }).getContextUsage = () => usage;
    await fire(events, "turn_end", ctx, turnEndEvent());
    usage = { tokens: 30_000, contextWindow: 200_000 };
    expect(await fire(events, "turn_end", ctx, turnEndEvent())).toBeUndefined();
  });

  it("stays quiet while a settled-trigger compaction is in flight", async () => {
    const compactCalls: Array<Record<string, unknown>> = [];
    const ctx = {
      getContextUsage: () => OVER,
      compact: (opts: Record<string, unknown>) => compactCalls.push(opts),
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    await fire(events, "agent_settled", ctx); // sets the in-flight flag
    expect(compactCalls).toHaveLength(1);
    expect(
      await fire(events, "turn_end", { ...turnEndCtx(), ...ctx, compact: ctx.compact }, turnEndEvent()),
    ).toBeUndefined();
    (compactCalls[0].onComplete as () => void)();
    expect((await fire(events, "turn_end", { ...turnEndCtx(), ...ctx }, turnEndEvent())) as unknown).toBeDefined();
  });

  it("merges with earlier handlers' proposals and arms the post-compaction reminder", async () => {
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG);
    const earlier = { type: "custom", customType: "other.note", data: { keep: true } };
    const result = (await fire(events, "turn_end", turnEndCtx(), turnEndEvent({ entries: [earlier] }))) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual(earlier); // not clobbered
    expect(result.entries[1].type).toBe("compaction");
    // Boundary commits never fire session_compact — the reminder must fire at
    // the next run start anyway.
    const reminder = (await fire(events, "before_agent_start", turnEndCtx())) as {
      message: { customType: string };
    };
    expect(reminder.message.customType).toBe("recall.reminder");
  });

  it("defers when another handler already proposed a compaction this boundary", async () => {
    const never: SummaryFn = async () => {
      throw new Error("must not be called");
    };
    const { pi, events } = makePi();
    registerRecallTool(pi, CONFIG, undefined, { summarize: never });
    const theirs = { type: "compaction", summary: "theirs", firstKeptEntryId: "k", details: undefined };
    expect(await fire(events, "turn_end", turnEndCtx(), turnEndEvent({ entries: [theirs] }))).toBeUndefined();
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;
    reader.readFile = async () => {
      throw new Error("disk went away");
    };
    const read = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "original entry", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;
    // Simulate a prepend that shifts line numbers: same stat-invalidating change,
    // but the reader now serves shifted content under the old cache.
    const shifted = `${JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd", timestamp: "2026-09-20T09:00:00.000Z", cwd: "/p" })}\n${userLine("shift line")}\n${userLine("the original entry text")}\n${userLine("a second entry")}\n`;
    const path0 = (await reader.listJsonlFiles(dir))[0];
    reader.readFile = async () => shifted;
    note(path0);
    const read = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;
    reader.readFile = async () => "not json at all\n"; // line 1 is garbage
    const read = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "findable foreign", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;
    reader.listJsonlFiles = async () => {
      throw new Error("ENOENT: no such directory");
    };
    const read = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
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
    const search = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { description: "target entry", scope: "project" }, undefined, undefined, ctx)) as {
      details: { hits: Array<{ ref: string }> };
    };
    const ref = search.details.hits[0].ref;

    // Truncation: indexed line 2 no longer exists (stats unchanged, cache not rebuilt).
    reader.readFile = async () =>
      JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd" });
    const truncated = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(truncated.content[0].text).toContain("changed since indexing");

    // Swap: line 2 parses but holds a different entry id — never return wrong data.
    reader.readFile = async () =>
      `${JSON.stringify({ type: "session", version: 3, id: "1e2dcafe-aaaa-bbbb-cccc-dddddddddddd" })}\n${userLine("a different entry")}\n`;
    const swapped = (await tools
      .get(RECALL_TOOL_NAME)!
      .execute("t", { mode: "read", id: ref }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(swapped.content[0].text).toContain("changed since indexing");
  });

  it("entries omitted from context by edits remain searchable (projection-aware diff)", async () => {
    const omitted = msgEntry("user", { content: "the secret context-edit omitted detail about invoices" });
    omitted.id = "omitted"; // fixture projects no messages for this id
    const branch = [omitted];
    const projection = {
      entries: [{ sourceEntry: omitted, messages: [] }],
      messages: [],
      thinkingLevel: "low",
      model: null,
    };
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
    const complete = formatSearchResult([hit()], {
      archiveEntries: 42,
      foreignSessions: 0,
      scope: "session",
      totalMatches: 1,
    });
    expect(complete).not.toContain("results limited");
    const cut = formatSearchResult([hit()], {
      archiveEntries: 42,
      foreignSessions: 0,
      scope: "session",
      totalMatches: 7,
    });
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
