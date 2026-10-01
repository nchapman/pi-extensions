import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkKey, EMBED_DIMS, KEY_HEX, packSigns, VectorStore } from "../lib/vecstore";

const RECORD_BYTES = KEY_HEX / 2 + EMBED_DIMS / 8; // key + packed ±1 bits
const HEADER_BYTES = 8; // v3 binary: magic + version + bits + keyBytes

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vecstore-"));
  file = path.join(dir, "nested", "recall-vectors.bin"); // open() must create parents
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deterministic 768-dim vector with a distinct, mostly-varying sign pattern per seed —
 * binary storage only sees signs, so basis-vector helpers are useless here. */
function signs(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  for (let d = 0; d < EMBED_DIMS; d++) v[d] = (((d * 7 + seed * 13) % 11 < 5 ? -1 : 1) * (1 + ((d + seed) % 7))) / 8;
  return v;
}

describe("chunkKey", () => {
  it("is deterministic across calls", () => {
    expect(chunkKey("s", "e", 0, 0, "text")).toBe(chunkKey("s", "e", 0, 0, "text"));
  });

  it("differs on every addressing component and on text", () => {
    const base = chunkKey("s", "e", 0, 0, "text");
    const variants = [
      chunkKey("s2", "e", 0, 0, "text"),
      chunkKey("s", "e2", 0, 0, "text"),
      chunkKey("s", "e", 1, 0, "text"),
      chunkKey("s", "e", 0, 1, "text"),
      chunkKey("s", "e", 0, 0, "other"),
    ];
    for (const v of variants) expect(v).not.toBe(base);
  });

  it("emits fixed-length hex keys", () => {
    expect(chunkKey("s", "e", 0, 0, "text")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("VectorStore", () => {
  it("creates a header-only file on first open", async () => {
    const store = await VectorStore.open(file);
    expect(store.size).toBe(0);
    await store.close();
    const bytes = await readFile(file);
    expect(bytes.length).toBe(HEADER_BYTES);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RVEC");
  });

  it("round-trips added vectors through reopen", async () => {
    const k1 = chunkKey("s", "e1", 0, 0, "one");
    const k2 = chunkKey("s", "e2", 0, 0, "two");
    const store = await VectorStore.open(file);
    await store.add([
      { key: k1, vector: signs(0) },
      { key: k2, vector: signs(1) },
    ]);
    expect(store.size).toBe(2);
    await store.close();

    const reopened = await VectorStore.open(file);
    expect(reopened.has([k1, k2, chunkKey("s", "e3", 0, 0, "nope")])).toEqual(new Set([k1, k2]));
    const hits = reopened.topK(signs(0), [k1, k2], 2);
    expect(hits[0]).toMatchObject({ key: k1, similarity: expect.closeTo(1, 5) });
    expect(hits[1].key).toBe(k2);
    expect(hits[1].similarity).toBeLessThan(1);
    await reopened.close();
  });

  it("writes exactly one record per distinct key (duplicates skipped)", async () => {
    const k = chunkKey("s", "e", 0, 0, "text");
    const store = await VectorStore.open(file);
    await store.add([{ key: k, vector: signs(0) }]);
    await store.add([{ key: k, vector: signs(0) }]);
    expect(store.size).toBe(1);
    await store.close();
    expect((await readFile(file)).length).toBe(HEADER_BYTES + RECORD_BYTES);
  });

  it("stores only signs — magnitude is irrelevant to what lands in the file", async () => {
    const k = chunkKey("s", "e", 0, 0, "text");
    const store = await VectorStore.open(file);
    await store.add([{ key: k, vector: signs(2) }]);
    await store.close();

    const reopened = await VectorStore.open(file);
    const scaled = Float32Array.from(signs(2), (x) => x * 137.5); // same signs, huge magnitudes
    const hits = reopened.topK(scaled, [k], 1);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
    await reopened.close();
  });

  it("restricts topK to candidates and honors k", async () => {
    const keys = [0, 1, 2, 3].map((i) => chunkKey("s", `e${i}`, 0, 0, `t${i}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((key, i) => ({ key, vector: signs(i) })));
    const hits = store.topK(signs(0), keys.slice(0, 2), 10);
    expect(hits.map((h) => h.key)).toEqual([keys[0], keys[1]]);
    expect(store.topK(signs(0), [], 5)).toEqual([]);
    await store.close();
  });

  it("breaks similarity ties deterministically by key", async () => {
    // Two identical vectors: equal similarity, key order decides.
    const [a, z] = ["aaaa11", "zzzz22"].map((entry) => chunkKey("s", entry, 0, 0, "same text"));
    const store = await VectorStore.open(file);
    await store.add([
      { key: a, vector: signs(0) },
      { key: z, vector: signs(0) },
    ]);
    const hits = store.topK(signs(0), [a, z], 2);
    expect(hits.map((h) => h.key)).toEqual([a, z].sort());
    await store.close();
  });

  it("truncates a torn trailing record on load", async () => {
    const k = chunkKey("s", "e", 0, 0, "text");
    const store = await VectorStore.open(file);
    await store.add([{ key: k, vector: signs(0) }]);
    await store.close();
    // Simulate a crash mid-append: dangling partial record bytes.
    await writeFile(file, Buffer.alloc(13, 0xab), { flag: "a" });

    const healed = await VectorStore.open(file);
    expect(healed.size).toBe(1);
    expect(healed.has([k])).toEqual(new Set([k]));
    await healed.close();
    expect((await readFile(file)).length).toBe(HEADER_BYTES + RECORD_BYTES);
  });

  it("resets an unrecognized header instead of misreading it", async () => {
    // VectorStore.open creates parents; this test writes the file first, so make them.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from("GARBAGE!not a vector store at all, really"));
    const store = await VectorStore.open(file);
    expect(store.size).toBe(0);
    const k = chunkKey("s", "e", 0, 0, "text");
    await store.add([{ key: k, vector: signs(0) }]);
    await store.close();
    expect((await readFile(file)).length).toBe(HEADER_BYTES + RECORD_BYTES);
    const reopened = await VectorStore.open(file);
    expect(reopened.size).toBe(1);
    await reopened.close();
  });

  it("add() after close() is a no-op, not a crash", async () => {
    const store = await VectorStore.open(file);
    await store.close();
    await store.add([{ key: chunkKey("s", "e", 0, 0, "t"), vector: signs(0) }]);
  });

  it("compact() keeps only live keys, preserves order, and appends land in the new file", async () => {
    const keys = [1, 2, 3, 4].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    const live = new Set([keys[0], keys[3]]);
    const reclaimed = await store.compact(live, { minDeadBytes: 0, minDeadRatio: 0 });
    expect(reclaimed).toBe(2 * RECORD_BYTES);
    expect(store.size).toBe(2);
    // Stale-handle regression: after the tmp+rename swap, appends must reach
    // the NEW file, and a reopen must see exactly live + appended.
    const fresh = chunkKey("s", "e9", 0, 0, "fresh");
    await store.add([{ key: fresh, vector: signs(5) }]);
    await store.close();
    const reopened = await VectorStore.open(file);
    expect(reopened.has([keys[0], keys[3], fresh, keys[1]])).toEqual(new Set([keys[0], keys[3], fresh]));
    await reopened.close();
    const bytes = await readFile(file);
    expect(bytes.length).toBe(HEADER_BYTES + 3 * RECORD_BYTES);
    // Record order on disk is preserved (keep order, then later appends).
    const keysInOrder: string[] = [];
    for (let i = 0; i < 3; i++)
      keysInOrder.push(
        bytes.subarray(HEADER_BYTES + i * RECORD_BYTES, HEADER_BYTES + i * RECORD_BYTES + KEY_HEX / 2).toString("hex"),
      );
    expect(keysInOrder).toEqual([keys[0], keys[3], fresh]);
  });

  it("compact() is a no-op below the dead-byte gates", async () => {
    const keys = [1, 2].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    const bytesBefore = (await readFile(file)).length;
    expect(await store.compact(new Set([keys[0]]))).toBe(0); // defaults: 4MB floor not met
    expect(store.size).toBe(2);
    expect((await readFile(file)).length).toBe(bytesBefore);
    await store.close();
  });

  it("compact() on a closed store is a no-op, never a resurrected handle", async () => {
    const keys = [1, 2, 3].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    await store.close();
    expect(await store.compact(new Set([keys[0]]), { minDeadBytes: 0, minDeadRatio: 0 })).toBe(0);
    expect(store.size).toBe(0); // close() cleared the map; compact must not repopulate it
  });

  it("an all-dead compaction empties the file and later appends still land", async () => {
    const keys = [1, 2].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    expect((await store.compact(new Set(), { minDeadBytes: 0, minDeadRatio: 0 })).valueOf()).toBeGreaterThan(0);
    expect(store.size).toBe(0);
    const fresh = chunkKey("s", "e9", 0, 0, "fresh after empty");
    await store.add([{ key: fresh, vector: signs(1) }]);
    await store.close();
    expect((await readFile(file)).length).toBe(HEADER_BYTES + RECORD_BYTES); // header-only, then one record
    const reopened = await VectorStore.open(file);
    expect(reopened.size).toBe(1);
    await reopened.close();
  });

  it("a zero-dead compaction is a no-op even with zeroed gates", async () => {
    const keys = [1, 2].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    expect(await store.compact(new Set(keys), { minDeadBytes: 0, minDeadRatio: 0 })).toBe(0);
    await store.close();
  });

  it("compact() fails open when the tmp file cannot be written", async () => {
    const keys = [1, 2, 3].map((n) => chunkKey("s", `e${n}`, 0, 0, `text ${n}`));
    const store = await VectorStore.open(file);
    await store.add(keys.map((k, i) => ({ key: k, vector: signs(i) })));
    // Read-only directory: tmp creation fails inside compact, not at open.
    // (chmod does not restrict root, so this test assumes a non-root runner —
    // fine for a personal macOS package.)
    await chmod(path.dirname(file), 0o500);
    try {
      expect(await store.compact(new Set([keys[0]]), { minDeadBytes: 0, minDeadRatio: 0 })).toBe(0);
      expect(store.size).toBe(3); // map untouched
      const appended = chunkKey("s", "e8", 0, 0, "appended after failed compaction");
      await store.add([{ key: appended, vector: signs(1) }]); // rollback kept a working handle
      expect(store.has([appended]).size).toBe(1);
    } finally {
      await chmod(path.dirname(file), 0o700);
      await store.close();
    }
  });
});

describe("VectorStore binary format (v3)", () => {
  it("packSigns encodes bit i exactly when dim i is non-negative", () => {
    const v = new Float32Array(EMBED_DIMS).fill(-1);
    v[0] = 1; // -> bit 0 set
    v[9] = 0; // zero encodes as non-negative -> bit 9 set
    v[EMBED_DIMS - 1] = 0.5; // -> last bit set
    const packed = packSigns(v);
    expect(packed.length).toBe(EMBED_DIMS / 8);
    expect(packed[0] & 1).toBe(1);
    expect((packed[1] >> 1) & 1).toBe(1);
    expect(packed[EMBED_DIMS / 8 - 1] & 0x80).toBe(0x80);
    // and every other bit is clear
    let set = 0;
    for (const b of packed) {
      let x = b;
      while (x) {
        set += x & 1;
        x >>= 1;
      }
    }
    expect(set).toBe(3);
  });

  it("packSigns rejects wrong-width vectors", () => {
    expect(() => packSigns(new Float32Array(64))).toThrow(/768 dims/);
  });

  it("resets float-era (v1/v2) files via the version bump", async () => {
    const v2 = path.join(dir, "floatera.bin");
    await mkdir(path.dirname(v2), { recursive: true });
    // A plausible v2-era header: version 2, dims 768, key width 16 — must reset, not misread.
    const head = Buffer.alloc(16);
    head.write("RVEC", 0, "latin1");
    head[4] = 2;
    head.writeUInt16LE(768, 5);
    head[7] = 16;
    await writeFile(v2, Buffer.concat([head, Buffer.alloc(16 + 768 * 4)]));
    const store = await VectorStore.open(v2);
    expect(store.size).toBe(0);
    await store.add([{ key: "a".repeat(KEY_HEX), vector: signs(0) }]);
    await store.close();
    expect((await readFile(v2)).length).toBe(8 + RECORD_BYTES); // rewritten in v3
  });

  it("add() skips wrong-width vectors instead of corrupting records", async () => {
    const mixed = path.join(dir, "mixedwidth.bin");
    const store = await VectorStore.open(mixed);
    await store.add([
      { key: "d".repeat(KEY_HEX), vector: signs(0) },
      { key: "e".repeat(KEY_HEX), vector: new Float32Array(128) },
    ]);
    expect(store.size).toBe(1);
    expect((await store.has(["e".repeat(KEY_HEX)])).size).toBe(0);
    await store.close();
  });

  it("topK with a wrong-width query returns nothing rather than garbage", async () => {
    const qw = path.join(dir, "qwidth.bin");
    const store = await VectorStore.open(qw);
    await store.add([{ key: "f".repeat(KEY_HEX), vector: signs(0) }]);
    expect(store.topK(new Float32Array(64), ["f".repeat(KEY_HEX)], 1)).toEqual([]);
    await store.close();
  });
});
