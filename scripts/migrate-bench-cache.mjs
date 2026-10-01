// One-off: rewrite v1 bench vector-cache headers (8-byte) to v2 (16-byte with
// model fingerprint) without touching records — the record layout is
// dims-keyed and unchanged between versions, so this is a header swap.
// Usage: node scripts/migrate-bench-cache.mjs <file> <modelId>
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

const [file, model] = process.argv.slice(2);
if (!file || !model) {
  console.error("usage: node migrate-bench-cache.mjs <cacheFile> <modelId>");
  process.exit(1);
}
const h = await open(file, "r+");
const head = Buffer.alloc(8);
await h.read(head, 0, 8, 0);
if (head.subarray(0, 4).toString("latin1") !== "RVEC" || head[4] !== 1) {
  console.error(`${file}: not a v1 store (magic/version mismatch) — nothing to do`);
  await h.close();
  process.exit(0);
}
const dims = head.readUInt16LE(5);
const body = await h.readFile();
const records = body.subarray(8);
const v2 = Buffer.alloc(16 + records.length);
v2.write("RVEC", 0, "latin1");
v2[4] = 2;
v2.writeUInt16LE(dims, 5);
v2[7] = head[7];
v2.write(createHash("sha256").update(model).digest("hex").slice(0, 16), 8, 8, "hex");
records.copy(v2, 16);
await h.truncate(0);
// Explicit position 0: without it the write lands at the handle's current
// position — EOF after readFile() — producing a sparse corrupt file.
await h.write(v2, 0, v2.length, 0);
await h.close();
console.log(`${file}: migrated v1→v2 (dims ${dims}, ${(records.length / (head[7] + dims * 4)) | 0} records)`);
