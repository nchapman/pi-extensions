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
 * backstops that assumption. Orphaned keys (rewound branches, deleted
 * sessions) are harmless dead bytes and are deliberately not collected —
 * compaction would be real machinery for ~3KB per embedded chunk.
 *
 * Vector bytes are stored in platform endianness (every platform pi runs on
 * is little-endian); the header records the format so a mismatch resets
 * rather than misreads.
 */

import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

export const EMBED_DIMS = 768;
/** Truncated sha256: 128-bit keys make collisions negligible at recall scale (~10⁻²³ at 100k chunks). */
export const KEY_HEX = 32;
const KEY_BYTES = KEY_HEX / 2;
const RECORD_BYTES = KEY_BYTES + EMBED_DIMS * 4;

const MAGIC = "RVEC";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 8; // magic(4) + version(1) + dims(2 LE) + keyBytes(1)

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

  private constructor(file: Awaited<ReturnType<typeof open>>) {
    this.file = file;
  }

  /** Records currently cached. */
  get size(): number {
    return this.vectors.size;
  }

  /**
   * Open (creating if absent) the store file and load all records. Damage
   * self-heals: a torn trailing record is truncated away, and an
   * unrecognized header resets the file — losing cached vectors only ever
   * costs re-embedding. Throws only on conditions the caller cannot heal
   * (unreadable directory, permissions) so wiring can fail open.
   */
  static async open(file: string): Promise<VectorStore> {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "a+");
    const store = new VectorStore(handle);
    const buf = await handle.readFile();
    if (!store.headerMatches(buf)) {
      if (buf.length > 0)
        console.error(`recall: vector store ${file} has an unrecognized header — resetting (vectors will re-embed)`);
      await store.reset();
      return store;
    }
    const body = buf.length - HEADER_BYTES;
    const full = Math.floor(body / RECORD_BYTES);
    for (let i = 0; i < full; i++) {
      const at = HEADER_BYTES + i * RECORD_BYTES;
      const key = buf.subarray(at, at + KEY_BYTES).toString("hex");
      store.vectors.set(key, readVector(buf, at));
    }
    const torn = body - full * RECORD_BYTES;
    if (torn > 0) {
      console.error(`recall: vector store ${file} has a torn trailing record (${torn} bytes) — truncating`);
      await handle.truncate(HEADER_BYTES + full * RECORD_BYTES);
    }
    return store;
  }

  private headerMatches(buf: Buffer): boolean {
    return (
      buf.length >= HEADER_BYTES &&
      buf.subarray(0, 4).toString("latin1") === MAGIC &&
      buf[4] === FORMAT_VERSION &&
      buf.readUInt16LE(5) === EMBED_DIMS &&
      buf[7] === KEY_BYTES
    );
  }

  /** Rewrite the file from scratch: truncate first — the handle is append-mode, so the header write then lands at offset 0. */
  private async reset(): Promise<void> {
    await this.file!.truncate(0);
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(MAGIC, 0, "latin1");
    header[4] = FORMAT_VERSION;
    header.writeUInt16LE(EMBED_DIMS, 5);
    header[7] = KEY_BYTES;
    await this.file!.write(header, 0, HEADER_BYTES);
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
    const fresh = items.filter((item) => !this.vectors.has(item.key));
    if (fresh.length === 0 || this.file === null) return;
    const units = fresh.map((item) => normalize(item.vector));
    for (const [i, item] of fresh.entries()) this.vectors.set(item.key, units[i]);
    const record = Buffer.alloc(fresh.length * RECORD_BYTES);
    let at = 0;
    for (const [i, item] of fresh.entries()) {
      record.write(item.key, at, KEY_BYTES, "hex");
      Buffer.from(units[i].buffer, units[i].byteOffset, units[i].byteLength).copy(record, at + KEY_BYTES);
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
   * Top-K keys by cosine similarity to the query, restricted to `candidates`
   * — the current corpus's keys; everything else in the file is invisible to
   * this search. Brute force: recall's corpus is thousands to tens of
   * thousands of chunks, well inside JavaScript's scan budget.
   */
  topK(query: Float32Array, candidates: Iterable<string>, k: number): VectorHit[] {
    const q = normalize(query);
    const hits: VectorHit[] = [];
    for (const key of candidates) {
      const v = this.vectors.get(key);
      if (v === undefined) continue;
      let dot = 0;
      for (let i = 0; i < EMBED_DIMS; i++) dot += q[i] * v[i];
      hits.push({ key, similarity: dot });
    }
    hits.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1));
    return hits.slice(0, Math.max(0, k));
  }

  /** Closes the handle; pending appends are awaited by callers of add(). */
  async close(): Promise<void> {
    if (this.file !== null) await this.file.close();
    this.file = null;
    this.vectors.clear();
  }
}

/** Float32 view of the vector bytes of the record starting at `at`. */
function readVector(buf: Buffer, at: number): Float32Array {
  const bytes = buf.subarray(at + KEY_BYTES, at + RECORD_BYTES);
  return new Float32Array(bytes.buffer, bytes.byteOffset, EMBED_DIMS);
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
