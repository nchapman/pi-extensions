/** Diff handling for Stage 0: per-file splitting, path exclusion,
 * file-boundary chunking, the child-task byte cap, and hunk-windowed
 * attachment of the changed files' current contents. */

// ---------------------------------------------------------------------------
// Diff parsing, exclusion, chunking
// ---------------------------------------------------------------------------

/** Represents a parsed unified git diff section for a single target file. */
export interface DiffFile {
  path: string;
  text: string;
  chars: number;
}

/** A grouped subset of DiffFiles bounded by a character threshold for batch subagent review. */
export interface DiffChunk {
  files: DiffFile[];
  chars: number;
}

/** Paths that carry no review signal: machine-generated, noise by contract, or our own state. */
const EXCLUDED = [
  /(^|\/)\.pi\//,
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt)\//,
  /(^|\/)vendor\//,
  /(^|\/)src\/gen\//,
  /\.(lock|sum|snap)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.(sum|mod)|Gemfile\.lock)$/i,
  /\.(log|svg|min\.(js|css)|map)$/i,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf)$/i,
];

/** Check if a file path matches standard noise patterns that should be excluded from code review. */
export function isExcludedPath(p: string): boolean {
  return EXCLUDED.some((re) => re.test(p));
}

/**
 * Split a unified diff into per-file blocks, grouped by `diff --git` headers;
 * content between headers (rename/copy/mode lines) stays attached. On renames
 * the b-side path is what the review touches. Tolerant: text before the first
 * header is dropped.
 */
export function splitDiffFiles(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split("\n");
  let current: string[] | null = null;
  let currentPath: string | null = null;
  const push = () => {
    if (current && currentPath) {
      const text = current.join("\n");
      files.push({ path: currentPath, text, chars: text.length });
    }
  };
  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      push();
      current = [line];
      currentPath = m[2];
    } else if (current) {
      current.push(line);
    }
  }
  push();
  return files;
}

/** Synthesize a new-file unified diff for an untracked file. */
export function syntheticNewFileDiff(p: string, content: string): string {
  const lines = content.split("\n");
  // A trailing newline yields one empty trailing element; keep the diff git-shaped.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${p} b/${p}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${p}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join("\n");
}

/**
 * Group files into chunks of at most `maxChars`, never splitting a file.
 * A single oversized file becomes its own chunk; the report discloses sizes.
 */
export function chunkDiffFiles(files: DiffFile[], maxChars: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let current: DiffFile[] = [];
  let currentChars = 0;
  for (const file of files) {
    if (current.length > 0 && currentChars + file.chars > maxChars) {
      chunks.push({ files: current, chars: currentChars });
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += file.chars;
  }
  if (current.length > 0) chunks.push({ files: current, chars: currentChars });
  return chunks;
}

/** Labeled text section of a diff presented for inspection or subagent consumption. */
export interface DiffSection {
  label: string;
  text: string;
}

/** Cap a single child task argument in UTF-8 bytes. Linux MAX_ARG_STRLEN is
 * 131,072 bytes per execve argument; the task (prompt + diff + guidelines)
 * travels as one argument, so anything larger fails to spawn with E2BIG. The
 * cap leaves headroom and is the hard guarantee; chunkChars is the soft one. */
export const TASK_MAX_BYTES = 120_000;

/** Byte-wise character-aligned cut of a single line (surrogate pairs and
 * multibyte chars stay whole — no split characters, no replacement chars). */
function cutToBytes(line: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const ch of line) {
    const cost = Buffer.byteLength(ch, "utf8");
    if (used + cost > maxBytes) break;
    out += ch;
    used += cost;
  }
  return out;
}

/** Truncate to at most `maxBytes` of UTF-8 without splitting a character.
 * Line-aligned where possible so diffs cut at hunk boundaries. */
export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, omittedBytes: 0 };
  // Byte-walk whole lines while they fit; a final over-budget line is hard-cut
  // on a character boundary.
  const lines = text.split("\n");
  let kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > maxBytes) {
      const room = maxBytes - used;
      if (room > 0) {
        kept.push(cutToBytes(line, room));
        used = maxBytes;
      }
      break;
    }
    kept.push(line);
    used += cost;
  }
  const out = kept.join("\n");
  return { text: out, omittedBytes: Buffer.byteLength(text, "utf8") - Buffer.byteLength(out, "utf8") };
}

/** Lines of context around each hunk when windowing attachments of large
 * files — enough to capture the enclosing function, cheap enough to attach
 * every changed region instead of winner-take-all whole files. */
const ATTACH_WINDOW_LINES = 40;
/** Per-file cap on attached content; a window set over this (a ~400-line
 * change) is not attached rather than partially attached. */
const ATTACH_SLICE_MAX_CHARS = 16_000;

/** New-file line ranges of a file's hunks — the anchors windowed attachment
 * widens around. Count-less headers are single-line hunks; a zero-count
 * hunk (pure deletion) still anchors a window at its position. */
export function hunkRanges(fileDiff: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const m of fileDiff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push({ start, end: start + Math.max(count, 1) - 1 });
  }
  return ranges;
}

/** Widen ranges by `width` lines, clamp to [1, maxLine], merge overlaps. */
export function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
  width: number,
  maxLine: number,
): Array<{ start: number; end: number }> {
  const widened = ranges.map((r) => ({
    start: Math.max(1, r.start - width),
    end: Math.min(maxLine, r.end + width),
  }));
  widened.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of widened) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** The per-file attachment: windows around the hunks sliced from current
 * contents, or the whole file when the windows cover it anyway. Null when
 * there is no anchor (mode-only/rename diffs) or the slice overflows the
 * per-file cap — partial windows mislead more than they inform. */
export function sliceAttachment(
  content: string,
  ranges: Array<{ start: number; end: number }>,
  width: number = ATTACH_WINDOW_LINES,
  maxChars: number = ATTACH_SLICE_MAX_CHARS,
): { label: string; content: string } | null {
  const lines = content.split("\n");
  const merged = mergeRanges(ranges, width, lines.length);
  if (merged.length === 0) return null;
  if (merged.length === 1 && merged[0].start <= 1 && merged[0].end >= lines.length) {
    return { label: "whole file", content };
  }
  const text = merged.map((w) => lines.slice(w.start - 1, w.end).join("\n")).join("\n…\n");
  if (text.length > maxChars) return null;
  const label = merged.map((w) => `lines ${w.start}-${w.end}`).join("; ");
  return { label, content: text };
}

/** Choose whole attachments to attach under a byte budget, smallest first —
 * the budget buys complete files rather than one partial tail, and a monster
 * file never displaces several useful ones. Sizes are bytes so the budget
 * composes with the task byte cap. Files that do not fit are named so the
 * finder knows to read them itself. */
export function selectAttachments(
  files: Array<{ path: string; size: number }>,
  budget: number,
): { attached: string[]; skipped: string[] } {
  const ordered = [...files].sort((a, b) => a.size - b.size);
  const attached: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const f of ordered) {
    if (used + f.size <= budget) {
      attached.push(f.path);
      used += f.size;
    } else {
      skipped.push(f.path);
    }
  }
  return { attached, skipped };
}

/** Render the attachment section: current contents of the changed files as
 * reference material for the diff — the finder consults these before paying
 * for a tool round trip. `skipped` are readable files whose windows overflow
 * the budget (the finder may read them itself); `refused` are files the read
 * guard stopped — deliberately rendered WITHOUT a "read them" invitation,
 * since refusing was the point (a symlink escape must not be advertised as a
 * todo for the child). */
export function renderAttachments(
  files: Array<{ path: string; label?: string; content: string }>,
  skipped: string[],
  refused: string[] = [],
): string {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(
      "## Current contents of the changed files\nAnswer questions the diff raises from these before reaching for tools. Large files appear as windows around their changed regions; `…` marks elided spans.",
    );
    for (const f of files)
      parts.push(`### ${f.path}${f.label && f.label !== "whole file" ? ` (${f.label})` : ""}\n${f.content}`);
  }
  if (refused.length > 0) {
    parts.push(
      `Files not attached — unreadable (oversized, not a plain file, or a symlink escape): ${refused.join(", ")}`,
    );
  }
  if (skipped.length > 0) {
    parts.push(`Files not attached (over budget — read them if needed): ${skipped.join(", ")}`);
  }
  return parts.join("\n\n");
}

/** Build a task whose diff is truncated so the whole task fits the byte cap.
 * `build` is called with the (possibly truncated) diff; the truncation note is
 * appended so the child knows the diff is partial. */
export function fitTask(
  build: (diff: string) => string,
  diff: string,
  budget: number = TASK_MAX_BYTES,
): { task: string; truncated: boolean } {
  const whole = build(diff);
  if (Buffer.byteLength(whole, "utf8") <= budget) return { task: whole, truncated: false };
  const overhead = Buffer.byteLength(build(""), "utf8");
  const { text, omittedBytes } = truncateUtf8Bytes(diff, Math.max(0, budget - overhead - 200));
  const note = `\n(diff truncated: ~${Math.round(omittedBytes / 1024)}KB omitted — request the remainder with read if needed)`;
  return { task: build(text + note), truncated: true };
}
