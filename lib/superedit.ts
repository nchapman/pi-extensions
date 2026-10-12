/**
 * superedit — the forgiving-matcher core behind the `edit` tool.
 *
 * Design (the deliberate cuts):
 * - the tool is named `edit` so it replaces pi's built-in by name (the superbash
 *   pattern): recall's file-op tracking, EditToolCallEvent, the default active
 *   set, and every model's trained habits keep working unchanged
 * - correctness is never traded for convenience. The ladder decides WHEN text
 *   matches, never WHICH match wins silently: a forgiving tier is only applied
 *   when its match is unambiguous, and every non-exact application is named in
 *   the result. Ambiguity is always an error that lists the candidates
 * - the ladder, strictest tier first: (1) exact bytes; (2) pi's own
 *   normalization (NFKC, per-line trailing whitespace, smart quotes/dashes,
 *   Unicode spaces — mirrored from pi's edit-diff so the happy path behaves
 *   identically); (3) whole-line match with a UNIFORM indentation shift (tabs
 *   expanded at tabstop 4). Tier 3 is the heredoc repair: a block whose lines
 *   all match after trim and whose indentation is consistently off by one
 *   shift — the replacement is re-indented by that same shift, so a paste- or
 *   tab-mangled edit still lands where it was aimed. Internally inconsistent
 *   indentation does not match; the not-found error names the lines that break
 *   the shift. Tier 3 never matches partial lines, and an exact byte match
 *   always outranks normalized or elastic twins
 * - edits apply sequentially, each matched against the file as it stands after
 *   the earlier edits — the semantics of the python str.replace workaround
 *   this tool replaces: chained edits work, and an edit whose oldText only
 *   matches text an earlier edit rewrote gets a merge-them error naming both.
 *   All edits are matched in memory before anything is written: one call is
 *   all-or-nothing
 * - duplicates are the caller's choice, not a guess: unique match by default,
 *   `occurrence: N` (1-based, file order) or `occurrence: "all"` (capped — a
 *   too-generic oldText is refused, never blasted everywhere)
 * - not-found errors carry diagnostics instead of dead ends: the closest
 *   region as a line-numbered diff (anchor search, with a bigram-similarity
 *   seed for drifted text), whitespace forensics, and an honest "nothing
 *   similar" with the file's line count. Every message is capped so a failure
 *   never floods context
 * - BOM and line endings round-trip exactly like the built-in: edits are
 *   LF-normalized for matching, the original ending style is restored on write
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineTool,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type AgentToolResult,
  type EditOperations,
  type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Tab expansion width for comparing indentation between tabs and spaces. */
export const TABSTOP = 4;
/** Default cap on how many sites one occurrence: "all" edit may rewrite. */
export const DEFAULT_ALL_CAP = 20;
/** Ceiling for the occurrence: "all" cap knob. */
const MAX_ALL_CAP = 1000;
/**
 * Hard ceiling on collected matches, kept one above MAX_ALL_CAP so "exactly
 * at the all-cap" is distinguishable from "more exist": truncated is set only
 * when the true count strictly exceeds this.
 */
const MAX_COLLECTED = MAX_ALL_CAP + 1;
/**
 * Budget of line comparisons for one elastic search: sliding windows over a
 * massively repetitive file must not wedge the tool. Exhausting the budget
 * returns what was found marked truncated — refusing beats unbounded work.
 */
const MAX_VERIFY_COMPARISONS = 2_000_000;
/** Diagnostic caps: shown match sites, context lines per site, diff lines, shift lines. */
const MAX_SITES_SHOWN = 5;
const SITE_CONTEXT_LINES = 2;
const MAX_DIAG_LINES = 40;
const MAX_SHIFT_LINES = 6;

// ---------------------------------------------------------------------------
// Environment knobs (invalid values fall back to defaults, house style)
// ---------------------------------------------------------------------------

/** PI_SUPEREDIT=0|false disables the extension so pi's built-in edit stays. */
export function parseSupereditEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["PI_SUPEREDIT"];
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

/** PI_SUPEREDIT_ALL_CAP caps occurrence: "all"; invalid values keep the default. */
export function parseAllCap(env: Record<string, string | undefined>): number {
  const raw = env["PI_SUPEREDIT_ALL_CAP"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ALL_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ALL_CAP;
  return Math.min(Math.floor(n), MAX_ALL_CAP);
}

// ---------------------------------------------------------------------------
// Text normalization (mirrors pi's edit-diff fuzzy tier)
// ---------------------------------------------------------------------------

/**
 * Normalize for fuzzy matching, mirroring pi's built-in edit tool so files
 * behave identically on the shared tier: NFKC, per-line trailing whitespace,
 * smart quotes/dashes, and Unicode spaces to their ASCII equivalents.
 * Line count is invariant — normalized offsets keep real line numbers.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Dominant line ending: the first \r\n before any bare \n wins, else LF. */
export function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Split a leading UTF-8 BOM off; the model never includes it in oldText. */
export function splitBom(raw: string): { bom: string; text: string } {
  return raw.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: raw.slice(1) } : { bom: "", text: raw };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Mirror pi's (unexported) resolveToCwd: unicode-space, @-prefix, ~, and file:// leniency. */
function resolveToCwd(filePath: string, baseDir: string): string {
  let p = filePath.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

export interface Line {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's last character (before its newline). */
  end: number;
  /** Line text without the newline. */
  text: string;
  /** Whether a \n follows this line. */
  hasNewline: boolean;
}

export function getLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      // A trailing newline does not create a phantom empty final line, but
      // empty content is still one (empty) line.
      if (start < content.length || lines.length === 0) {
        lines.push({ start, end: content.length, text: content.slice(start), hasNewline: false });
      }
      return lines;
    }
    lines.push({ start, end: nl, text: content.slice(start, nl), hasNewline: true });
    start = nl + 1;
  }
}

const fullText = (line: Line): string => line.text + (line.hasNewline ? "\n" : "");

/** 1-based line number containing `offset`. */
function lineOfOffset(lines: Line[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** A line's identity for elastic matching and diagnostics: normalized, trimmed. */
function lineKey(line: string): string {
  return normalizeForFuzzyMatch(line).trim();
}

/** Leading-whitespace width in columns; tabs expand to the next tabstop. */
export function expandIndent(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col = Math.ceil((col + 1) / TABSTOP) * TABSTOP;
    else break;
  }
  return col;
}

/**
 * Shift one line's indentation by `shift` columns. Positive prepends spaces;
 * negative strips leading columns (a straddled tab becomes padding spaces);
 * blank lines and lines shallower than a negative shift are left alone.
 */
export function shiftIndent(line: string, shift: number): string {
  if (shift === 0 || line.trim() === "") return line;
  if (shift > 0) return " ".repeat(shift) + line;
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t") && col < -shift) {
    col = line[i] === "\t" ? Math.ceil((col + 1) / TABSTOP) * TABSTOP : col + 1;
    i++;
  }
  if (col < -shift) return line;
  return " ".repeat(col + shift) + line.slice(i);
}

function shiftText(text: string, shift: number): string {
  if (shift === 0) return text;
  return text
    .split("\n")
    .map((line) => shiftIndent(line, shift))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The matching ladder
// ---------------------------------------------------------------------------

export type TierName = "exact" | "normalized" | "indent-elastic";

export interface TierMatch {
  start: number;
  end: number;
  /** Indentation shift for elastic matches; 0 on the exact/normalized tiers. */
  indentShift: number;
}

export interface TierResult {
  /** The first tier with at least one match, or "none". */
  tier: TierName | "none";
  /** All matches of that tier, ascending by start. */
  matches: TierMatch[];
  /** Whether collection stopped at the ceiling — the true count may be higher. */
  truncated: boolean;
  /** Whether offsets index into the content or its normalized form. */
  space: "content" | "fuzzy";
  /** The normalized content, present iff space === "fuzzy". */
  fuzzyContent?: string;
}

/** All non-overlapping occurrences of `needle` in `haystack`, capped. */
function findAll(haystack: string, needle: string): { matches: TierMatch[]; truncated: boolean } {
  const out: TierMatch[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length, indentShift: 0 });
    if (out.length >= MAX_COLLECTED) {
      // Probe one past the ceiling so "exactly MAX_COLLECTED" is not flagged.
      return { matches: out, truncated: haystack.indexOf(needle, i + needle.length) !== -1 };
    }
    i = haystack.indexOf(needle, i + needle.length);
  }
  return { matches: out, truncated: false };
}

/**
 * Tier 3: whole-line match with a uniform indentation shift. The region is
 * complete lines; every line must be equal after trim (plus the shared
 * normalization), and every non-blank line's leading-whitespace difference
 * must be the same shift. The match records that shift so the replacement can
 * be re-indented by it.
 */
function findElastic(content: string, oldText: string): { matches: TierMatch[]; truncated: boolean } {
  const endsWithNewline = oldText.endsWith("\n");
  const oldLines = oldText.split("\n");
  if (endsWithNewline) oldLines.pop();
  const k = oldLines.length;
  if (k === 0) return { matches: [], truncated: false };
  const contentLines = getLines(content);
  const contentKeys = contentLines.map((l) => lineKey(l.text));
  const oldKeys = oldLines.map(lineKey);

  // The comparison budget covers the whole search so massively repetitive
  // input cannot wedge the tool anywhere. The position scan below is one
  // pass — O(file lines) — so file size alone can never eat the window budget.
  let budget = MAX_VERIFY_COMPARISONS;

  // Anchor on the rarest non-blank line key: windows are verified from its
  // occurrences, so a unique line keys straight to its window. Keys are
  // computed once — per-line normalization is not free.
  const wanted = new Set(oldKeys.filter((key) => key !== ""));
  const positions = new Map<string, number[]>();
  for (let j = 0; j < contentKeys.length && wanted.size > 0; j++) {
    if ((budget -= 1) < 0) return { matches: [], truncated: true };
    const key = contentKeys[j];
    if (!wanted.has(key)) continue;
    const idxs = positions.get(key);
    if (idxs) idxs.push(j);
    else positions.set(key, [j]);
  }
  let anchorKey: string | undefined;
  let anchorCount = Number.POSITIVE_INFINITY;
  for (const [key, idxs] of positions) {
    if (idxs.length < anchorCount) {
      anchorKey = key;
      anchorCount = idxs.length;
    }
  }
  if (anchorKey === undefined) return { matches: [], truncated: false };

  const finish = (truncated: boolean) => ({ matches: matches.sort((x, y) => x.start - y.start), truncated });
  const matches: TierMatch[] = [];
  for (let a = 0; a < k; a++) {
    if (oldKeys[a] !== anchorKey) continue;
    for (const p of positions.get(anchorKey)!) {
      const w = p - a;
      if (w < 0 || w + k > contentLines.length) continue;
      if ((budget -= k) < 0) return finish(true);
      const m = verifyElasticWindow(contentLines, contentKeys, oldKeys, oldLines, w, endsWithNewline);
      if (!m) continue;
      if (matches.some((x) => x.start === m.start)) continue; // same window via another anchor index
      // Collecting past the ceiling acts as the probe: one more verified
      // match means the true count strictly exceeds MAX_COLLECTED.
      if (matches.length >= MAX_COLLECTED) return finish(true);
      matches.push(m);
    }
  }
  return finish(false);
}

function verifyElasticWindow(
  contentLines: Line[],
  contentKeys: string[],
  oldKeys: string[],
  oldLines: string[],
  w: number,
  endsWithNewline: boolean,
): TierMatch | null {
  let shift: number | null = null;
  for (let i = 0; i < oldLines.length; i++) {
    const oldLine = oldLines[i];
    if (contentKeys[w + i] !== oldKeys[i]) return null;
    if (oldLine.trim() === "") continue; // blank lines carry no indent signal
    const d = expandIndent(contentLines[w + i].text) - expandIndent(oldLine);
    if (shift === null) shift = d;
    else if (shift !== d) return null;
  }
  const first = contentLines[w];
  const last = contentLines[w + oldLines.length - 1];
  return {
    start: first.start,
    end: last.end + (endsWithNewline && last.hasNewline ? 1 : 0),
    indentShift: shift ?? 0,
  };
}

/** Run the ladder: the first tier with at least one match wins, with all of its matches. */
export function findTierMatches(content: string, oldText: string): TierResult {
  const exact = findAll(content, oldText);
  if (exact.matches.length > 0) {
    return { tier: "exact", matches: exact.matches, truncated: exact.truncated, space: "content" };
  }
  // A whitespace-only oldText ("  \n", "\t") normalizes to an empty or
  // newline-only needle — indexOf("") spins out phantom zero-length matches
  // and a bare "\n" matches every line break. Skip the tier so the not-found
  // diagnostics speak; a byte-exact whitespace match already won at tier 1.
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  if (fuzzyOld.trim() !== "") {
    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzy = findAll(fuzzyContent, fuzzyOld);
    if (fuzzy.matches.length > 0) {
      return {
        tier: "normalized",
        matches: fuzzy.matches,
        truncated: fuzzy.truncated,
        space: "fuzzy",
        fuzzyContent,
      };
    }
  }
  const elastic = findElastic(content, oldText);
  if (elastic.matches.length > 0) {
    return { tier: "indent-elastic", matches: elastic.matches, truncated: elastic.truncated, space: "content" };
  }
  // A truncated empty search still means "may exist, unscanned" — keep the
  // flag so the not-found error can say the search was cut short.
  return { tier: "none", matches: [], truncated: elastic.truncated, space: "content" };
}

/** Lines a tier's offsets address: fuzzy offsets keep real line numbers. */
function tierLines(ladder: TierResult, content: string): Line[] {
  return getLines(ladder.space === "fuzzy" ? ladder.fuzzyContent! : content);
}

// ---------------------------------------------------------------------------
// Current↔original offset tracking (attributes failures to the edit that
// rewrote the region)
// ---------------------------------------------------------------------------

interface MapSeg {
  curStart: number;
  curEnd: number;
  origStart: number;
  origEnd: number;
}

/**
 * Piecewise-linear map from current-content offsets back to original-content
 * offsets across a sequence of splices. Exact at splice boundaries; inside a
 * replacement segment it interpolates (and clamps) into the span that was
 * replaced — good enough for line-range attribution in diagnostics.
 */
export class OffsetMap {
  private segs: MapSeg[];

  constructor(length: number) {
    this.segs = [{ curStart: 0, curEnd: length, origStart: 0, origEnd: length }];
  }

  origOf(cur: number): number {
    for (const seg of this.segs) {
      if (cur >= seg.curStart && cur < seg.curEnd) {
        return Math.min(seg.origStart + (cur - seg.curStart), seg.origEnd);
      }
    }
    const last = this.segs[this.segs.length - 1];
    if (cur === last.curEnd) return last.origEnd;
    throw new Error(`OffsetMap.origOf: offset ${cur} out of range`);
  }

  /** Record a splice; returns the replaced region's original span. */
  splice(curStart: number, oldLen: number, newLen: number): { origStart: number; origEnd: number } {
    const origStart = this.origOf(curStart);
    const origEnd = this.origOf(curStart + oldLen);
    this.splitAt(curStart);
    this.splitAt(curStart + oldLen);
    const delta = newLen - oldLen;
    const next: MapSeg[] = [];
    let inserted = false;
    for (const seg of this.segs) {
      if (seg.curEnd <= curStart) {
        next.push(seg);
      } else if (seg.curStart >= curStart + oldLen) {
        next.push({ ...seg, curStart: seg.curStart + delta, curEnd: seg.curEnd + delta });
      } else if (!inserted) {
        next.push({ curStart, curEnd: curStart + newLen, origStart, origEnd });
        inserted = true;
      }
    }
    this.segs = next;
    return { origStart, origEnd };
  }

  private splitAt(pos: number): void {
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i];
      if (pos > seg.curStart && pos < seg.curEnd) {
        const mid = seg.origStart + (pos - seg.curStart);
        this.segs.splice(
          i,
          1,
          { curStart: seg.curStart, curEnd: pos, origStart: seg.origStart, origEnd: mid },
          { curStart: pos, curEnd: seg.curEnd, origStart: mid, origEnd: seg.origEnd },
        );
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sequential application
// ---------------------------------------------------------------------------

export interface EditSpec {
  oldText: string;
  newText: string;
  /** 1-based match index in file order, or "all" to replace every match. */
  occurrence?: number | "all";
}

export interface AppliedEdit {
  editIndex: number;
  tier: TierName;
  occurrences: number;
  indentShift?: number;
  /** False when the splice reproduced the existing bytes (elastic re-indent). */
  changed: boolean;
  /** The replaced region's span in the original content. */
  origStart: number;
  origEnd: number;
}

function label(editIndex: number, totalEdits: number): string {
  return totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
}

/** Drop matches that overlap an earlier kept match (possible on the elastic tier). */
function nonOverlapping(matches: TierMatch[]): TierMatch[] {
  const kept: TierMatch[] = [];
  let end = -1;
  for (const m of matches) {
    if (m.start >= end) {
      kept.push(m);
      end = m.end;
    }
  }
  return kept;
}

/** One in-memory splice plus offset-map bookkeeping; returns the new content. */
function spliceContent(content: string, start: number, end: number, replacement: string, map: OffsetMap): string {
  map.splice(start, end - start, replacement.length);
  return content.slice(0, start) + replacement + content.slice(end);
}

/**
 * Apply a normalized-tier edit by rebuilding the touched lines from the
 * normalized content (so the match's fuzzy offsets apply) while every
 * untouched line keeps its original bytes. Matches are grouped into line
 * ranges first so several matches on one line land in one rebuild; groups are
 * spliced in descending order so earlier offsets stay valid. Returns the
 * original span of the lowest group for attribution.
 */
function applyNormalizedTier(
  content: string,
  fuzzyContent: string,
  matches: TierMatch[],
  newText: string,
  map: OffsetMap,
): { content: string; changed: boolean; origSpan: { origStart: number; origEnd: number } } {
  const contentLines = getLines(content);
  const fuzzyLines = getLines(fuzzyContent);
  if (contentLines.length !== fuzzyLines.length) {
    throw new Error("Internal error: normalization changed the line count.");
  }
  const withRanges = matches
    .map((m) => ({
      m,
      l1: lineOfOffset(fuzzyLines, m.start) - 1,
      l2: lineOfOffset(fuzzyLines, Math.max(m.start, m.end - 1)) - 1,
    }))
    .sort((a, b) => a.l1 - b.l1);
  const groups: Array<{ l1: number; l2: number; ms: TierMatch[] }> = [];
  for (const { m, l1, l2 } of withRanges) {
    const last = groups[groups.length - 1];
    if (last && l1 <= last.l2) {
      last.l2 = Math.max(last.l2, l2);
      last.ms.push(m);
    } else {
      groups.push({ l1, l2, ms: [m] });
    }
  }
  let current = content;
  let changed = false;
  let origSpan = { origStart: 0, origEnd: 0 };
  for (const group of [...groups].sort((a, b) => b.l1 - a.l1)) {
    const f1 = fuzzyLines[group.l1];
    const f2 = fuzzyLines[group.l2];
    const groupStart = f1.start;
    const groupEnd = f2.end + (f2.hasNewline ? 1 : 0);
    let groupText = fuzzyContent.slice(groupStart, groupEnd);
    for (const m of [...group.ms].sort((a, b) => b.start - a.start)) {
      groupText = groupText.slice(0, m.start - groupStart) + newText + groupText.slice(m.end - groupStart);
    }
    const curLines = getLines(current);
    const curStart = curLines[group.l1].start;
    const curEnd = curLines[group.l2].end + (curLines[group.l2].hasNewline ? 1 : 0);
    const rebuilt =
      curLines.slice(0, group.l1).map(fullText).join("") +
      groupText +
      curLines
        .slice(group.l2 + 1)
        .map(fullText)
        .join("");
    if (rebuilt !== current) changed = true;
    const span = map.splice(curStart, curEnd - curStart, groupText.length);
    if (group === groups[0]) origSpan = span; // groups[0] is the lowest line range
    current = rebuilt;
  }
  return { content: current, changed, origSpan };
}

/**
 * Apply edits sequentially against `content`: each edit's oldText is matched
 * against the file as it stands after the earlier edits (the python
 * str.replace semantics), with uniqueness enforced unless occurrence selects.
 * Throws a diagnostic Error on any failure; the caller writes only on a
 * returned result — all-or-nothing per call.
 */
export function applyEdits(
  content: string,
  edits: EditSpec[],
  opts: { path: string; allCap: number },
): { newContent: string; applied: AppliedEdit[] } {
  const normalized = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
    occurrence: e.occurrence,
  }));
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    if (e.oldText.length === 0) {
      throw new Error(
        `${label(i, normalized.length)}: oldText is empty in ${opts.path}. To insert text, include the surrounding lines in oldText and place the insertion in newText.`,
      );
    }
    if (e.oldText === e.newText) {
      throw new Error(
        `${label(i, normalized.length)}: oldText and newText are identical in ${opts.path} — nothing to do.`,
      );
    }
    if (
      e.occurrence !== undefined &&
      e.occurrence !== "all" &&
      (typeof e.occurrence !== "number" || !Number.isInteger(e.occurrence) || e.occurrence < 1)
    ) {
      throw new Error(`occurrence must be a positive integer or "all" (got ${JSON.stringify(e.occurrence)}).`);
    }
  }

  let current = content;
  const map = new OffsetMap(content.length);
  const applied: AppliedEdit[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const edit = normalized[i];
    const ladder = findTierMatches(current, edit.oldText);
    if (ladder.tier === "none") {
      throw notFoundError(opts.path, i, normalized.length, content, current, edit.oldText, applied, ladder.truncated);
    }

    let chosen: TierMatch[];
    if (edit.occurrence === "all") {
      if (ladder.matches.length > opts.allCap || ladder.truncated) {
        throw tooManyForAllError(opts.path, i, normalized.length, ladder, current, opts.allCap);
      }
      chosen = nonOverlapping(ladder.matches);
      if (chosen.length !== ladder.matches.length) {
        // Sliding elastic windows can overlap (consecutive equal lines);
        // "every match" is then ill-defined, so refuse instead of silently
        // leaving sites behind. Name the first kept/dropped conflict by set
        // difference — the kept array is not a prefix of the matches.
        const lines = tierLines(ladder, current);
        const keptSet = new Set(chosen);
        const firstDropped = ladder.matches.find((m) => !keptSet.has(m))!;
        const conflict = [...chosen].reverse().find((m) => m.start < firstDropped.start) ?? chosen[0];
        throw new Error(
          `${label(i, normalized.length)}: its ${ladder.matches.length} matches overlap (${lineRangeDesc(opts.path, lines, conflict)} and ${lineRangeDesc(opts.path, lines, firstDropped)}), so occurrence: "all" cannot replace every site unambiguously — oldText repeats across consecutive lines. Use an oldText with distinct lines, or replace occurrences one at a time.`,
        );
      }
    } else if (typeof edit.occurrence === "number") {
      if (edit.occurrence > ladder.matches.length) {
        throw occurrenceOutOfRangeError(opts.path, i, normalized.length, edit.occurrence, ladder, current);
      }
      chosen = [ladder.matches[edit.occurrence - 1]];
    } else {
      if (ladder.matches.length > 1) throw multiMatchError(opts.path, i, normalized.length, ladder, current);
      chosen = [ladder.matches[0]];
    }

    let changed = false;
    let origSpan = { origStart: 0, origEnd: 0 };
    if (ladder.space === "fuzzy") {
      const res = applyNormalizedTier(current, ladder.fuzzyContent!, chosen, edit.newText, map);
      current = res.content;
      changed = res.changed;
      origSpan = res.origSpan;
    } else {
      const ordered = [...chosen].sort((a, b) => b.start - a.start);
      const first = ordered[ordered.length - 1]; // lowest-offset match
      // Read the span before splicing: a splice can shrink the content, and
      // the map only addresses offsets that still exist afterwards.
      origSpan = { origStart: map.origOf(first.start), origEnd: map.origOf(first.end) };
      for (const m of ordered) {
        const replacement = ladder.tier === "indent-elastic" ? shiftText(edit.newText, m.indentShift) : edit.newText;
        if (replacement !== current.slice(m.start, m.end)) changed = true;
        current = spliceContent(current, m.start, m.end, replacement, map);
      }
    }
    applied.push({
      editIndex: i,
      tier: ladder.tier,
      occurrences: chosen.length,
      indentShift: ladder.tier === "indent-elastic" ? chosen[0].indentShift : undefined,
      changed,
      ...origSpan,
    });
  }
  return { newContent: current, applied };
}

// ---------------------------------------------------------------------------
// Error messages — diagnostics, not dead ends
// ---------------------------------------------------------------------------

function lineRangeDesc(path: string, lines: Line[], m: TierMatch): string {
  const l1 = lineOfOffset(lines, m.start);
  const l2 = lineOfOffset(lines, Math.max(m.start, m.end - 1));
  return l1 === l2 ? `${path}:${l1}` : `${path}:${l1}–${l2}`;
}

function tierNote(tier: TierName | "none"): string {
  if (tier === "normalized") return " (matched after Unicode/whitespace normalization)";
  if (tier === "indent-elastic") return " (matched with indentation flexibility)";
  return "";
}

function multiMatchError(
  path: string,
  editIndex: number,
  totalEdits: number,
  ladder: TierResult,
  content: string,
): Error {
  const lines = tierLines(ladder, content);
  const shown = ladder.matches.slice(0, MAX_SITES_SHOWN);
  const parts = shown.map((m) => {
    const l1 = lineOfOffset(lines, m.start) - 1;
    const ctx: string[] = [];
    for (let j = l1; j < Math.min(l1 + SITE_CONTEXT_LINES, lines.length); j++) {
      ctx.push(lines[j].text.slice(0, 100));
    }
    return `  ${lineRangeDesc(path, lines, m)}:\n${ctx.map((c) => `    ${c}`).join("\n")}`;
  });
  const more = ladder.matches.length - shown.length;
  const head =
    `Found ${ladder.matches.length}${ladder.truncated ? "+" : ""} matches of ${label(editIndex, totalEdits)} in ${path}${tierNote(ladder.tier)}.\n` +
    parts.join("\n") +
    (more > 0 ? `\n  …and ${more} more` : "");
  return new Error(
    `${head}\nPass occurrence: N (1-based, in file order) to replace a specific match, occurrence: "all" to replace every match, or extend oldText with surrounding lines so it is unique.`,
  );
}

function tooManyForAllError(
  path: string,
  editIndex: number,
  totalEdits: number,
  ladder: TierResult,
  content: string,
  cap: number,
): Error {
  const lines = tierLines(ladder, content);
  const sample = ladder.matches
    .slice(0, 3)
    .map((m) => lineRangeDesc(path, lines, m))
    .join(", ");
  return new Error(
    `${label(editIndex, totalEdits)} with occurrence: "all" would replace ${ladder.matches.length}${ladder.truncated ? "+" : ""} locations in ${path} (cap: ${cap}). ` +
      `oldText is too generic to replace everywhere — extend it with more surrounding lines, or replace specific matches with occurrence: N. First sites: ${sample}.`,
  );
}

function occurrenceOutOfRangeError(
  path: string,
  editIndex: number,
  totalEdits: number,
  requested: number,
  ladder: TierResult,
  content: string,
): Error {
  const lines = tierLines(ladder, content);
  const sites = ladder.matches
    .slice(0, 10)
    .map((m) => lineRangeDesc(path, lines, m))
    .join(", ");
  return new Error(
    `${label(editIndex, totalEdits)} requests occurrence: ${requested}, but only ${ladder.matches.length}${ladder.truncated ? "+" : ""} match(es) exist in ${path}${sites ? ` (at ${sites})` : ""}.`,
  );
}

function notFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  original: string,
  current: string,
  oldText: string,
  applied: AppliedEdit[],
  searchTruncated: boolean,
): Error {
  const name = label(editIndex, totalEdits);
  // 1. Did an earlier edit in this same call rewrite the region? Match against
  //    the file as it began; an intersection with an applied edit's original
  //    span is the merge-them case.
  const origLadder = findTierMatches(original, oldText);
  if (origLadder.tier !== "none") {
    const origLines = getLines(original);
    const matchLines = getLines(origLadder.space === "fuzzy" ? origLadder.fuzzyContent! : original);
    for (const m of origLadder.matches) {
      const l1 = lineOfOffset(matchLines, m.start);
      const l2 = lineOfOffset(matchLines, Math.max(m.start, m.end - 1));
      const culprit = applied.find((a) => {
        const a1 = lineOfOffset(origLines, a.origStart);
        const a2 = lineOfOffset(origLines, Math.max(a.origStart, a.origEnd - 1));
        return l1 <= a2 && a1 <= l2;
      });
      if (culprit) {
        return new Error(
          `Could not find ${name} in ${path}: its oldText matched the file as it was before edits[${culprit.editIndex}] was applied (original lines ${l1}–${l2}), but edits[${culprit.editIndex}] rewrote that region. ` +
            `Edits apply in order and each matches the file as it stands after the earlier edits — merge this edit into edits[${culprit.editIndex}], or target the text now in the file.`,
        );
      }
    }
  }
  // 2. A cut-short search says so without naming a false cause: the budget
  //    can run out from repetition (window verification) or sheer size, and
  //    the region diagnostics would scan the same content and mostly bail.
  if (searchTruncated) {
    return new Error(
      `Could not find ${name} in ${path}: the flexible search was cut short — the file is too large or oldText too repetitive to scan within the search budget. Narrow oldText to a few distinctive lines, or copy the exact bytes from the file.`,
    );
  }
  // 3. Diagnostics against the current content.
  const diag = diagnose(oldText, current);
  if (diag.kind === "non-uniform") {
    const shifts = diag.shifts
      .slice(0, MAX_SHIFT_LINES)
      .map(
        (s) =>
          `  line ${s.line}: file ${s.fileCols} cols, you sent ${s.oldCols} cols (shift ${s.shift >= 0 ? "+" : ""}${s.shift})${s.shift !== diag.modal ? "  ← breaks the uniform shift" : ""}`,
      )
      .join("\n");
    const more =
      diag.shifts.length > MAX_SHIFT_LINES ? `\n  …and ${diag.shifts.length - MAX_SHIFT_LINES} more lines` : "";
    return new Error(
      `Could not find ${name} in ${path}, but lines ${diag.startLine}–${diag.endLine} match modulo indentation and the shift is not uniform (most lines shift ${diag.modal >= 0 ? "+" : ""}${diag.modal}):\n${shifts}${more}\n` +
        `Indentation-elastic matching requires every non-blank line to shift by the same amount. Read ${path} around line ${diag.startLine} and copy its exact indentation into oldText.`,
    );
  }
  if (diag.kind === "region") {
    const head = diag.similarity
      ? `Closest region (found by fuzzy similarity): lines ${diag.startLine}–${diag.endLine} (${diag.matched} of ${diag.total} lines match exactly).`
      : `Closest region: lines ${diag.startLine}–${diag.endLine} (${diag.matched} of ${diag.total} lines match).`;
    return new Error(
      `Could not find ${name} in ${path}. ${head} "-" is your oldText, "+" is the file:\n${diag.lines.join("\n")}` +
        (diag.notes.length > 0 ? `\n${diag.notes.join("\n")}` : ""),
    );
  }
  return new Error(
    `Could not find ${name} in ${path}, and no region looks similar (file has ${getLines(current).length} lines). ` +
      `Re-read ${path} around where you expect this text and copy the exact bytes into oldText.`,
  );
}

// ---------------------------------------------------------------------------
// Closest-region diagnosis
// ---------------------------------------------------------------------------

interface NonUniformDiag {
  kind: "non-uniform";
  startLine: number;
  endLine: number;
  /** The most common shift; lines deviating from it are marked. */
  modal: number;
  shifts: Array<{ line: number; fileCols: number; oldCols: number; shift: number }>;
}

interface RegionDiag {
  kind: "region";
  startLine: number;
  endLine: number;
  matched: number;
  total: number;
  /** True when the window was located by similarity rather than exact lines. */
  similarity: boolean;
  lines: string[];
  notes: string[];
}

type Diagnosis = NonUniformDiag | RegionDiag | { kind: "none" };

/**
 * Diagnose a failed match: prefer the precise non-uniform-indentation report
 * (the tier-3 near-miss), then the closest region by anchor scoring — with a
 * bigram-similarity seed for text where no line matches exactly (typos,
 * drift) — else report that nothing looks similar.
 */
function diagnose(oldText: string, content: string): Diagnosis {
  const oldLines = oldText.split("\n");
  if (oldText.endsWith("\n")) oldLines.pop();
  const k = oldLines.length;
  if (k === 0) return { kind: "none" };
  const contentLines = getLines(content);
  const oldKeys = oldLines.map(lineKey);
  const contentKeys = contentLines.map((l) => lineKey(l.text));
  const nonBlank = oldKeys.filter((key) => key !== "").length;
  if (nonBlank === 0) return { kind: "none" };

  // Diagnostics share the elastic search's comparison budget: repetitive input
  // must not wedge the tool on the failure path either. Exhausted stages
  // degrade to the next (or to the honest "nothing similar"), never to an
  // unbounded scan.
  let budget = MAX_VERIFY_COMPARISONS;
  const spend = (n: number): boolean => (budget -= n) >= 0;

  // Positions of each non-blank old key in the content, in one pass — the
  // per-key rescan would make the cost O(old lines x file lines), and file
  // size alone must not eat the diagnostic budget.
  const positions = new Map<string, number[]>();
  const wanted = new Set(oldKeys.filter((key) => key !== ""));
  for (let j = 0; j < contentKeys.length && wanted.size > 0; j++) {
    if (!spend(1)) return { kind: "none" };
    const key = contentKeys[j];
    if (!wanted.has(key)) continue;
    const idxs = positions.get(key);
    if (idxs) idxs.push(j);
    else positions.set(key, [j]);
  }

  // Full-key-match windows: every line matches after trim. The elastic tier
  // already rejected these, so any that survive break the uniform shift.
  if (positions.size > 0) {
    let best: { w: number; shifts: NonUniformDiag["shifts"] } | null = null;
    for (const [key, idxs] of positions) {
      for (let a = 0; a < k; a++) {
        if (oldKeys[a] !== key) continue;
        for (const p of idxs) {
          const w = p - a;
          if (w < 0 || w + k > contentLines.length) continue;
          if (!spend(k)) break;
          if (!windowKeysMatch(contentKeys, oldKeys, w, k)) continue;
          const shifts = collectShifts(contentLines, oldLines, w, k);
          if (modalShare(shifts) >= 2 / 3 && (best === null || modalShare(shifts) > modalShare(best.shifts))) {
            best = { w, shifts };
          }
        }
      }
    }
    if (best) {
      return {
        kind: "non-uniform",
        startLine: best.w + 1,
        endLine: best.w + k,
        modal: modalShift(best.shifts),
        shifts: best.shifts,
      };
    }
  }

  // Closest region by anchor scoring. bestW/bestScore are number sentinels:
  // closure assignments do not participate in null-narrowing, so no nulls here.
  const threshold = Math.max(1, Math.ceil(nonBlank / 2));
  const scoreWindow = (w: number): number => {
    if (w < 0 || w + k > contentLines.length) return 0;
    let score = 0;
    for (let i = 0; i < k; i++) {
      if (oldKeys[i] !== "" && contentKeys[w + i] === oldKeys[i]) score++;
    }
    return score;
  };
  let bestW = -1;
  let bestScore = 0;
  for (const [key, idxs] of positions) {
    for (let a = 0; a < k; a++) {
      if (oldKeys[a] !== key) continue;
      for (const p of idxs) {
        if (!spend(k)) break;
        const score = scoreWindow(p - a);
        if (score > bestScore) {
          bestScore = score;
          bestW = p - a;
        }
      }
    }
  }
  if (bestW >= 0 && bestScore >= threshold) {
    return renderRegionDiag(contentLines, oldLines, bestW, k, bestScore, false);
  }

  // Similarity seed: no line matches exactly, so find the most similar line
  // and align its window. Covers typo'd or drifted oldText — scored by dice,
  // or by containment for substantive lines, since a sentence pasted out of a
  // long file line is near-fully contained in it while dice sees only the
  // length mismatch. Short lines use dice alone: a 3-word fragment is trivially
  // "contained" in many lines, so containment would point anywhere.
  const probeIdxs: number[] = [];
  for (let i = 0; i < k && probeIdxs.length < 4; i++) {
    if (oldKeys[i] !== "") probeIdxs.push(i);
  }
  let bestSeed: { sim: number; contentIdx: number; oldIdx: number } | null = null;
  for (const a of probeIdxs) {
    const grams = bigrams(oldKeys[a]);
    const substantive = oldKeys[a].length >= 20;
    for (let j = 0; j < contentKeys.length; j++) {
      if (contentKeys[j] === "") continue;
      if (!spend(contentKeys[j].length)) break; // bigram cost tracks line length
      const fileGrams = bigrams(contentKeys[j]);
      const sim = substantive
        ? Math.max(dice(grams, fileGrams), containment(grams, fileGrams))
        : dice(grams, fileGrams);
      if (sim > 0 && (bestSeed === null || sim > bestSeed.sim)) bestSeed = { sim, contentIdx: j, oldIdx: a };
    }
  }
  if (bestSeed && bestSeed.sim >= 0.55) {
    const w = bestSeed.contentIdx - bestSeed.oldIdx;
    if (w >= 0 && w + k <= contentLines.length) {
      return renderRegionDiag(contentLines, oldLines, w, k, scoreWindow(w), true);
    }
  }
  return { kind: "none" };
}

function windowKeysMatch(contentKeys: string[], oldKeys: string[], w: number, k: number): boolean {
  for (let i = 0; i < k; i++) {
    if (contentKeys[w + i] !== oldKeys[i]) return false;
  }
  return true;
}

function collectShifts(contentLines: Line[], oldLines: string[], w: number, k: number): NonUniformDiag["shifts"] {
  const shifts: NonUniformDiag["shifts"] = [];
  for (let i = 0; i < k; i++) {
    if (oldLines[i].trim() === "") continue;
    const fileCols = expandIndent(contentLines[w + i].text);
    const oldCols = expandIndent(oldLines[i]);
    shifts.push({ line: w + i + 1, fileCols, oldCols, shift: fileCols - oldCols });
  }
  return shifts;
}

function modalShift(shifts: NonUniformDiag["shifts"]): number {
  if (shifts.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const s of shifts) counts.set(s.shift, (counts.get(s.shift) ?? 0) + 1);
  let modal = 0;
  let max = -1;
  for (const [shift, count] of counts) {
    if (count > max) {
      modal = shift;
      max = count;
    }
  }
  return modal;
}

function modalShare(shifts: NonUniformDiag["shifts"]): number {
  if (shifts.length === 0) return 1;
  const counts = new Map<number, number>();
  for (const s of shifts) counts.set(s.shift, (counts.get(s.shift) ?? 0) + 1);
  return Math.max(...counts.values()) / shifts.length;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) {
    if (b.has(g)) shared++;
  }
  return (2 * shared) / (a.size + b.size);
}

/** Fraction of a's bigrams present in b. Length-skew tolerant: a drifted
 * sentence inside a much longer file line scores ~1 here, where dice — which
 * penalizes the size mismatch — collapses. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const g of a) {
    if (b.has(g)) shared++;
  }
  return shared / a.size;
}

/** Render the closest-region diagnostic: a capped, line-numbered diff plus whitespace notes. */
function renderRegionDiag(
  contentLines: Line[],
  oldLines: string[],
  w: number,
  k: number,
  score: number,
  similarity: boolean,
): RegionDiag {
  const width = String(contentLines.length).length;
  const num = (n: number) => String(n).padStart(width, " ");
  type Row = { kind: "ctx" | "diff"; fileLine?: number; old?: string; file?: string };
  const rows: Row[] = [];
  for (let i = 0; i < k; i++) {
    const oldText = oldLines[i];
    const fileText = contentLines[w + i].text;
    if (lineKey(oldText) === lineKey(fileText)) rows.push({ kind: "ctx", fileLine: w + i + 1 });
    else rows.push({ kind: "diff", fileLine: w + i + 1, old: oldText, file: fileText });
  }
  // Keep context around the first three difference clusters; elide the rest.
  const keep = new Set<number>();
  let clusters = 0;
  let lastDiff = -2;
  for (let i = 0; i < k; i++) {
    if (rows[i].kind !== "diff") continue;
    if (i > lastDiff + 1) clusters++;
    if (clusters <= 3) {
      for (let j = Math.max(0, i - 2); j <= Math.min(k - 1, i + 2); j++) keep.add(j);
    }
    lastDiff = i;
  }
  if (keep.size === 0) {
    // No differing lines (a wildly non-uniform window that failed the modal
    // test): still show the region's edges instead of a bare ellipsis.
    for (let i = 0; i < Math.min(2, k); i++) keep.add(i);
    for (let i = Math.max(0, k - 2); i < k; i++) keep.add(i);
  }
  const lines: string[] = [];
  let elided = 0;
  for (let i = 0; i < k; i++) {
    if (!keep.has(i)) {
      elided++;
      if (elided === 1) lines.push(`  ${" ".repeat(width)} …`);
      continue;
    }
    const row = rows[i];
    if (row.kind === "ctx") lines.push(`  ${num(row.fileLine!)}  ${contentLines[w + i].text.slice(0, 100)}`);
    else {
      lines.push(`- ${" ".repeat(width)}  ${(row.old ?? "").slice(0, 100)}`);
      lines.push(`+ ${num(row.fileLine!)}  ${(row.file ?? "").slice(0, 100)}`);
    }
  }
  const notes: string[] = [];
  if (similarity)
    notes.push("note: region located by fuzzy similarity — check the diff above for typos or drifted text");
  let notesAdded = 0;
  for (let i = 0; i < k && notesAdded < 3; i++) {
    const row = rows[i];
    if (row.kind !== "diff") continue;
    const oldLead = (row.old ?? "").match(/^[\t ]*/)?.[0] ?? "";
    const fileLead = (row.file ?? "").match(/^[\t ]*/)?.[0] ?? "";
    if (oldLead.includes("\t") !== fileLead.includes("\t")) {
      notes.push(
        `note: line ${row.fileLine} — file uses ${fileLead.includes("\t") ? "tabs" : "spaces"}, you sent ${oldLead.includes("\t") ? "tabs" : "spaces"}`,
      );
      notesAdded++;
    } else if (oldLead !== fileLead) {
      notes.push(
        `note: line ${row.fileLine} — you sent ${expandIndent(oldLead)} leading columns, file has ${expandIndent(fileLead)}`,
      );
      notesAdded++;
    }
  }
  return {
    kind: "region",
    startLine: w + 1,
    endLine: w + k,
    matched: score,
    total: k,
    similarity,
    lines: lines.length > MAX_DIAG_LINES ? [...lines.slice(0, MAX_DIAG_LINES), "  … (diagnostic truncated)"] : lines,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Input leniency (mirrors the built-in's prepareArguments, plus file_path)
// ---------------------------------------------------------------------------

function isSingleEditInput(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as { oldText?: unknown; newText?: unknown };
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Normalize tool-call argument quirks before schema validation: edits sent as
 * a JSON string, a single edit object instead of an array, legacy top-level
 * oldText/newText, and the file_path alias for path. Pure: returns a fixed-up
 * copy, never mutates the input.
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.path !== "string" && typeof args.file_path === "string") {
    args.path = args.file_path;
    delete args.file_path;
  }
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEditInput(parsed)) args.edits = [parsed];
    } catch {
      // leave as-is; schema validation reports it
    }
  } else if (isSingleEditInput(args.edits)) {
    args.edits = [args.edits];
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    delete args.oldText;
    delete args.newText;
    args.edits = edits;
  }
  return args;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface SuperEditInput {
  path: string;
  edits: EditSpec[];
}

export interface SuperEditDetails extends EditToolDetails {
  /** Human-readable notes for every non-exact or multi-occurrence application. */
  notes: string[];
}

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement, matched against the file as it stands after the previous edits. Must be unique unless occurrence is given.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
      occurrence: Type.Optional(
        Type.Union([Type.Number(), Type.Literal("all")], {
          description:
            'Disambiguation when oldText matches several places: the 1-based match index in file order, or "all" to replace every match. Uniqueness is enforced only when omitted.',
        }),
      ),
    }),
    {
      description:
        "One or more targeted replacements, applied in order: each oldText is matched against the file as it stands after the previous edits, so chained edits work. Do not emit overlapping edits — merge them into one.",
    },
  ),
});

function describeApplied(a: AppliedEdit, totalEdits: number): string {
  const name = totalEdits === 1 ? "the edit" : `edits[${a.editIndex}]`;
  const parts: string[] = [];
  if (a.tier === "normalized") parts.push("matched after Unicode/whitespace normalization");
  if (a.tier === "indent-elastic") {
    const shift = a.indentShift ?? 0;
    parts.push(
      shift === 0
        ? "matched with tab/space normalization (no shift)"
        : `matched with indentation flexibility (shift ${shift > 0 ? "+" : ""}${shift})`,
    );
  }
  if (a.occurrences > 1) parts.push(`replaced ${a.occurrences} occurrences (occurrence: "all")`);
  if (!a.changed) parts.push("reproduced the existing text exactly");
  return parts.length > 0 ? `${name}: ${parts.join("; ")}` : "";
}

/** Default local-filesystem operations; tests inject fakes. */
const defaultOperations: EditOperations = {
  readFile: (p) => readFile(p),
  writeFile: (p, content) => writeFile(p, content, "utf-8"),
  access: (p) => access(p, constants.R_OK | constants.W_OK),
};

/**
 * The forgiving-matcher edit tool, named `edit` so it replaces pi's built-in
 * by name. See the file header for the semantics; `operations` is injected in
 * tests, `allCap` is read per call so the env knob applies live.
 */
export function createSuperEditTool(cwd: string, opts: { operations?: EditOperations; allCap?: () => number } = {}) {
  const ops = opts.operations ?? defaultOperations;
  return defineTool({
    name: "edit",
    label: "edit",
    description:
      'Edit a single file using text replacement. edits[] apply in order: each oldText is matched against the file as it stands after the previous edits, so chained edits work; overlapping edits must be merged into one. Matching tries exact bytes first, then Unicode/whitespace-normalized text, then whole-line matches with a uniform indentation shift (the replacement is re-indented to match the file). oldText must match exactly one place unless occurrence is given: the 1-based match index in file order, or "all" to replace every match. Failures are diagnostic — not-found shows the closest region as a diff with line numbers; multiple matches list up to five locations, then "...and N more".',
    promptSnippet:
      "Make precise file edits with text replacement, including multiple disjoint or chained edits in one call",
    promptGuidelines: [
      "Use edit for precise changes. edits[] apply in order — each oldText must match the file as it stands after the previous edits (chained edits are fine; overlapping edits must be merged into one).",
      "Matching is forgiving in safe ways: exact bytes first, then Unicode/whitespace normalization, then a uniform whole-line indent shift. A forgiving match is only applied when unambiguous and is reported in the result.",
      'When oldText matches several places, pass edits[].occurrence (1-based, in file order) or "all" to replace every match; otherwise the error lists every location.',
      "On failure the error shows the closest region as a diff — read the listed lines and fix oldText. Never rewrite files through a shell script to work around edit.",
      "Keep edits[].oldText as small as possible while still unique in the file.",
    ],
    parameters: editSchema,
    prepareArguments: (args: unknown) => prepareEditArguments(args) as SuperEditInput,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    renderCall(args, theme, context) {
      // Arguments stream in partially; guard until `path` arrives.
      const path = typeof args?.path === "string" ? args.path : "";
      const text = reuseText(context);
      text.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${path}`);
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = reuseText(context);
      const first = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      const details = result.details as SuperEditDetails | undefined;
      if (context.isError || !details?.diff) {
        text.setText(first ? theme.fg("error", first) : "");
        return text;
      }
      const diff = details.diff
        .split("\n")
        .map((line) => {
          const shown = line.replace(/\t/g, "   ");
          if (shown.startsWith("+")) return theme.fg("toolDiffAdded", shown);
          if (shown.startsWith("-")) return theme.fg("toolDiffRemoved", shown);
          return theme.fg("toolDiffContext", shown);
        })
        .join("\n");
      const summary = first ? `${theme.fg("muted", first)}\n` : "";
      text.setText(summary + diff);
      return text;
    },
    async execute(_toolCallId, input, signal, _onUpdate, ctx): Promise<AgentToolResult<SuperEditDetails>> {
      const { path, edits } = validateEditInput(input);
      const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort listener: that would release the
        // mutation queue while an in-flight write may still land. Checking
        // after each await observes the same aborts with the queue held.
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();
        try {
          await ops.access(absolutePath);
        } catch (error) {
          throwIfAborted();
          const code = fsErrorCode(error);
          if (code === "ENOENT") {
            throw new Error(
              `Could not edit ${path}: file not found. edit cannot create files — use write to create it first.`,
            );
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not edit file: ${path}. ${code ? `Error code: ${code}. ` : ""}${detail}`);
        }
        throwIfAborted();
        let buffer: Buffer;
        try {
          buffer = await ops.readFile(absolutePath);
        } catch (error) {
          throwIfAborted();
          // A directory passes the access probe but fails the read (EISDIR);
          // a vanished file is a TOCTOU ENOENT. Both get the tool's own words.
          const code = fsErrorCode(error);
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not read file: ${path}. ${code ? `Error code: ${code}. ` : ""}${detail}`);
        }
        const raw = buffer.toString("utf-8");
        throwIfAborted();
        const { bom, text } = splitBom(raw);
        const ending = detectLineEnding(text);
        const normalized = normalizeToLF(text);
        const allCap = opts.allCap?.() ?? DEFAULT_ALL_CAP;
        const { newContent, applied } = applyEdits(normalized, edits, { path, allCap });
        throwIfAborted();
        if (newContent === normalized) {
          const notes = applied
            .filter((a) => !a.changed)
            .map((a) => describeApplied(a, edits.length))
            .filter((n) => n !== "");
          const why = notes.length > 0 ? ` ${notes.join("; ")}.` : "";
          throw new Error(
            `No changes made to ${path}: the replacement(s) produced identical content.${why} This might indicate special characters or the text not being what you expect — re-read the region and adjust.`,
          );
        }
        const finalContent = bom + restoreLineEndings(newContent, ending);
        try {
          await ops.writeFile(absolutePath, finalContent);
        } catch (error) {
          throwIfAborted();
          const code = fsErrorCode(error);
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Could not write file: ${path}. ${code ? `Error code: ${code}. ` : ""}${detail} The file may be unchanged or partially written — re-read it before retrying.`,
          );
        }
        // No abort check here: the write has committed, and reporting a landed
        // edit as "aborted" would send the model to re-apply it and hit a
        // confusing no-change error on the next call.
        const diffResult = generateDiffString(normalized, newContent);
        const patch = generateUnifiedPatch(path, normalized, newContent);
        const notes = applied.map((a) => describeApplied(a, edits.length)).filter((n) => n !== "");
        const summary = `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${path}.${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine, notes },
        };
      });
    },
  });
}

/** fs-style error code off a thrown error, if any. */
function fsErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function validateEditInput(input: unknown): SuperEditInput {
  if (!input || typeof input !== "object") {
    throw new Error("Edit tool input is invalid.");
  }
  const args = input as { path?: unknown; edits?: unknown };
  if (typeof args.path !== "string" || args.path.length === 0) {
    throw new Error("Edit tool input is invalid: path must be a non-empty string.");
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i] as { oldText?: unknown; newText?: unknown; occurrence?: unknown };
    if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") {
      throw new Error(`Edit tool input is invalid: edits[${i}] needs string oldText and newText.`);
    }
    if (
      e.occurrence !== undefined &&
      e.occurrence !== "all" &&
      (typeof e.occurrence !== "number" || !Number.isInteger(e.occurrence) || e.occurrence < 1)
    ) {
      throw new Error(`Edit tool input is invalid: edits[${i}].occurrence must be a positive integer or "all".`);
    }
  }
  return { path: args.path, edits: args.edits as EditSpec[] };
}

/** Reuse the prior render component when available (pi renderer idiom). */
function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}
