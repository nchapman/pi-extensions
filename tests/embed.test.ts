import { describe, expect, it } from "vitest";
import { RRF_K, fuseRankings } from "../lib/embed";

const W = { lexical: 1, semantic: 0.7 };

describe("fuseRankings", () => {
  it("returns nothing for two empty lists", () => {
    expect(fuseRankings([], [], W)).toEqual([]);
  });

  it("carries a single side's contribution when the other is empty", () => {
    const fused = fuseRankings(["a", "b"], [], W);
    expect(fused.map((f) => f.key)).toEqual(["a", "b"]);
    expect(fused.map((f) => f.sides)).toEqual(["lexical", "lexical"]);
    expect(fused[0].score).toBeCloseTo(W.lexical / (RRF_K + 1), 12);
  });

  it("sums contributions for keys on both lists", () => {
    const fused = fuseRankings(["a"], ["a"], W);
    expect(fused[0].sides).toBe("both");
    expect(fused[0].score).toBeCloseTo(W.lexical / (RRF_K + 1) + W.semantic / (RRF_K + 1), 12);
  });

  it("ranks a both-match key above each list's #1", () => {
    // "both" is lexical #2 and semantic #2, yet must beat the single-side #1s.
    const fused = fuseRankings(["lex1", "both", "lex3"], ["sem1", "both", "sem3"], W);
    expect(fused[0].key).toBe("both");
    expect(fused[0].sides).toBe("both");
  });

  it("never lets semantic-only keys gate lexical-only keys (union)", () => {
    const fused = fuseRankings(["a"], ["b"], W);
    expect(new Set(fused.map((f) => f.key))).toEqual(new Set(["a", "b"]));
  });

  it("uses 1-based ranks", () => {
    const fused = fuseRankings(["a", "b"], [], W);
    expect(fused[1].score).toBeCloseTo(W.lexical / (RRF_K + 2), 12);
  });

  it("applies side weights", () => {
    const even = { lexical: 0.5, semantic: 0.5 };
    const fused = fuseRankings(["a"], ["b"], even);
    expect(fused[0].score).toBeCloseTo(fused[1].score, 12); // equal weights, equal ranks → tie
  });

  it("breaks ties deterministically by key", () => {
    const fused = fuseRankings(["z"], ["a"], { lexical: 1, semantic: 1 });
    expect(fused.map((f) => f.key)).toEqual(["a", "z"]);
  });

  it("honors a custom rrfK", () => {
    const fused = fuseRankings(["a"], [], W, 1);
    expect(fused[0].score).toBeCloseTo(W.lexical / 2, 12);
  });

  it("de-duplicates a key repeated within one list (first rank wins)", () => {
    const fused = fuseRankings(["a", "a"], [], W);
    expect(fused).toHaveLength(1);
    expect(fused[0].score).toBeCloseTo(W.lexical / (RRF_K + 1), 12);
  });
});
