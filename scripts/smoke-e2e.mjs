// E2E smoke: real EmbedClient → real embed-worker.ts (real model) → real VectorStore.
// Not part of vitest (network/model-free by house rule) — run manually:
//   node smoke-e2e.mjs
import { EmbedClient } from "../lib/embed-client.ts";
import { chunkKey, VectorStore } from "../lib/vecstore.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = await mkdtemp(path.join(tmpdir(), "e2e-"));
const notices = [];
const client = new EmbedClient({
  workerPath: fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url)),
  dtype: "q8",
  modelDir: `${process.env.HOME}/.pi/agent/models`,
  onNotice: (m) => notices.push(m),
});
const store = await VectorStore.open(path.join(dir, "recall-vectors.bin"));

try {
  client.start();
  const docs = [
    {
      key: chunkKey("s", "e1", 0, 0, "The auth token refresh must use rotation."),
      text: "The auth token refresh must use rotation.",
    },
    {
      key: chunkKey("s", "e2", 0, 0, "Fluffy curled up asleep in the corner of the rug."),
      text: "Fluffy curled up asleep in the corner of the rug.",
    },
    {
      key: chunkKey("s", "e3", 0, 0, "sqlite-vec brute-force scans 10k vectors in a millisecond."),
      text: "sqlite-vec brute-force scans 10k vectors in a millisecond.",
    },
  ];
  const t0 = Date.now();
  const vectors = await client.embed(docs);
  console.log(`embed 3 docs: ${Date.now() - t0}ms →`, vectors?.length, "vectors");
  await store.add(vectors);

  // Paraphrase query sharing NO terms with the target document.
  const t1 = Date.now();
  const qv = await client.query("kitten napping on the carpet");
  console.log(`query embed: ${Date.now() - t1}ms`);
  const hits = store.topK(
    qv,
    docs.map((d) => d.key),
    3,
  );
  for (const [i, h] of hits.entries())
    console.log(`  ${i + 1}. ${docs.find((d) => d.key === h.key)?.text.slice(0, 50)} — cos ${h.similarity.toFixed(3)}`);
  if (hits[0].key !== docs[1].key) throw new Error("paraphrase did not rank first");

  // Persistence round-trip.
  await store.close();
  const reopened = await VectorStore.open(path.join(dir, "recall-vectors.bin"));
  if (reopened.size !== 3) throw new Error(`expected 3 persisted vectors, got ${reopened.size}`);
  console.log(`persisted + reopened: ${reopened.size} vectors`);
  await reopened.close();
  if (notices.length > 0) console.log("notices:", notices);
  console.log("E2E OK");
} finally {
  client.kill();
  await store.close();
  await rm(dir, { recursive: true, force: true });
}
