/** Project corpus: sibling session files in the cwd-scoped session directory,
 * parsed into labeled foreign chunks, with an mtime/size-validated LRU cache
 * bounded by a total-bytes cap. */

import fsp from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { chunksFromEntry, type RecallChunk } from "./chunks";

// ---------------------------------------------------------------------------
// Project corpus (sibling session files)
// ---------------------------------------------------------------------------

export interface ProjectReader {
  listJsonlFiles(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  stat(file: string): Promise<{ mtimeMs: number; size: number } | undefined>;
}

export const fsProjectReader: ProjectReader = {
  async listJsonlFiles(dir) {
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
  },
  async readFile(file) {
    return fsp.readFile(file, "utf8");
  },
  async stat(file) {
    try {
      const s = await fsp.stat(file);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  },
};

export interface FileCorpus {
  file: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  label: string;
  chunks: RecallChunk[];
  entryLines: Map<string, number>;
  bytes: number;
}

/** Parse one session file into chunks + per-entry line numbers. */
export function buildFileCorpus(
  file: string,
  content: string,
  chunkChars = 3000,
  labelMax = 40,
): FileCorpus | undefined {
  const lines = content.split("\n");
  let sessionId = path.basename(file, ".jsonl");
  let sessionDate = "";
  let name: string | undefined;
  const chunks: RecallChunk[] = [];
  const entryLines = new Map<string, number>();
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate trailing partial writes
    }
    const entry = parsed as {
      type?: string;
      id?: string;
      timestamp?: string;
      cwd?: string;
      name?: string;
      summary?: string;
    };
    if (entry?.type === "session") {
      if (typeof entry.id === "string" && entry.id !== "") sessionId = entry.id;
      if (typeof entry.timestamp === "string") sessionDate = entry.timestamp.slice(0, 10);
      continue;
    }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name !== "") {
      name = entry.name;
      continue;
    }
    if (typeof entry?.id !== "string" || entry.id === "") continue;
    entryLines.set(entry.id, i + 1);
    const sessionEntry = parsed as SessionEntry;
    const label = `past session ${name ? `"${name.slice(0, labelMax)}" ` : ""}${sessionDate}`;
    for (const chunk of chunksFromEntry(
      sessionEntry,
      { origin: "foreign", sessionId, sessionLabel: label },
      chunkChars,
    )) {
      chunks.push(chunk);
      bytes += chunk.text.length;
    }
  }
  if (entryLines.size === 0) return undefined; // header-only / empty session
  return { file, mtimeMs: 0, size: content.length, sessionId, label: name ?? sessionId, chunks, entryLines, bytes };
}

/**
 * Corpus cache for project scope: per-file, mtime/size-validated, LRU-evicted
 * by a total-bytes cap. Foreign files are indexed wholesale (all branches) —
 * abandoned approaches are history worth finding, and provenance labels keep
 * them distinguishable.
 */
export class ProjectCorpusCache {
  private files = new Map<string, FileCorpus>();
  private bytes = 0;

  constructor(
    private reader: ProjectReader,
    private maxBytes: number,
    private chunkChars = 3000,
  ) {}

  list(): FileCorpus[] {
    return [...this.files.values()];
  }

  totalBytes(): number {
    return this.bytes;
  }

  /** Drop a file from the cache (or erase a tombstone). */
  private evict(file: string) {
    const corpus = this.files.get(file);
    if (corpus) {
      this.bytes -= corpus.bytes;
      this.files.delete(file);
    }
  }

  private insert(corpus: FileCorpus) {
    this.evict(corpus.file); // adjusts bytes when replacing a stale build
    this.files.set(corpus.file, corpus); // re-insert = most recently used
    this.bytes += corpus.bytes;
    while (this.bytes > this.maxBytes && this.files.size > 1) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
  }

  /**
   * Ensure the cache reflects the session directory: new or changed files
   * are (re)built, gone files dropped. Returns how many files were
   * unreadable (skipped).
   */
  async refresh(dir: string, skipFile: string | undefined): Promise<number> {
    const files = await this.reader.listJsonlFiles(dir);
    const present = new Set(files);
    for (const cached of [...this.files.keys()]) if (!present.has(cached)) this.evict(cached);
    let skipped = 0;
    for (const file of files) {
      if (file === skipFile) continue; // current session is covered in-memory, branch-correct
      const stat = await this.reader.stat(file);
      if (stat === undefined) {
        skipped++;
        this.evict(file);
        continue;
      }
      const cached = this.files.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        this.insert(cached); // touch LRU without re-reading
        continue;
      }
      try {
        const content = await this.reader.readFile(file);
        const corpus = buildFileCorpus(file, content, this.chunkChars);
        if (corpus === undefined) {
          skipped++;
          this.evict(file);
          continue;
        }
        this.evict(file);
        corpus.mtimeMs = stat.mtimeMs;
        corpus.size = stat.size;
        this.insert(corpus);
      } catch {
        skipped++;
        this.evict(file);
      }
    }
    return skipped;
  }

  /** Locate a foreign entry's raw line for read mode. */
  locate(refSessionShort: string, entryId: string): { corpus: FileCorpus; line: number } | undefined {
    for (const corpus of this.files.values()) {
      if (!corpus.sessionId.startsWith(refSessionShort)) continue;
      const line = corpus.entryLines.get(entryId);
      if (line !== undefined) return { corpus, line };
    }
    return undefined;
  }

  /** Read one entry line from a cached file through the injected reader. */
  async readEntryLine(corpus: FileCorpus, line: number): Promise<string | undefined> {
    const raw = await this.reader.readFile(corpus.file);
    return raw.split("\n")[line - 1];
  }
}
