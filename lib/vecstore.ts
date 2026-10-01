/**
 * Flat-file vector store — the persistence half of recall's semantic cache.
 *
 * One append-only binary file per session directory: an 8-byte header then
 * fixed-size records of [16-byte truncated key | 768 float32 unit vectors].
 * Everything loads into a Map<key, Float32Array> at open and search is a
 * brute-force dot-product scan over candidate keys — no database, no query
 * engine. This works because the store is a pure *cache*: keys are content
 * hashes, so a vector can never be wrong for its key, only missing — every
 * failure mode, including a torn final record from a crash, degrades to
 * "BM25 covers it," never to wrong search results. Concurrent writers (two
 * pi sessions in one project dir) append fixed-size records in single
 * write() calls, which local filesystems serialize; the load-time tear check
 * backstops that assumption.
 *
 * Vector bytes are stored in platform endianness (every platform pi runs on
 * is little-endian); the header records the format so a mismatch resets
 * rather than misreads. Dead bytes (rewound branches, deleted sessions,
 * edited text) are reclaimed by compact() — the caller passes the keys its
 * corpus view can still see, and the rewrite is self-gated so it only runs
 * when dead bytes dominate the file (amortized O(1) rewrites per appended
 * byte). Until that gate trips, dead records are harmless: invisible to
 * search, ~3KB each.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const EMBED_DIMS = 768; // default dims for new files; each file records its own
/** Truncated sha256: 128-bit keys make collisions negligible at recall scale (~10⁻²³ at 100k chunks). */
export const KEY_HEX = 32;
const KEY_BYTES = KEY_HEX / 2;
/** A model's vector width is a property of the store file, not a global: files
 * record their dims in the header and every record-width computation uses it,
 * so switching embedding models (768 → 1024 → 896 dims) is a header mismatch
 * away from a clean reset, never a misread. */
const MAX_DIMS = 4096;
const recordBytes = (dims: number) => KEY_BYTES + dims * 4;

const MAGIC = "RVEC";
const FORMAT_VERSION = 2;
// magic(4) + version(1) + dims(2 LE) + keyBytes(1) + modelHash(8)
// v2 added the model fingerprint: dims alone can't identify a model (two
// models sharing 768 would silently mix incompatible vectors), and the hash
// makes a same-width model switch reset the cache like any other migration —
// v1 files reset on the version bump, losing only cached vectors.
const HEADER_BYTES = 16;
const MODEL_HASH_BYTES = 8;

/** Short fingerprint of the model id that produced a file's vectors. */
export function modelHash(model: string): string {
  return createHash("sha256")
    .update(model)
    .digest("hex")
    .slice(0, MODEL_HASH_BYTES * 2);
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
  /** Cosine similarity in [-1, 1] — unit vectors, so this is the dot product. */
  similarity: number;
}

export class VectorStore {
  private vectors = new Map<string, Float32Array>();
  private file: Awaited<ReturnType<typeof open>> | null = null;
  private readonly filePath: string;
  private readonly dims: number;
  private readonly recBytes: number;
  private readonly hash: string;
  // Set synchronously at close() so an in-flight compact() observes it before
  // reopening — otherwise compact resurrects a handle nobody owns (fd leak).
  private closed = false;

  private constructor(file: Awaited<ReturnType<typeof open>>, filePath: string, dims: number, hash: string) {
    this.file = file;
    this.filePath = filePath;
    this.dims = dims;
    this.recBytes = recordBytes(dims);
    this.hash = hash;
  }

  /** Records currently cached. */
  get size(): number {
    return this.vectors.size;
  }

  /**
   * Open (creating if absent) the store file and load all records. `dims` is
   * the width the caller's model embeds at and `model` its identity — both
   * optional and both authoritative when given: a file built at a different
   * width or by a different model (fingerprinted in the header) is reset
   * (cache invalidation — appending 1024-wide vectors into 768-wide records
   * could only misread, and two 768-wide models' vectors are incomparable).
   * Omitted values adopt the file's recorded ones, so identity-agnostic
   * readers never invalidate. Damage self-heals: a torn trailing record is
   * truncated away, and an unrecognized header (v1 included) resets the file
   * — losing cached vectors only ever costs re-embedding. Throws only on
   * conditions the caller cannot heal (unreadable directory, permissions,
   * absurd dims) so wiring can fail open.
   */
  static async open(file: string, opts: { dims?: number; model?: string } = {}): Promise<VectorStore> {
    const wantDims = opts.dims;
    if (wantDims !== undefined && (!Number.isInteger(wantDims) || wantDims <= 0 || wantDims > MAX_DIMS))
      throw new Error(`invalid dims ${wantDims}`);
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "a+");
    const buf = await handle.readFile();
    const header = this.readHeader(buf);
    if (
      header !== null &&
      (wantDims === undefined || header.dims === wantDims) &&
      (opts.model === undefined || header.modelHash === modelHash(opts.model))
    ) {
      const store = new VectorStore(handle, file, header.dims, header.modelHash);
      await store.load(buf);
      return store;
    }
    const dims = wantDims ?? EMBED_DIMS;
    const hash = modelHash(opts.model ?? "");
    const store = new VectorStore(handle, file, dims, hash);
    if (header !== null)
      console.error(
        `recall: vector store ${file} was built by a different model (dims/header differ: ${header.dims}→${dims}) — resetting (vectors will re-embed)`,
      );
    else if (buf.length > 0)
      console.error(`recall: vector store ${file} has an unrecognized header — resetting (vectors will re-embed)`);
    await store.reset();
    return store;
  }

  /** Valid header fields, or null when absent/unrecognized (v1 files reset by
   * the version bump). */
  private static readHeader(buf: Buffer): { dims: number; modelHash: string } | null {
    if (
      buf.length < HEADER_BYTES ||
      buf.subarray(0, 4).toString("latin1") !== MAGIC ||
      buf[4] !== FORMAT_VERSION ||
      buf[7] !== KEY_BYTES
    )
      return null;
    const dims = buf.readUInt16LE(5);
    if (dims <= 0 || dims > MAX_DIMS) return null;
    return { dims, modelHash: buf.subarray(8, 8 + MODEL_HASH_BYTES).toString("hex") };
  }

  /** Parse the (already header-validated) body into the map; trim torn tail. */
  private async load(buf: Buffer): Promise<void> {
    const body = buf.length - HEADER_BYTES;
    const full = Math.floor(body / this.recBytes);
    for (let i = 0; i < full; i++) {
      const at = HEADER_BYTES + i * this.recBytes;
      const key = buf.subarray(at, at + KEY_BYTES).toString("hex");
      this.vectors.set(key, readVector(buf, at, this.dims));
    }
    const torn = body - full * this.recBytes;
    if (torn > 0) {
      console.error(`recall: vector store ${this.filePath} has a torn trailing record (${torn} bytes) — truncating`);
      await this.file!.truncate(HEADER_BYTES + full * this.recBytes);
    }
  }

  /** Rewrite the file from scratch: truncate first — the handle is append-mode, so the header write then lands at offset 0. */
  private async reset(): Promise<void> {
    await this.file!.truncate(0);
    await this.file!.write(makeHeader(this.dims, this.hash), 0, HEADER_BYTES);
  }

  /** Which of `keys` are already cached. */
  has(keys: readonly string[]): Set<string> {
    const present = new Set<string>();
    for (const key of keys) if (this.vectors.has(key)) present.add(key);
    return present;
  }

  /**
   * Cache unit vectors for absent keys. The map is updated before the append
   * commits and rolled back if it fails, so concurrent add() calls never
   * double-append and a failed write simply retries on the next catch-up.
   * Vectors are re-normalized regardless of producer, making the
   * cosine-as-dot invariant true by construction. Duplicate keys are skipped,
   * not replaced — a key is its content's hash, so "newer" means identical.
   */
  async add(items: readonly { key: string; vector: Float32Array }[]): Promise<void> {
    const fresh = items.filter((item) => !this.vectors.has(item.key) && item.vector.length === this.dims);
    if (fresh.length === 0 || this.file === null) return;
    const units = fresh.map((item) => normalize(item.vector));
    for (const [i, item] of fresh.entries()) this.vectors.set(item.key, units[i]);
    const record = Buffer.alloc(fresh.length * this.recBytes);
    let at = 0;
    for (const [i, item] of fresh.entries()) {
      record.write(item.key, at, KEY_BYTES, "hex");
      Buffer.from(units[i].buffer, units[i].byteOffset, units[i].byteLength).copy(record, at + KEY_BYTES);
      at += this.recBytes;
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
    const kept: Array<[string, Float32Array]> = [];
    for (const entry of this.vectors) if (keep.has(entry[0])) kept.push(entry);
    const deadBytes = (this.vectors.size - kept.length) * this.recBytes;
    const fileBytes = HEADER_BYTES + this.vectors.size * this.recBytes;
    const minDeadBytes = opts.minDeadBytes ?? 4 * 1024 * 1024;
    const minDeadRatio = opts.minDeadRatio ?? 0.5;
    if (kept.length === this.vectors.size) return 0; // zero-dead: nothing to reclaim
    if (deadBytes < minDeadBytes || deadBytes < minDeadRatio * fileBytes) return 0;
    const out = Buffer.alloc(HEADER_BYTES + kept.length * this.recBytes);
    makeHeader(this.dims, this.hash).copy(out, 0);
    let at = HEADER_BYTES;
    for (const [key, v] of kept) {
      out.write(key, at, KEY_BYTES, "hex");
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(out, at + KEY_BYTES);
      at += this.recBytes;
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

  /** Top-K keys by cosine similarity to the query, restricted to `candidates`
   * — the current corpus's keys; everything else in the file is invisible to
   * this search. Brute force: recall's corpus is thousands to tens of
   * thousands of chunks, well inside JavaScript's scan budget.
   */
  topK(query: Float32Array, candidates: Iterable<string>, k: number): VectorHit[] {
    const q = normalize(query);
    if (q.length !== this.dims) return []; // a query from a different-dims model is incomparable, not wrong
    const hits: VectorHit[] = [];
    for (const key of candidates) {
      const v = this.vectors.get(key);
      if (v === undefined) continue;
      let dot = 0;
      for (let i = 0; i < this.dims; i++) dot += q[i] * v[i];
      hits.push({ key, similarity: dot });
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

/** Float32 view of the vector bytes of the record starting at `at`. */
function readVector(buf: Buffer, at: number, dims: number): Float32Array {
  const bytes = buf.subarray(at + KEY_BYTES, at + KEY_BYTES + dims * 4);
  return new Float32Array(bytes.buffer, bytes.byteOffset, dims);
}

/** Canonical header: magic, format version, dims, key width, model fingerprint. */
function makeHeader(dims: number, hash: string): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, "latin1");
  header[4] = FORMAT_VERSION;
  header.writeUInt16LE(dims, 5);
  header[7] = KEY_BYTES;
  header.write(hash, 8, MODEL_HASH_BYTES, "hex");
  return header;
}

/** L2-normalize to the unit sphere; zero vectors pass through unchanged. */
function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || Math.abs(norm - 1) < 1e-9) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}
