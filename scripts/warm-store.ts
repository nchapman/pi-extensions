/**
 * Corpus warmer — rebuilds a session dir's vector store through the exact
 * production path (real worker, real store file, real client), embedding
 * every chunk the project corpus can see that isn't cached yet.
 *
 * Operationally useful after a store-format migration (v2 float → v3 binary
 * reset every session dir's cache; normal catch-up re-embeds lazily, 128
 * chunks per settled turn — this does the whole thing in one pass, ~17
 * chunks/s on the nano). Run it under its own vitest config via
 *   npm run warm:store            # this project's session dir
 *   BENCH_DIR=<dir> npm run warm:store
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmbedClient } from "../lib/embed-client";
import { RECORD_BYTES, VectorStore } from "../lib/vecstore";
import { fsProjectReader, ProjectCorpusCache } from "../extensions/recall";

// Gentle by design: this is an operational utility, never urgent — one core
// here, and the taskpolicy wrapper in package.json keeps even that off the P-cores.
process.env.PI_RECALL_EMBED_THREADS ??= "1";

describe("corpus warmer", () => {
  it("embeds every uncached chunk in the project corpus", { timeout: 60 * 60_000 }, async () => {
    const dir =
      process.env.BENCH_DIR?.trim() ||
      path.join(os.homedir(), ".pi/agent/sessions/--Users-nchapman-Code-pi-extensions--");
    const storeFile = path.join(dir, "recall-vectors.bin");

    const cache = new ProjectCorpusCache(fsProjectReader, 512 * 1024 * 1024);
    const unreadable = await cache.refresh(dir, undefined);
    const chunks = [...cache.list()].flatMap((c) => c.chunks);
    expect(chunks.length, `no corpus under ${dir}`).toBeGreaterThan(0);

    const store = await VectorStore.open(storeFile);
    // try/finally: a thrown add/embed must not leak the store fd or orphan
    // the ONNX worker child — an orphan burning CPU after a failed warm is
    // exactly what this script exists to avoid.
    let client: EmbedClient | undefined;
    let skippedBatches = 0;
    try {
      const pending = chunks.filter((c) => !store.has([c.key]).has(c.key));
      console.log(
        `\ncorpus: ${chunks.length} chunks (${unreadable} unreadable) · cached ${store.size} · embedding ${pending.length}`,
      );

      if (pending.length > 0) {
        client = new EmbedClient({
          workerPath: fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url)),
          dtype: process.env.PI_RECALL_EMBED_DTYPE ?? "q8",
          modelDir: process.env.PI_RECALL_MODEL_DIR ?? path.join(os.homedir(), ".pi/agent/models"),
          embedBaseTimeoutMs: 30_000,
          embedPerItemMs: 5_000,
        });
        const t0 = Date.now();
        for (let i = 0; i < pending.length; i += 128) {
          const batch = pending.slice(i, i + 128);
          const embedded = await client.embed(batch.map((c) => ({ key: c.key, text: c.text })));
          if (embedded === undefined) {
            // A dropped batch means a semantic-degraded store with a green
            // exit — the exact silent failure this run exists to prevent.
            skippedBatches++;
            console.warn(`  batch ${i / 128 + 1}: embed failed (worker/timeout) — ${batch.length} chunks NOT cached`);
          } else {
            await store.add(embedded);
          }
          const done = Math.min(i + 128, pending.length);
          const rate = done / Math.max(1, (Date.now() - t0) / 1000);
          console.log(`  ${done}/${pending.length} (${rate.toFixed(1)} chunks/s)`);
        }
      }
      console.log(`done: ${store.size} vectors cached (${store.size * RECORD_BYTES} bytes)`);
      expect(
        skippedBatches,
        `${skippedBatches} batch(es) failed — store is partially warm, rerun npm run warm:store to resume`,
      ).toBe(0);
    } finally {
      client?.dispose();
      await store.close();
    }
  });
});
