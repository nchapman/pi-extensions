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
 *       BENCH_TARGETS=50 BENCH_CORPUS=900 BENCH_FRESH=1 BENCH_SNAPSHOT=1
 * Not part of `npm test` (separate vitest config); spawns the real embed
 * worker. The corpus is snapshotted into /tmp once (BENCH_SNAPSHOT=1
 * refreshes) so every run scores the exact same frozen targets; the live
 * session dir keeps growing, which made earlier runs wobble by points.
 * Vector cache lives in /tmp so reruns are fast.
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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
} from "../extensions/recall";
import { fmt, metrics, projectSessionDir, sampleTargets, type Target } from "./bench-common";

const DEFAULT_DIR = projectSessionDir(process.cwd(), os.homedir(), path.join);

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

describe("recall retrieval benchmark", () => {
  it(
    "evaluates the description/queries split on real session data",
    { timeout: Number(process.env.BENCH_TIMEOUT_MS) || 20 * 60_000 },
    async () => {
      const dir = dirArg();
      const wantTargets = arg("targets", 50);
      const corpusCap = arg("corpus", 900);
      const fresh = process.env.BENCH_FRESH === "1";

      // -- corpus: frozen snapshot (stable targets across runs) --------------
      // The live session dir grows while we work; a frozen copy makes run-to-run
      // and model-to-model numbers comparable. The snapshot dir is keyed to the
      // SOURCE dir (path hash) so pointing BENCH_DIR at another project can never
      // silently score a stale snapshot of the previous one. BENCH_SNAPSHOT=1 re-freezes.
      const snapDir = path.join(
        os.tmpdir(),
        `recall-bench-corpus-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`,
      );
      const snapFiles = () => readdir(snapDir).then((f) => f.filter((n) => n.endsWith(".jsonl")));
      const existing = await snapFiles().then(
        (f) => f.length > 0,
        () => false,
      );
      if (!existing || process.env.BENCH_SNAPSHOT === "1") {
        await mkdir(snapDir, { recursive: true });
        for (const f of await readdir(dir))
          if (f.endsWith(".jsonl")) await copyFile(path.join(dir, f), path.join(snapDir, f));
        console.log(
          `corpus snapshot: ${await snapFiles().then((f) => f.length)} files copied ${dir} → ${snapDir} (frozen; BENCH_SNAPSHOT=1 refreshes)`,
        );
      }

      // -- corpus: newest sessions first, capped ---------------------------------
      const cache = new ProjectCorpusCache(fsProjectReader, 512 * 1024 * 1024);
      const unreadable = await cache.refresh(snapDir, undefined);
      const corpora = [...cache.list()].sort((a, b) => b.mtimeMs - a.mtimeMs);
      // Newest sessions first; the cap trims mid-session (bench-only; a partial
      // session's entries are still self-consistent retrieval targets).
      const corpus = corpora.flatMap((c) => c.chunks).slice(0, corpusCap);
      expect(corpus.length, `no corpus chunks under ${dir}`).toBeGreaterThan(100);
      console.log(
        `\ncorpus: ${corpus.length} chunks / ${corpora.length} sessions (${snapDir}), ${unreadable} unreadable`,
      );

      // -- embeddings: real worker, /tmp cache ----------------------------------
      const benchVec = path.join(os.tmpdir(), "recall-bench-vectors.bin");
      const prodVec = path.join(dir, "recall-vectors.bin");
      if (
        !fresh &&
        !(await stat(benchVec).then(
          () => true,
          () => false,
        ))
      )
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
      const targets = sampleTargets(corpus, wantTargets);
      expect(targets.length, "not enough distinctive chunks for targets").toBeGreaterThanOrEqual(
        Math.min(10, wantTargets),
      );
      console.log(`targets: ${targets.length}`);
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
        console.log(`weight ${w.toFixed(2)}  ${fmt(metrics(ranks))}${w === 0.15 ? "   ← current default" : ""}`);
      }

      await client.dispose();
      await store.close();
      console.log(`\neval time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    },
  );
});
