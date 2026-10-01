/**
 * Flat-file binary vector store — the persistence half of recall's semantic
 * cache.
 *
 * One append-only binary file per session directory: an 8-byte header then
 * fixed-size records of [16-byte truncated key | 96 bytes of packed ±1 bits]
 * (the jina-v5-text-nano's 768 dims, one bit each — sign quantization).
 * Everything loads into a Map<key, Uint8Array> at open and search is a
 * brute-force Hamming-agreement scan (popcount of XOR) over candidate keys —
 * no database, no query engine. Binary on purpose, not as a compromise: the
 * measured result (README, bench history) is that sign votes beat the same
 * model's float vectors inside hybrid retrieval — binarizing discards the
 * small magnitudes where q8 quantization noise lives — while records shrink
 * 27× (3072→112 bytes) and the scan becomes integer popcount.
 *
 * This works because the store is a pure *cache*: keys are content hashes, so
 * a vector can never be wrong for its key, only missing — every failure mode,
 * including a torn final record from a crash, degrades to "BM25 covers it,"
 * never to wrong search results. Concurrent writers (two pi sessions in one
 * project dir) append fixed-size records in single write() calls, which local
 * filesystems serialize; the load-time tear check backspaces that assumption.
 *
 * Vector bytes are stored in platform endianness (every platform pi runs on
 * is little-endian); the header records the format so a mismatch resets
 * rather than misreads. Dead bytes (rewound branches, deleted sessions,
 * edited text) are reclaimed by compact() — the caller passes the keys its
 * corpus view can still see, and the rewrite is self-gated so it only runs
 * when dead bytes dominate the file (amortized O(1) rewrites per appended
 * byte). Until that gate trips, dead records are harmless: invisible to
 * search, 112 bytes each.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Float-vector width the model emits — and the bit count each record stores. */
export const EMBED_DIMS = 768;
const BITS = EMBED_DIMS;
const PACKED_BYTES = BITS / 8;
/** Truncated sha256: 128-bit keys make collisions negligible at recall scale (~10⁻²³ at 100k chunks). */
export const KEY_HEX = 32;
const KEY_BYTES = KEY_HEX / 2;
export const RECORD_BYTES = KEY_BYTES + PACKED_BYTES;

const MAGIC = "RVEC";
const FORMAT_VERSION = 3;
const HEADER_BYTES = 8; // magic(4) + version(1) + bits(2 LE) + keyBytes(1)

/** popcount lookup for one byte — the whole scan reduces to 96 of these per record. */
const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

/** Quantize a unit float vector to its packed sign bits (bit i = dim i ≥ 0). */
export function packSigns(v: Float32Array): Uint8Array {
  if (v.length !== EMBED_DIMS) throw new Error(`expected ${EMBED_DIMS} dims, got ${v.length}`);
  const out = new Uint8Array(PACKED_BYTES);
  for (let i = 0; i < BITS; i++) if (v[i] >= 0) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/**
 * Stable identity of one indexable chunk: the chunk's intrinsic address —
 * session, entry, section ordinal, chunk ordinal within the section — plus
 * the text itself. The same chunk derives the same key in every session that
 * parses it (current session today, foreign session file after it closes), so
 * vectors embed once, ever; any change to chunking or content simply produces
 * new keys and the old bytes become inert orphans.
 */
export function chunkKey(
  sessionId: string,
  entryId: string,
  sectionIdx: number,
  chunkIdx: number,
  text: string,
): string {
  const h = createHash("sha256");
  h.update(`${sessionId}|${entryId}|${sectionIdx}|${chunkIdx}|`);
  h.update(text);
  return h.digest("hex").slice(0, KEY_HEX);
}

export interface VectorHit {
  key: string;
  /** Sign-agreement fraction in [0, 1] — the binary "similarity". */
  similarity: number;
}

export class VectorStore {
  private vectors = new Map<string, Uint8Array>();
  private file: Awaited<ReturnType<typeof open>> | null = null;
  private readonly filePath: string;
  // Set synchronously at close() so an in-flight compact() observes it before
  // reopening — otherwise compact resurrects a handle nobody owns (fd leak).
  private closed = false;

  private constructor(file: Awaited<ReturnType<typeof open>>, filePath: string) {
    this.file = file;
    this.filePath = filePath;
  }

  /** Records currently cached. */
  get size(): number {
    return this.vectors.size;
  }

  /**
   * Open (creating if absent) the store file and load all records. Damage
   * self-heals: a torn trailing record is truncated away, and an unrecognized
   * header (including float-era v1/v2 files) resets the store — losing cached
   * vectors only ever costs re-embedding. Throws only on conditions the
   * caller cannot heal (unreadable directory, permissions) so wiring can
   * fail open.
   */
  static async open(file: string): Promise<VectorStore> {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "a+");
    const store = new VectorStore(handle, file);
    const buf = await handle.readFile();
    const headerOk =
      buf.length >= HEADER_BYTES &&
      buf.subarray(0, 4).toString("latin1") === MAGIC &&
      buf[4] === FORMAT_VERSION &&
      buf.readUInt16LE(5) === BITS &&
      buf[7] === KEY_BYTES;
    if (headerOk) {
      await store.load(buf);
      return store;
    }
    if (buf.length > 0)
      console.error(`recall: vector store ${file} has an unrecognized header — resetting (vectors will re-embed)`);
    await store.reset();
    return store;
  }

  /** Parse the (already header-validated) body into the map; trim torn tail. */
  private async load(buf: Buffer): Promise<void> {
    const body = buf.length - HEADER_BYTES;
    const full = Math.floor(body / RECORD_BYTES);
    for (let i = 0; i < full; i++) {
      const at = HEADER_BYTES + i * RECORD_BYTES;
      const key = buf.subarray(at, at + KEY_BYTES).toString("hex");
      this.vectors.set(key, new Uint8Array(buf.subarray(at + KEY_BYTES, at + RECORD_BYTES)));
    }
    const torn = body - full * RECORD_BYTES;
    if (torn > 0) {
      console.error(`recall: vector store ${this.filePath} has a torn trailing record (${torn} bytes) — truncating`);
      await this.file!.truncate(HEADER_BYTES + full * RECORD_BYTES);
    }
  }

  /** Rewrite the file from scratch: truncate first — the handle is append-mode, so the header write then lands at offset 0. */
  private async reset(): Promise<void> {
    await this.file!.truncate(0);
    await this.file!.write(makeHeader(), 0, HEADER_BYTES);
  }

  /** Which of `keys` are already cached. */
  has(keys: readonly string[]): Set<string> {
    const present = new Set<string>();
    for (const key of keys) if (this.vectors.has(key)) present.add(key);
    return present;
  }

  /**
   * Cache sign bits for absent keys. The map is updated before the append
   * commits and rolled back if it fails, so concurrent add() calls never
   * double-append and a failed write simply retries on the next catch-up.
   * Vectors of the wrong width are skipped, not replaced or thrown — a key
   * is its content's hash, so "newer" means identical.
   */
  async add(items: readonly { key: string; vector: Float32Array }[]): Promise<void> {
    const fresh: Array<{ key: string; packed: Uint8Array }> = [];
    for (const item of items) {
      if (this.vectors.has(item.key) || item.vector.length !== EMBED_DIMS) continue;
      fresh.push({ key: item.key, packed: packSigns(item.vector) });
    }
    if (fresh.length === 0 || this.file === null) return;
    for (const item of fresh) this.vectors.set(item.key, item.packed);
    const record = Buffer.alloc(fresh.length * RECORD_BYTES);
    let at = 0;
    for (const item of fresh) {
      record.write(item.key, at, KEY_BYTES, "hex");
      Buffer.from(item.packed.buffer, item.packed.byteOffset, item.packed.byteLength).copy(record, at + KEY_BYTES);
      at += RECORD_BYTES;
    }
    try {
      await this.file.write(record, 0, record.length);
    } catch (err) {
      for (const item of fresh) this.vectors.delete(item.key);
      console.error(`recall: vector store write failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /**
   * Reclaim dead bytes: rewrite the file keeping only records whose key is in
   * `keep`, preserving order. Self-gated — returns 0 without touching disk
   * unless dead bytes clear both a floor (default 4MB) and a fraction of the
   * file (default half), so a compaction roughly halves the file and rewrites
   * amortize to O(1) per appended byte. One consequence of the corpus-view
   * rule: a chunk that leaves the view (rewind, branch switch) loses its
   * vector at a gate-tripping compaction and re-embeds if it re-enters —
   * the one "embeds twice" path, correct because search can't see what the
   * view can't. Atomic via tmp+rename; on any failure
   * the store rolls back to its pre-compaction state (old file untouched
   * unless the rename won the race, in which case the lost vectors simply
   * re-embed). A concurrent writer appending between our close and rename
   * lands on the unlinked inode — its map keeps the key, the bytes re-embed
   * after restart; rare enough (two live sessions, one compaction window)
   * and self-healing, like every other failure here.
   */
  async compact(
    keep: ReadonlySet<string>,
    opts: { minDeadBytes?: number; minDeadRatio?: number } = {},
  ): Promise<number> {
    const handle = this.file;
    if (handle === null || this.closed) return 0;
    const kept: Array<[string, Uint8Array]> = [];
    for (const entry of this.vectors) if (keep.has(entry[0])) kept.push(entry);
    const deadBytes = (this.vectors.size - kept.length) * RECORD_BYTES;
    const fileBytes = HEADER_BYTES + this.vectors.size * RECORD_BYTES;
    const minDeadBytes = opts.minDeadBytes ?? 4 * 1024 * 1024;
    const minDeadRatio = opts.minDeadRatio ?? 0.5;
    if (kept.length === this.vectors.size) return 0; // zero-dead: nothing to reclaim
    if (deadBytes < minDeadBytes || deadBytes < minDeadRatio * fileBytes) return 0;
    const out = Buffer.alloc(HEADER_BYTES + kept.length * RECORD_BYTES);
    makeHeader().copy(out, 0);
    let at = HEADER_BYTES;
    for (const [key, v] of kept) {
      out.write(key, at, KEY_BYTES, "hex");
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(out, at + KEY_BYTES);
      at += RECORD_BYTES;
    }
    const tmp = `${this.filePath}.${process.pid}.tmp`; // per-process: concurrent sessions never share a tmp
    try {
      const tmpHandle = await open(tmp, "w");
      try {
        await tmpHandle.write(out, 0, out.length);
      } finally {
        await tmpHandle.close();
      }
      await handle.close();
      await rename(tmp, this.filePath);
      if (this.closed) {
        // close() won the race during the swap: the renamed file is correct on
        // disk, but nobody owns the store — stay closed, don't resurrect an fd.
        this.file = null;
        return deadBytes;
      }
      // The old handle now points at the unlinked inode — swap it before any
      // further add() or those appends would vanish with it.
      this.file = await open(this.filePath, "a+");
      this.vectors = new Map(kept);
      return deadBytes;
    } catch (err) {
      console.error(`recall: vector store compaction failed (${err instanceof Error ? err.message : String(err)})`);
      try {
        if (this.file !== null) await this.file.close();
      } catch {
        // already closed
      }
      if (this.closed) {
        this.file = null; // close() raced us; honor it
      } else {
        try {
          this.file = await open(this.filePath, "a+");
        } catch {
          this.file = null; // store degraded to map-only; add() tolerates a null handle
        }
      }
      try {
        await unlink(tmp);
      } catch {
        // no tmp to clean (the failure was creating it)
      }
      return 0;
    }
  }

  /** Top-K keys by sign agreement to the query, restricted to `candidates`
   * — the current corpus's keys; everything else in the file is invisible to
   * this search. Brute force: recall's corpus is thousands to tens of
   * thousands of chunks, well inside JavaScript's scan budget. */
  topK(query: Float32Array, candidates: Iterable<string>, k: number): VectorHit[] {
    if (query.length !== EMBED_DIMS) return []; // a foreign-width query is incomparable, not wrong
    const q = packSigns(query);
    const hits: VectorHit[] = [];
    for (const key of candidates) {
      const v = this.vectors.get(key);
      if (v === undefined) continue;
      let disagree = 0;
      for (let i = 0; i < PACKED_BYTES; i++) disagree += POPCOUNT[q[i] ^ v[i]];
      hits.push({ key, similarity: 1 - disagree / BITS });
    }
    hits.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1));
    return hits.slice(0, Math.max(0, k));
  }

  /** Closes the handle; pending appends are awaited by callers of add(). */
  async close(): Promise<void> {
    this.closed = true; // synchronous: visible to an in-flight compact()
    if (this.file !== null) await this.file.close();
    this.file = null;
    this.vectors.clear();
  }
}

/** Canonical 8-byte header: magic, format version, bit count, key width. */
function makeHeader(): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, "latin1");
  header[4] = FORMAT_VERSION;
  header.writeUInt16LE(BITS, 5);
  header[7] = KEY_BYTES;
  return header;
}
