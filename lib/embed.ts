/**
 * Reciprocal Rank Fusion — the seam where lexical and semantic rankings meet.
 *
 * Pure rank arithmetic, deliberately: recall's ranking *policy* (identifier
 * tokenization, memory-horizon decay, foreign weight) lives in the extension
 * and produces two best-first key lists; this module fuses positions only.
 * Fusing ranks instead of scores sidesteps the scale mismatch between BM25
 * (unbounded) and cosine similarity ([-1, 1]) and needs no per-side
 * normalization — and a chunk that appears on both lists outranks the #1 of
 * either list alone, which is exactly the evidence pattern hybrid search
 * exists to reward (Supabase-style weighted RRF, k ≈ 60 per the literature).
 */

export const RRF_K = 60;

export type MatchSides = "lexical" | "semantic" | "both";

export interface FusedResult {
  key: string;
  /** Σ sideWeight / (rrfK + sideRank) over the sides the key appears on. */
  score: number;
  /** Which rankings contributed — surfaced so results can explain themselves. */
  sides: MatchSides;
}

/**
 * Fuse two best-first key lists with weighted RRF. Keys absent from both
 * lists do not exist; a key present in one list keeps that side's
 * contribution alone (union semantics — semantic recall widens lexical
 * results, it never gates them). Output is sorted by score descending, ties
 * broken by key ascending for determinism.
 */
export function fuseRankings(
  lexical: readonly string[],
  semantic: readonly string[],
  weights: { lexical: number; semantic: number },
  rrfK: number = RRF_K,
): FusedResult[] {
  const scores = new Map<string, FusedResult>();
  const seen = new Set<string>(); // per-side de-dup: a repeated key must not accumulate or flip to "both"
  const add = (key: string, contribution: number, side: MatchSides) => {
    const existing = scores.get(key);
    if (existing === undefined) {
      scores.set(key, { key, score: contribution, sides: side });
      return;
    }
    existing.score += contribution;
    existing.sides = "both";
  };
  // Ranks are 1-based: reciprocal 1/(k + 1) for the top hit.
  lexical.forEach((key, i) => {
    if (seen.has(key)) return;
    seen.add(key);
    add(key, weights.lexical / (rrfK + i + 1), "lexical");
  });
  seen.clear();
  semantic.forEach((key, i) => {
    if (seen.has(key)) return;
    seen.add(key);
    add(key, weights.semantic / (rrfK + i + 1), "semantic");
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
}
