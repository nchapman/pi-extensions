/**
 * Recall retrieval benchmark over a REAL session directory.
 *
 * Measures whether the description/queries split actually beats the old
 * single-compromise-query, and sweeps the fusion weight. Ground truth is
 * synthetic-but-derived: sample real archived chunks as targets, derive
 * `queries` by rarity-ranked keyword extraction (what a model does when it
 * remembers exact terms) and a `description` by masking every grep-able
 * token out of the chunk text (prose meaning retained, exact terms removed —
 * exactly the scenario the split exists for). LLM-written paraphrases would
 * be more realistic; masking is deterministic, reproducible, and lower-bounds
 * the semantic side honestly.
 *
 * Usage: npm run bench:recall — with optional env: BENCH_DIR=<sessionDir>
 *       BENCH_TARGETS=50 BENCH_CORPUS=900 BENCH_FRESH=1
 * Not part of `npm test` (separate vitest config); spawns the real embed
 * worker. Vector cache lives in /tmp so reruns are fast.
 */

import { copyFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmbedClient } from "../lib/embed-client";
import { VectorStore } from "../lib/vecstore";
import {
  archiveFrontier,
  fsProjectReader,
  fuseHybrid,
  ProjectCorpusCache,
  rankChunks,
  semanticRankedKeys,
  tokenize,
  type RecallChunk,
} from "../extensions/recall";

const DEFAULT_DIR = path.join(
  os.homedir(),
  ".pi/agent/sessions/--Users-nchapman-Code-pi-extensions--",
);

// Ranking policy mirrors recall's defaults (PI_RECALL_* unset).
const POLICY = { foreignWeight: 0.5, halfLifeHours: 4, recencyFloor: 0.25 } as const;
const FUSION_DEPTH = 64;

function arg(name: string, dflt: number): number {
  const v = Number(process.env[`BENCH_${name.toUpperCase()}`]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function dirArg(): string {
  return process.env.BENCH_DIR || DEFAULT_DIR;
}

/** Grep-able token: identifiers, paths, versions — anything you'd type into a keyword search. */
function isGreppy(t: string): boolean {
  return t.includes("_") || t.includes("/") || /\d/.test(t) || /^[a-z]+[A-Z]/.test(t) || t.length >= 7;
}

/** Description = the chunk with every grep-able token masked to prose placeholders. */
function maskToProse(text: string): string {
  return text
    .replace(/`[^`\n]*`|"([^"\\\n]|\\.)*"/g, (s) => (/[/.]/.test(s) ? "the file" : "the name"))
    .replace(/\b[\w.-]+\/[\w./-]+\b/g, "the file")
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, "the setting")
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, "the setting")
    .replace(/\b\d[\d.,]*\b/g, "several")
    .replace(/[ \t]+/g, " ")
    .trim();
}

interface Target {
  chunk: RecallChunk;
  description: string;
  queries: string[];
}

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

function fmt(m: Metrics): string {
  return `Hit@1 ${(m.hit1 * 100).toFixed(0).padStart(3)}%  Hit@5 ${(m.hit5 * 100).toFixed(0).padStart(3)}%  MRR@10 ${m.mrr10.toFixed(3)}`;
}

describe("recall retrieval benchmark", () => {
  it("evaluates the description/queries split on real session data", { timeout: 20 * 60_000 }, async () => {
    const dir = dirArg();
    const wantTargets = arg("targets", 50);
    const corpusCap = arg("corpus", 900);
    const fresh = process.env.BENCH_FRESH === "1";

    // -- corpus: newest sessions first, capped ---------------------------------
    const cache = new ProjectCorpusCache(fsProjectReader, 512 * 1024 * 1024);
    const unreadable = await cache.refresh(dir, undefined);
    const corpora = [...cache.list()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Newest sessions first; the cap trims mid-session (bench-only; a partial
    // session's entries are still self-consistent retrieval targets).
    const corpus = corpora
      .flatMap((c) => c.chunks)
      .slice(0, corpusCap);
    expect(corpus.length, `no corpus chunks under ${dir}`).toBeGreaterThan(100);
    console.log(`\ncorpus: ${corpus.length} chunks / ${corpora.length} sessions (${dir}), ${unreadable} unreadable`);

    // -- embeddings: real worker, /tmp cache seeded from the prod store --------
    // Seed from the prod store once — afterwards the bench cache is strictly
    // larger (it accumulates every run's corpus), so re-seeding would wipe it
    // and force a full re-embed on every rerun.
    const benchVec = path.join(os.tmpdir(), "recall-bench-vectors.bin");
    const prodVec = path.join(dir, "recall-vectors.bin");
    if (!fresh && !(await stat(benchVec).then(() => true, () => false)))
      await copyFile(prodVec, benchVec).catch(() => {});
    const store = await VectorStore.open(benchVec);
    const pending = corpus.filter((c) => !store.has([c.key]).has(c.key));
    const client = new EmbedClient({
      workerPath: fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url)),
      dtype: process.env.PI_RECALL_EMBED_DTYPE ?? "q8",
      modelDir: process.env.PI_RECALL_MODEL_DIR ?? path.join(os.homedir(), ".pi/agent/models"),
      embedBaseTimeoutMs: 30_000,
      embedPerItemMs: 5_000,
      queryTimeoutMs: 30_000,
    });
    if (pending.length > 0) {
      console.log(`embedding ${pending.length} chunks (slow first run; reruns reuse the /tmp cache)…`);
      const t0 = Date.now();
      for (let i = 0; i < pending.length; i += 128) {
        const batch = pending.slice(i, i + 128);
        const vectors = await client.embed(batch.map((c) => ({ key: c.key, text: c.text })));
        expect(vectors, "embed worker failed open — benchmark cannot run").toBeDefined();
        await store.add(vectors ?? []);
        console.log(`  ${Math.min(i + 128, pending.length)}/${pending.length}`);
      }
      console.log(
        `embedded in ${((Date.now() - t0) / 1000).toFixed(0)}s (${(pending.length / ((Date.now() - t0) / 1000)).toFixed(1)} chunks/s)`,
      );
    }

    // -- targets: one per entry, distinctive chunks only -----------------------
    const df = new Map<string, number>();
    for (const c of corpus) for (const t of new Set(tokenize(c.text))) df.set(t, (df.get(t) ?? 0) + 1);
    const eligible: Target[] = [];
    const seenEntries = new Set<string>();
    for (const c of corpus) {
      if (seenEntries.has(c.ref) || c.text.length < 240) continue;
      seenEntries.add(c.ref);
      const description = maskToProse(c.text);
      if (description.length < 120) continue;
      const toks = [...new Set(tokenize(c.text))]
        .filter(isGreppy)
        .map((t) => ({ t, rare: 1 / (df.get(t) ?? 1) }))
        .sort((a, b) => b.rare - a.rare)
        .slice(0, 6)
        .map((x) => x.t);
      if (toks.length < 4) continue;
      eligible.push({
        chunk: c,
        description,
        queries: [toks.slice(0, 2).join(" "), toks.slice(2, 4).join(" "), toks.slice(4, 6).join(" ")],
      });
    }
    // Even sampling across eligibility order (≈ corpus/recency order).
    const step = Math.max(1, Math.floor(eligible.length / wantTargets));
    const targets = eligible.filter((_, i) => i % step === 0).slice(0, wantTargets);
    expect(targets.length, "not enough distinctive chunks for targets").toBeGreaterThanOrEqual(Math.min(10, wantTargets));
    console.log(`targets: ${targets.length} (of ${eligible.length} eligible)`);
    console.log(`sample — desc: "${targets[0].description.slice(0, 90)}…"`);
    console.log(`          queries: ${targets[0].queries.join(" | ")}`);

    // -- eval ------------------------------------------------------------------
    const chunksByKey = new Map(corpus.map((c) => [c.key, c]));
    const frontier = archiveFrontier(corpus);
    const qvCache = new Map<string, Promise<Float32Array | undefined>>();
    const embedQuery = (text: string): Promise<Float32Array | undefined> => {
      let p = qvCache.get(text);
      if (p === undefined) {
        p = client.query(text);
        qvCache.set(text, p);
      }
      return p;
    };
    const rankLexical = (query: string) =>
      rankChunks(corpus, query, POLICY.foreignWeight, POLICY.halfLifeHours, POLICY.recencyFloor);
    const semanticKeysOf = async (text: string) => {
      const qv = await embedQuery(text);
      if (qv === undefined) return [];
      return semanticRankedKeys(store.topK(qv, chunksByKey.keys(), FUSION_DEPTH), chunksByKey, POLICY, frontier);
    };

    /** Rank a target under one condition; returns the target entry's rank (0 = absent). */
    const evaluate = async (
      t: Target,
      cond: "old-prose" | "old-keywords" | "split" | "lex-only" | "sem-only",
      weight = 0.7,
    ): Promise<number> => {
      const descQueries = t.queries.join(" ");
      if (cond === "lex-only") {
        return rankLexical(descQueries).findIndex((r) => r.chunk.ref === t.chunk.ref) + 1;
      }
      if (cond === "sem-only") {
        return (await semanticKeysOf(t.description)).indexOf(t.chunk.key) + 1;
      }
      const lexText = cond === "old-prose" ? t.description : descQueries;
      const semText = cond === "old-keywords" ? descQueries : t.description;
      const lex = rankLexical(lexText);
      const semKeys = await semanticKeysOf(semText);
      const fused = fuseHybrid(lex, semKeys, chunksByKey, { ...POLICY, embedWeight: weight }, frontier);
      return fused.findIndex((r) => r.chunk.ref === t.chunk.ref) + 1;
    };

    const t0 = Date.now();
    console.log("\n=== condition matrix (weight 0.7) ===");
    const conditions: Array<{ name: string; cond: Parameters<typeof evaluate>[1] }> = [
      { name: "old · prose query → both sides", cond: "old-prose" },
      { name: "old · keyword query → both sides", cond: "old-keywords" },
      { name: "new · split (desc→sem, queries→lex)", cond: "split" },
      { name: "lex-only on queries (BM25 ceiling)", cond: "lex-only" },
      { name: "sem-only on description (embed ceiling)", cond: "sem-only" },
    ];
    for (const { name, cond } of conditions) {
      const ranks = await Promise.all(targets.map((t) => evaluate(t, cond)));
      console.log(`${name.padEnd(42)} ${fmt(metrics(ranks))}`);
    }

    console.log("\n=== embedWeight sweep (split condition) ===");
    for (const w of [0.15, 0.25, 0.3, 0.5, 0.7, 1.0]) {
      const ranks = await Promise.all(targets.map((t) => evaluate(t, "split", w)));
      console.log(`weight ${w.toFixed(2)}  ${fmt(metrics(ranks))}${w === 0.3 ? "   ← current default" : ""}`);
    }

    await client.dispose();
    await store.close();
    console.log(`\neval time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
});
