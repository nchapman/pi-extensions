/** Ranking: hand-rolled BM25 over the chunks multiplied by a memory-horizon
 * recency decay, the semantic (embedding) side of hybrid search and its RRF
 * fusion, and the model-facing snippet/result formatting. */

import { fuseRankings, type MatchSides } from "../../lib/embed";
import type { VectorHit } from "../../lib/vecstore";
import type { RecallConfig } from "./config";
import { DEFAULTS } from "./config";
import { type RecallChunk, type RecallKind, kindLabel, tokenize } from "./chunks";

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
  /** Which rankings matched (hybrid path only; undefined = lexical-only ranking). */
  sides?: MatchSides;
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
  const frontier = archiveFrontier(chunks);
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
    (a, b) =>
      b.score - a.score || b.chunk.timestamp.localeCompare(a.chunk.timestamp) || a.chunk.ref.localeCompare(b.chunk.ref),
  );
  return results;
}

/** Parse an ISO timestamp to epoch ms; malformed or missing → -Infinity (treated as oldest). */
function tsMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The archive frontier: newest chunk timestamp in the corpus, in epoch ms. */
export function archiveFrontier(chunks: RecallChunk[]): number {
  let newest = -Infinity;
  for (const c of chunks) newest = Math.max(newest, tsMs(c.timestamp));
  return newest;
}

/** Exponential memory decay: 1 at the frontier, halving per half-life, never below the floor. */
export function recencyFactor(ageMs: number, halfLifeMs: number, floor: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return ageMs === 0 ? 1 : floor;
  return Math.max(floor, 0.5 ** (ageMs / halfLifeMs));
}

// ---------------------------------------------------------------------------
// Semantic side (hybrid)
// ---------------------------------------------------------------------------

/**
 * How deep each ranking feeds RRF. 64 keeps the fusion candidate set well
 * past maxResults (25 cap) while staying far below corpus size — decay can
 * reorder within it freely; a chunk outside the top 64 of both rankings has
 * neither strong lexical nor semantic evidence for a 5-result page.
 */
export const FUSION_DEPTH = 64;

/** A description's normalized form must be at least this long before quoting
 * it verbatim counts as an echo. Shorter descriptions are legitimate exact
 * terms — every chunk containing "rotation" may be the real target, not a
 * transcript echo. */
export const ECHO_NEEDLE_MIN_CHARS = 32;

/** Fused RRF scores land in [0, ~0.03]; ×100 puts them in a readable range for the result format. */
const FUSED_SCORE_SCALE = 100;

/** One catch-up round embeds at most this many chunks — a large backlog drains across settles. */
export const EMBED_BATCH_LIMIT = 128;

/** The structural slice of VectorStore the extension touches — injectable for tests. */
export interface VectorStoreLike {
  has(keys: readonly string[]): Set<string>;
  add(items: readonly { key: string; vector: Float32Array }[]): Promise<void>;
  /** Reclaim records whose key is not in `keep`; returns bytes reclaimed (self-gated, 0 = no-op). */
  compact(keep: ReadonlySet<string>): Promise<number>;
  topK(query: Float32Array, candidates: Iterable<string>, k: number): VectorHit[];
  close(): Promise<void>;
}

/** The structural slice of EmbedClient — injectable for tests. */
export interface EmbedSeam {
  readonly available: boolean;
  start(): boolean;
  query(text: string): Promise<Float32Array | undefined>;
  embed(
    items: readonly { key: string; text: string }[],
  ): Promise<Array<{ key: string; vector: Float32Array }> | undefined>;
  kill(): void;
  /** Terminal: kill AND refuse every later request (no lazy respawn). */
  dispose(): void;
  /** Session-replacement re-arm: clear dispose/give-up and restore the spawn budget. */
  reset(): void;
}

/**
 * Rank vector hits best-first under the same policy as the lexical side —
 * foreign weight and memory-horizon decay applied to similarity — so both
 * rankings entering RRF already encode the extension's notion of relevance.
 */
export function semanticRankedKeys(
  hits: readonly VectorHit[],
  chunksByKey: ReadonlyMap<string, RecallChunk>,
  config: Pick<RecallConfig, "foreignWeight" | "halfLifeHours" | "recencyFloor">,
  frontier: number,
): string[] {
  const halfLifeMs = config.halfLifeHours * 3_600_000;
  const scored = hits
    .map((hit) => {
      const chunk = chunksByKey.get(hit.key);
      if (chunk === undefined) return undefined;
      const weight = chunk.origin === "current" ? 1 : config.foreignWeight;
      const recency = recencyFactor(frontier - tsMs(chunk.timestamp), halfLifeMs, config.recencyFloor);
      return { key: hit.key, score: hit.similarity * weight * recency };
    })
    .filter((x): x is { key: string; score: number } => x !== undefined);
  scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  return scored.map((x) => x.key);
}

/**
 * Hybrid ranking: fuse the (already policy-weighted) lexical and semantic
 * key rankings with RRF, then rebuild ScoredChunks in fused order. Purely
 * lexical input (no semantic keys) returns the lexical ranking unchanged —
 * vectors widen recall, they never gate it.
 */
export function fuseHybrid(
  lexical: readonly ScoredChunk[],
  semanticKeys: readonly string[],
  chunksByKey: ReadonlyMap<string, RecallChunk>,
  config: Pick<RecallConfig, "foreignWeight" | "halfLifeHours" | "recencyFloor" | "embedWeight">,
  frontier: number,
): ScoredChunk[] {
  if (semanticKeys.length === 0) return [...lexical];
  const fused = fuseRankings(
    lexical.slice(0, FUSION_DEPTH).map((r) => r.chunk.key),
    semanticKeys.slice(0, FUSION_DEPTH),
    { lexical: 1, semantic: config.embedWeight },
  );
  const halfLifeMs = config.halfLifeHours * 3_600_000;
  const byScored = new Map(lexical.map((r) => [r.chunk.key, r]));
  return fused.flatMap((f) => {
    const chunk = chunksByKey.get(f.key);
    if (chunk === undefined) return [];
    const recency = recencyFactor(frontier - tsMs(chunk.timestamp), halfLifeMs, config.recencyFloor);
    const lexicalRaw = byScored.get(f.key);
    return [
      {
        chunk,
        score: f.score * FUSED_SCORE_SCALE,
        rawScore: lexicalRaw?.rawScore ?? 0,
        recencyFactor: recency,
        sides: f.sides,
      },
    ];
  });
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
  let snippet = text
    .slice(start, end)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  /** Which rankings matched (hybrid path only). */
  match?: MatchSides;
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
    lines.push(
      `Top ${hits.length} match${hits.length === 1 ? "" : "es"} (of ${meta.archiveEntries} archived entries searched):`,
    );
    for (const [i, hit] of hits.entries()) {
      const match = hit.match === "both" ? " · lex+sem" : hit.match === "semantic" ? " · sem" : "";
      lines.push(
        `${i + 1}. ${hit.sessionLabel} · ${kindLabel(hit.kind, hit.label)} · ${shortDate(hit.timestamp)} · score ${hit.score.toFixed(1)}${match}${
          hit.recencyFactor !== undefined && hit.recencyFactor < 0.95
            ? ` (recency ×${hit.recencyFactor.toFixed(2)})`
            : ""
        }`,
      );
      lines.push(`   ${hit.snippet.split("\n").join("\n   ")}`);
      lines.push(`   full entry: recall { "mode": "read", "id": "${hit.ref}" }`);
    }
  }
  const skipped = meta.skippedFiles
    ? ` (${meta.skippedFiles} unreadable session file${meta.skippedFiles === 1 ? "" : "s"} skipped)`
    : "";
  const limited = (meta.totalMatches ?? hits.length) > hits.length ? "results limited; " : "";
  return `${lines.join("\n")}${skipped}\n(${limited}verbatim excerpts — older context may have changed since)`;
}

export function formatReadResult(ref: string, header: string, text: string, offset: number, maxChars: number): string {
  offset = Math.min(Math.max(0, offset), text.length); // offset past end reads empty, not nonsense
  const slice = text.slice(offset, offset + maxChars);
  const end = Math.min(text.length, offset + slice.length);
  const more =
    end < text.length ? `\n[truncated — continue with { "mode": "read", "id": "${ref}", "offset": ${end} }]` : "";
  return `${header}\n[chars ${offset}-${end} of ${text.length}]\n${slice}${more}`;
}
