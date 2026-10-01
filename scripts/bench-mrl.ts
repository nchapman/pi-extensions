/**
 * Matryoshka (MRL) truncation experiment over the v5-text-nano bench cache.
 *
 * "Just for fun" follow-up to the model comparison: the nano is Matryoshka-
 * trained, so its 768-dim vectors should survive truncation to the first N
 * dims (renormalized) with graceful quality loss — the card claims robustness
 * down to 32 dims and under binary (±1) quantization. This measures exactly
 * that on the same frozen corpus and the same 50 masked-prose targets as the
 * retrieval benchmark, sem-only (no BM25, no fusion): rank the whole corpus
 * by cosine at each width and score entry-level Hit@1/Hit@5/MRR@10.
 *
 * Reuses the bench's nano vector cache (/tmp, one file, flat format) and the
 * worker for the 50 query embeddings — no re-embedding of documents. Runs
 * under the bench vitest config (recall.ts is not strip-importable):
 *   npm run bench:mrl
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmbedClient } from "../lib/embed-client";
import { fsProjectReader, ProjectCorpusCache } from "../extensions/recall";
import { sampleTargets } from "./bench-common";

const NANO = "jinaai/jina-embeddings-v5-text-nano-retrieval";
const FULL_DIMS = 768;
const LEVELS = [768, 512, 256, 128, 64, 32];

interface Metrics {
  hit1: number;
  hit5: number;
  mrr10: number;
}

function metrics(ranks: number[]): Metrics {
  const n = ranks.length || 1;
  return {
    hit1: ranks.filter((r) => r === 1).length / n,
    hit5: ranks.filter((r) => r >= 1 && r <= 5).length / n,
    mrr10: ranks.reduce((s, r) => s + (r >= 1 && r <= 10 ? 1 / r : 0), 0) / n,
  };
}

/** Parse the bench store's flat format: 16-byte header, then [16B hex key | f32 × dims]. */
function parseCache(buf: Buffer): Map<string, Float32Array> {
  const dims = buf.readUInt16LE(5);
  const rec = 16 + dims * 4;
  const out = new Map<string, Float32Array>();
  for (let at = 16; at + rec <= buf.length; at += rec) {
    const key = buf.subarray(at, at + 16).toString("hex");
    const bytes = buf.subarray(at + 16, at + rec);
    out.set(key, new Float32Array(bytes.buffer, bytes.byteOffset, dims));
  }
  return out;
}

/** First-N truncation + renormalize — the MRL inference recipe. */
function truncate(v: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    out[i] = v[i];
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

/** ±1 per dim (all 768): similarity = fraction of matching signs (cosine on sign vectors). */
function signSim(a: Float32Array, b: Float32Array): number {
  let agree = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] >= 0) === (b[i] >= 0)) agree++;
  return agree / a.length;
}

describe("jina-v5-text-nano Matryoshka truncation", () => {
  it("scores sem-only retrieval at each MRL width", { timeout: 10 * 60_000 }, async () => {
    // Same frozen corpus + targets as the model comparison table.
    const sourceDir = path.join(os.homedir(), ".pi/agent/sessions/--Users-nchapman-Code-pi-extensions--");
    const snapDir = path.join(
      os.tmpdir(),
      `recall-bench-corpus-${createHash("sha256").update(sourceDir).digest("hex").slice(0, 8)}`,
    );
    const cache = new ProjectCorpusCache(fsProjectReader, 512 * 1024 * 1024);
    await cache.refresh(snapDir, undefined);
    const corpus = [...cache.list()].sort((a, b) => b.mtimeMs - a.mtimeMs).flatMap((c) => c.chunks).slice(0, 5000);
    expect(corpus.length).toBeGreaterThan(100);
    const targets = sampleTargets(corpus, 50);
    expect(targets.length).toBeGreaterThanOrEqual(10);

    // Doc vectors straight from the bench cache; queries through the real worker.
    const slug = NANO.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(-48);
    const cacheFile = path.join(os.tmpdir(), `recall-bench-vectors-${slug}.bin`);
    const docs = parseCache(await readFile(cacheFile));
    expect(docs.size).toBeGreaterThan(4000);
    const client = new EmbedClient({
      workerPath: fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url)),
      model: NANO,
      dtype: "q8",
      modelDir: path.join(os.homedir(), ".pi/agent/models"),
    });
    const queries: Float32Array[] = [];
    for (const t of targets) queries.push((await client.query(t.description)) as Float32Array);
    client.dispose();
    expect(queries.every((q) => q !== undefined && q.length === FULL_DIMS)).toBe(true);

    const refByChunk = new Map<string, string>(corpus.map((c) => [c.key, c.ref]));
    const keys = [...docs.keys()];

    // Entry-level rank of the target: first doc whose chunk belongs to the target's entry.
    const rankAt = (target: (typeof targets)[number], sims: { key: string; s: number }[]): number => {
      const sorted = sims.sort((a, b) => b.s - a.s);
      for (let i = 0; i < sorted.length; i++)
        if (refByChunk.get(sorted[i].key) === target.chunk.ref) return i + 1;
      return Infinity;
    };

    console.log(`\ncorpus: ${docs.size} vectors · ${targets.length} masked-prose queries (sem-only)`);
    for (const level of LEVELS) {
      // Truncate each doc once per level, not once per (query × doc).
      const docsAt = new Map(keys.map((k) => [k, truncate(docs.get(k)!, level)]));
      const ranks = targets.map((t, qi) => {
        const q = truncate(queries[qi], level);
        const sims = keys.map((key) => {
          const d = docsAt.get(key)!;
          let dot = 0;
          for (let i = 0; i < level; i++) dot += q[i] * d[i];
          return { key, s: dot };
        });
        return rankAt(t, sims);
      });
      const m = metrics(ranks);
      const bytes = level * 4;
      console.log(
        `${String(level).padStart(4)}d  ${String(bytes).padStart(4)}B/vec  Hit@1 ${(m.hit1 * 100).toFixed(0).padStart(3)}%  Hit@5 ${(m.hit5 * 100).toFixed(0).padStart(3)}%  MRR@10 ${m.mrr10.toFixed(3)}`,
      );
    }
    {
      const ranks = targets.map((t, qi) => {
        const sims = keys.map((key) => ({ key, s: signSim(queries[qi], docs.get(key)!) }));
        return rankAt(t, sims);
      });
      const m = metrics(ranks);
      console.log(`  ±1b    96B/vec  Hit@1 ${(m.hit1 * 100).toFixed(0).padStart(3)}%  Hit@5 ${(m.hit5 * 100).toFixed(0).padStart(3)}%  MRR@10 ${m.mrr10.toFixed(3)}  (binary, all 768 dims)`);
    }
  });
});
