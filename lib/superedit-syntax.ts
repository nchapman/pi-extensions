/**
 * superedit-syntax — post-edit syntax checking for the superedit tool, backed
 * by tree-sitter grammars loaded from native prebuilds.
 *
 * Design (the deliberate cuts):
 * - advisory, never a refusal: the edit has already landed when the check
 *   runs; the result carries a capped warning so the model can re-read and
 *   repair. tree-sitter can false-positive on unusual-but-valid code, so a
 *   refusal would trade correctness for convenience — the one trade this
 *   package never makes
 * - attribution: only diagnostics on lines the call actually rewrote are
 *   reported. Pre-existing errors elsewhere in the file are not this edit's
 *   fault, and blaming them sends the model to fix unrelated code. Splice
 *   positions are recorded as edits apply and forwarded through later
 *   splices to final-content line numbers; MISSING-kind diagnostics get ±1
 *   line of slack (zero-width tokens often sit just past the replacement)
 *   while ERROR nodes are held to the exact rewritten lines, so a
 *   pre-existing break on the adjacent line is not blamed on a clean edit
 * - fail-open everywhere: unknown extension, missing or incompatible
 *   grammar, oversize file, any throw — the check silently skips. A checker
 *   hiccup must never turn a landed edit into an error result
 * - bounded work: files above MAX_SYNTAX_BYTES skip the check (error
 *   recovery on a large mangled file is the slow path — measured 23 ms for
 *   483 KB clean but 6× that when every parse error fires; the 512 KB cap
 *   keeps the worst-case synchronous parse near 150 ms), kept diagnostics
 *   cap at 50 with early exit, and the walk itself caps at 500 visited
 *   diagnostics so a pre-broken file whose errors are all filtered out
 *   cannot drag the advisory check past its bounds
 * - self-contained: no imports from superedit.ts (which imports this
 *   module), so either file can be vendored alone; tests inject fake trees
 *   through the SyntaxTree/SyntaxLanguage shapes, which the real tree-sitter
 *   Node classes satisfy structurally
 *
 * Not a linter: tree-sitter flags structural damage (unbalanced delimiters,
 * stray tokens, unterminated strings) with exact positions; grammar-level
 * leniencies are invisible to it (e.g. the Python grammar accepts broken
 * indentation). What a mangled edit actually produces is exactly the former.
 *
 * Position handling: tree-sitter rows/columns/indexes are UTF-8 byte-based.
 * Rows are always exact (newline is one byte in UTF-8) and rows drive
 * filtering; byte columns are converted to code-unit indexes (exactly for
 * well-formed text, clamped for malformed surrogates) before display or
 * excerpt slicing, so excerpts quote the right text and printed columns
 * match what a re-reading model sees.
 */

/** PI_SUPEREDIT_SYNTAX=0|false disables the post-edit syntax check. */
export function parseSyntaxEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["PI_SUPEREDIT_SYNTAX"];
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

/** File extensions checked, mapped to tree-sitter grammar names. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyi: "python",
  json: "json",
  go: "go",
  rs: "rust",
};

/** Grammar name for a path's extension, or null when the check does not apply. */
export function languageNameForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  const ext = path.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Tree shapes — satisfied structurally by tree-sitter's Node/Tree, fakes in tests
// ---------------------------------------------------------------------------

export interface SyntaxNode {
  readonly type: string;
  readonly isMissing: boolean;
  /** Whether this node is an error or contains one — drives subtree pruning. */
  readonly hasError: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly childCount: number;
  child(index: number): SyntaxNode | null;
}

export interface SyntaxTree {
  readonly rootNode: SyntaxNode;
}

export interface SyntaxLanguage {
  parse(source: string): SyntaxTree;
}

/** Loads a grammar by name; null means "not available, skip the check". */
export type SyntaxLoader = (language: string) => Promise<SyntaxLanguage | null>;

// ---------------------------------------------------------------------------
// Diagnostic collection
// ---------------------------------------------------------------------------

export interface SyntaxDiagnostic {
  kind: "error" | "missing";
  /** 0-based line and code-unit column of the diagnostic. */
  row: number;
  column: number;
  /** Human/model-readable description, e.g. `missing ")"` or `unexpected "= ;"`. */
  detail: string;
}

/** Caps: kept diagnostics, diagnostics visited (see below), lines shown. */
const MAX_COLLECTED_DIAGS = 50;
const MAX_VISITED_DIAGS = 500;
const MAX_SHOWN_DIAGS = 5;
const MAX_EXCERPT_CHARS = 40;

/**
 * Collect ERROR and MISSING diagnostics, in position order. Depth-first with
 * an explicit stack — pathological nesting in a mangled file must not
 * overflow the JS stack — and subtrees without hasError are pruned, so a
 * clean file costs the root flag check and nothing else. ERROR nodes nested
 * inside an ERROR are suppressed (sub-noise) while MISSING tokens inside one
 * are still surfaced — they name what to re-insert.
 *
 * `keep(row, kind)` filters (and counts against the kept cap) so that
 * pre-existing errors earlier in the file cannot consume the cap before the
 * walk reaches the lines the edit rewrote — a half-mangled file with 60 old
 * errors must not hide the one error the edit introduced. `detail` is
 * formatted only for kept diagnostics (it splits the source; formatting it
 * for filtered ones would be the expensive part of walking a pre-broken
 * file), and a separate visited cap bounds the walk itself for the case
 * where nothing is kept at all.
 */
export function collectSyntaxDiagnostics(
  tree: SyntaxTree,
  source: string,
  keep?: (row: number, kind: "error" | "missing") => boolean,
): { diagnostics: SyntaxDiagnostic[]; truncated: boolean } {
  const lines = source.split("\n"); // once — never re-split per diagnostic
  const out: SyntaxDiagnostic[] = [];
  let visited = 0;
  const stack: Array<{ node: SyntaxNode; inError: boolean }> = [{ node: tree.rootNode, inError: false }];
  while (stack.length > 0) {
    const { node, inError } = stack.pop()!;
    const kind: SyntaxDiagnostic["kind"] | null =
      node.type === "ERROR" && !inError ? "error" : node.isMissing ? "missing" : null;
    if (kind !== null) {
      visited++;
      const row = node.startPosition.row;
      if (!keep || keep(row, kind)) {
        out.push({
          kind,
          row,
          // tree-sitter columns are UTF-8 bytes; convert to code units before
          // anything string-visible (printed column, excerpt slicing). The
          // conversion is O(column), so it runs only for kept diagnostics.
          column: byteColumnToUnits(lines[row] ?? "", node.startPosition.column),
          detail: kind === "error" ? errorDetail(node, lines) : `missing "${node.type}"`,
        });
      }
      if (out.length >= MAX_COLLECTED_DIAGS) {
        return { diagnostics: out.sort(byPosition), truncated: true };
      }
      // Nothing-kept files would otherwise walk and count unbounded.
      if (visited >= MAX_VISITED_DIAGS) {
        return { diagnostics: out.sort(byPosition), truncated: true };
      }
    }
    if (!node.hasError) continue; // clean subtree
    const childInError = inError || node.type === "ERROR";
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, inError: childInError });
    }
  }
  return { diagnostics: out.sort(byPosition), truncated: false };
}

function byPosition(a: SyntaxDiagnostic, b: SyntaxDiagnostic): number {
  return a.row - b.row || a.column - b.column;
}

function errorDetail(node: SyntaxNode, lines: string[]): string {
  // Index the split lines by row, never the raw string by byte index:
  // startIndex is UTF-8 bytes and the source is code units, so byte slicing
  // would quote text from past the error on any non-ASCII line above it.
  const line = lines[node.startPosition.row] ?? "";
  const start = byteColumnToUnits(line, node.startPosition.column);
  const excerpt = line.slice(start, start + MAX_EXCERPT_CHARS);
  let detail = `unexpected ${JSON.stringify(excerpt)}`;
  if (node.endPosition.row > node.startPosition.row + 2) {
    detail += ` (spans lines ${node.startPosition.row + 1}–${node.endPosition.row + 1})`;
  }
  return detail;
}

/**
 * UTF-8 byte column → code-unit index within a line. Exact for well-formed
 * text; tolerates lone surrogates (they cannot round-trip UTF-8 anyway) and
 * clamps at the line end.
 */
function byteColumnToUnits(line: string, byteColumn: number): number {
  let units = 0;
  let bytes = 0;
  while (units < line.length && bytes < byteColumn) {
    const code = line.charCodeAt(units);
    if (code >= 0xd800 && code <= 0xdbff) {
      units += 2; // surrogate pair: 4 bytes across 2 code units
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      units += 1; // lone low surrogate: count something, stay clamped
      bytes += 3;
    } else {
      units += 1;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Edited line ranges (splice positions → final-content line numbers)
// ---------------------------------------------------------------------------

/**
 * One replacement applied in memory: a UTF-16 code-unit span at application
 * time (JS string offsets from indexOf matching) and the inserted length in
 * code units. Not comparable with tree-sitter's UTF-8 byte indexes — only
 * line numbers cross that boundary.
 */
export interface EditSplice {
  start: number;
  end: number;
  insertLen: number;
}

/**
 * Map a position recorded when splice `after` applied through every later
 * splice, yielding final-content coordinates. Positions before a later
 * splice are untouched; positions at or past its end shift by its delta;
 * positions inside the replaced span clamp into the new text — enough for
 * line-range attribution.
 */
function forwardThrough(splices: EditSplice[], after: number, p: number): number {
  for (let j = after + 1; j < splices.length; j++) {
    const s = splices[j];
    if (p < s.start) continue;
    if (p >= s.end) {
      p += s.insertLen - (s.end - s.start);
      continue;
    }
    p = s.start + Math.min(p - s.start, s.insertLen);
  }
  return p;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`, by binary search over line starts. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Final-content line ranges the splices touched, as merged [first, last]
 * 1-based pairs with ±`slack` lines (default 1: MISSING tokens are
 * zero-width and often sit just past the replacement). Empty for an empty
 * splice list.
 */
export function editedLineRanges(content: string, splices: EditSplice[], slack = 1): Array<[number, number]> {
  if (splices.length === 0) return [];
  const starts = lineStarts(content);
  const raw: Array<[number, number]> = [];
  for (let i = 0; i < splices.length; i++) {
    const s = splices[i];
    const a = forwardThrough(splices, i, s.start);
    // The span's terminal is the END OF THE INSERTED TEXT, not the old span
    // end: an insertion longer than what it replaced must attribute its
    // later inserted lines, and a deletion must not reach into the lines
    // that slid up to fill the gap. forwardThrough starts after this
    // splice, so the local inserted end (s.start + s.insertLen) is the
    // pre-forwarding terminal.
    const b = forwardThrough(splices, i, s.start + s.insertLen);
    const first = lineOf(starts, a);
    const last = lineOf(starts, Math.max(a, b - 1));
    raw.push([Math.max(1, first - slack), Math.min(starts.length, last + slack)]);
  }
  raw.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Warning text
// ---------------------------------------------------------------------------

/**
 * Render the warning block, or null when there is nothing to report. Kept to
 * a handful of one-line diagnostics so a mangled file cannot flood context.
 */
export function formatSyntaxWarning(path: string, diagnostics: SyntaxDiagnostic[], truncated = false): string | null {
  if (diagnostics.length === 0) return null;
  const shown = diagnostics.slice(0, MAX_SHOWN_DIAGS).map((d) => `  ${path}:${d.row + 1}:${d.column + 1}: ${d.detail}`);
  const more = diagnostics.length - shown.length;
  const lines = [
    ...shown,
    ...(more > 0 ? [`  …and ${more} more`] : []),
    ...(truncated ? ["  …(diagnostic collection capped)"] : []),
  ];
  return `warning: the edit may have introduced syntax errors (tree-sitter). Re-read the flagged lines and repair them:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// The real loader (native prebuilds, lazy, cached, fail-open)
// ---------------------------------------------------------------------------

/**
 * Skip the check above this size: error recovery is the slow path (~6× the
 * clean parse per the header measurement), and this bound keeps the
 * worst-case synchronous stall small (~150 ms). Files above it are typically
 * generated; they simply lose the advisory check — fail-open.
 */
const MAX_SYNTAX_BYTES = 512_000;

interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(source: string): unknown;
}

/** Import the grammar module for a language name; throws for unknown names. */
async function importGrammar(language: string): Promise<unknown> {
  switch (language) {
    case "javascript":
      return (await import("tree-sitter-javascript")).default;
    case "typescript":
      return (await import("tree-sitter-typescript")).default.typescript;
    case "tsx":
      return (await import("tree-sitter-typescript")).default.tsx;
    case "python":
      return (await import("tree-sitter-python")).default;
    case "json":
      return (await import("tree-sitter-json")).default;
    case "go":
      return (await import("tree-sitter-go")).default;
    case "rust":
      return (await import("tree-sitter-rust")).default;
    default:
      throw new Error(`No grammar configured for ${language}`);
  }
}

/**
 * The production loader: dynamic-imports the core and per-language grammar
 * on first use (a ~1 ms cold load), caches one parser per language, and
 * returns null on any failure — missing deps after vendoring, incompatible
 * ABI, anything. Load failures are NOT cached — a transient EMFILE or an
 * in-flight prebuild extraction self-heals on the next edit — and the first
 * failure per language leaves one breadcrumb, so "checker dead" is
 * distinguishable from an intentional PI_SUPEREDIT_SYNTAX=0. The `as unknown
 * as` casts are the honest boundary: the ambient grammar declarations only
 * say "object", and Node's CJS-ESM interop puts module.exports on `.default`.
 */
export function createRealSyntaxLoader(): SyntaxLoader {
  const cache = new Map<string, SyntaxLanguage>();
  const complained = new Set<string>();
  return async (language) => {
    const cached = cache.get(language);
    if (cached !== undefined) return cached;
    try {
      const core = (await import("tree-sitter")) as unknown as { default: new () => TreeSitterParser };
      const parser = new core.default();
      parser.setLanguage(await importGrammar(language));
      const result: SyntaxLanguage = { parse: (source) => parser.parse(source) as SyntaxTree };
      cache.set(language, result);
      return result;
    } catch (error) {
      if (!complained.has(language)) {
        complained.add(language);
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`superedit syntax check unavailable for ${language}: ${detail}`);
      }
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Orchestration — what the tool calls after the write commits
// ---------------------------------------------------------------------------

/**
 * Run the post-edit check and return the warning text, or null. Never
 * throws: every failure mode skips the check (fail-open by contract — the
 * edit has already landed). `cancelled` is polled between the grammar load
 * and the parse so a caller that stopped waiting (budget/abort race lost)
 * does not still run the synchronous parse later for a discarded result.
 */
export async function runSyntaxCheck(opts: {
  path: string;
  content: string;
  splices: EditSplice[];
  loader: SyntaxLoader;
  enabled: boolean;
  cancelled?: () => boolean;
}): Promise<string | null> {
  if (!opts.enabled) return null;
  const language = languageNameForPath(opts.path);
  // Byte bound, not code units: a non-ASCII source can carry several bytes
  // per character, and this guard exists to cap worst-case parse latency.
  if (language === null || Buffer.byteLength(opts.content, "utf8") > MAX_SYNTAX_BYTES) return null;
  try {
    const grammar = await opts.loader(language);
    if (!grammar || opts.cancelled?.()) return null;
    const tree = grammar.parse(opts.content);
    if (!tree.rootNode.hasError) return null;
    const exact = editedLineRanges(opts.content, opts.splices, 0);
    if (exact.length === 0) return null;
    // ±1 line of slack applies to MISSING tokens only: they are zero-width
    // and often sit just past the replacement. An ERROR node starts inside
    // the rewritten text, so widening for it would blame a pre-existing
    // error on the adjacent line for an edit that introduced nothing.
    const widened = editedLineRanges(opts.content, opts.splices);
    // Filter inside collection, not after: with a post-filter, ~50
    // pre-existing errors before the edited region would exhaust the cap
    // and hide the error the edit actually introduced.
    const mine = (row: number, kind: "error" | "missing") =>
      (kind === "missing" ? widened : exact).some(([a, b]) => row + 1 >= a && row + 1 <= b);
    const { diagnostics, truncated } = collectSyntaxDiagnostics(tree, opts.content, mine);
    return formatSyntaxWarning(opts.path, diagnostics, truncated);
  } catch {
    return null;
  }
}
