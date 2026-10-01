/**
 * Binary-quantization optimization bench for the v5-text-nano.
 *
 * The MRL experiment showed ±1-bit vectors keep 0.950 of 0.960 sem-only MRR
 * at 96 B/vec. This bench asks the follow-up: inside the full hybrid protocol
 * (BM25 fusion, decay, foreign weights — identical to bench-recall), how much
 * of the float quality can binary retrieval keep, and which classic lever
 * recovers the rest?
 *
 *   float      — full 768-d float dot (the model-comparison reference)
 *   bin·sym    — sign(q)·sign(d): ±1 on both sides (the MRL row)
 *   bin·asym   — q (float)·sign(d): asymmetric — the query keeps precision,
 *                documents stay 1-bit. The standard PQ-style trick.
 *   bin+rescore— asym coarse scan (top 256) rescored with float dots, top 64
 *                kept — two-stage retrieve/refine, the FAISS pattern.
 *
 * Each variant swaps ONLY the topK scan; semanticRankedKeys/fuseHybrid/decay
 * are byte-identical to the retrieval benchmark, so numbers are comparable
 * across variants and against the model table. npm run bench:binary
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmbedClient } from "../lib/embed-client";
import {
  archiveFrontier,
  fuseHybrid,
  fsProjectReader,
  ProjectCorpusCache,
  rankChunks,
  semanticRankedKeys,
} from "../extensions/recall";
import { fmt, metrics, sampleTargets, type Target } from "./bench-common";

const NANO = "jinaai/jina-embeddings-v5-text-nano-retrieval";
const FULL_DIMS = 768;
const FUSION_DEPTH = 64;
const RESCORE_POOL = 256;
const POLICY = { foreignWeight: 0.5, halfLifeHours: 4, recencyFloor: 0.25 } as const;

type Hit = { key: string; similarity: number };
type ScanFn = (qv: Float32Array, keys: string[], docs: Map<string, Float32Array>, k: number) => Hit[];

const signs = (v: Float32Array): Int8Array => Int8Array.from(v, (x) => (x >= 0 ? 1 : -1));

/** Full-precision reference: cosine over unit vectors = dot. */
const scanFloat: ScanFn = (qv, keys, docs, k) => {
  const hits = keys.map((key) => {
    const d = docs.get(key)!;
    let dot = 0;
    for (let i = 0; i < FULL_DIMS; i++) dot += qv[i] * d[i];
    return { key, similarity: dot };
  });
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
};

/** Symmetric ±1: fraction of agreeing signs. */
const scanBinarySym: ScanFn = (qv, keys, docs, k) => {
  const qs = signs(qv);
  const hits = keys.map((key) => {
    const ds = signs(docs.get(key)!);
    let agree = 0;
    for (let i = 0; i < FULL_DIMS; i++) if (qs[i] === ds[i]) agree++;
    return { key, similarity: agree / FULL_DIMS };
  });
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
};

/** Asymmetric: float query · sign(doc) — precision where it's free (the query). */
const scanBinaryAsym: ScanFn = (qv, keys, docs, k) => {
  const hits = keys.map((key) => {
    const d = docs.get(key)!;
    let dot = 0;
    for (let i = 0; i < FULL_DIMS; i++) dot += qv[i] * (d[i] >= 0 ? 1 : -1);
    return { key, similarity: dot };
  });
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
};

/** Asymmetric coarse scan, float rescore of the candidate pool, keep top k. */
const scanBinaryRescore: ScanFn = (qv, keys, docs, k) =>
  scanBinaryAsym(qv, keys, docs, RESCORE_POOL)
    .map((hit) => {
      const d = docs.get(hit.key)!;
      let dot = 0;
      for (let i = 0; i < FULL_DIMS; i++) dot += qv[i] * d[i];
      return { key: hit.key, similarity: dot };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);

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

describe("binary-quantized nano inside the hybrid protocol", () => {
  it("scores scan variants against the float reference", { timeout: 10 * 60_000 }, async () => {
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

    const slug = NANO.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(-48);
    const docs = parseCache(await readFile(path.join(os.tmpdir(), `recall-bench-vectors-${slug}.bin`)));
    expect(docs.size).toBeGreaterThan(4000);
    const client = new EmbedClient({
      workerPath: fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url)),
      model: NANO,
      dtype: "q8",
      modelDir: path.join(os.homedir(), ".pi/agent/models"),
    });
    const qvCache = new Map<string, Float32Array>();
    const queryVec = async (text: string): Promise<Float32Array> => {
      let p = qvCache.get(text);
      if (p === undefined) {
        p = (await client.query(text)) as Float32Array;
        qvCache.set(text, p);
      }
      return p;
    };

    const chunksByKey = new Map(corpus.map((c) => [c.key, c]));
    const frontier = archiveFrontier(corpus);
    const rankLexical = (query: string) =>
      rankChunks(corpus, query, POLICY.foreignWeight, POLICY.halfLifeHours, POLICY.recencyFloor);

    /** The bench-recall split condition, with the sem scan swapped out. */
    const evaluate = async (t: Target, scan: ScanFn, weight: number): Promise<number> => {
      const qv = await queryVec(t.description);
      const semKeys = semanticRankedKeys(
        scan(qv, [...chunksByKey.keys()], docs, FUSION_DEPTH),
        chunksByKey,
        POLICY,
        frontier,
      );
      const fused = fuseHybrid(rankLexical(t.queries.join(" ")), semKeys, chunksByKey, { ...POLICY, embedWeight: weight }, frontier);
      return fused.findIndex((r) => r.chunk.ref === t.chunk.ref) + 1;
    };

    const variants: Array<{ name: string; scan: ScanFn; note: string }> = [
      { name: "float 768d", scan: scanFloat, note: "reference (3KB/vec)" },
      { name: "bin·sym", scan: scanBinarySym, note: "±1 both sides, 96B/vec" },
      { name: "bin·asym", scan: scanBinaryAsym, note: "float q · sign(d), 96B/vec" },
      { name: "bin+rescore", scan: scanBinaryRescore, note: `asym scan ${RESCORE_POOL} → float rescore → ${FUSION_DEPTH}` },
    ];

    console.log(`\ncorpus: ${docs.size} vectors · ${targets.length} targets · hybrid protocol (weight 0.3)`);
    for (const v of variants) {
      const ranks = await Promise.all(targets.map((t) => evaluate(t, v.scan, 0.3)));
      console.log(`${v.name.padEnd(13)} ${fmt(metrics(ranks))}   (${v.note})`);
    }

    // Weight sweep for the winner-by-construction (asym+rescore) and the plain
    // sym binary — does a coarser sem side want a different fusion weight?
    for (const v of [variants[1], variants[3]]) {
      console.log(`\n=== weight sweep · ${v.name} ===`);
      for (const w of [0.05, 0.1, 0.15, 0.25, 0.3, 0.5]) {
        const ranks = await Promise.all(targets.map((t) => evaluate(t, v.scan, w)));
        console.log(`weight ${w.toFixed(2)}  ${fmt(metrics(ranks))}`);
      }
    }

    client.dispose();
  });
});
