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
 *   cap at 50 with early exit, and the walk itself caps at 5_000 visited
 *   diagnostics so a pre-broken file whose errors are all filtered out
 *   cannot drag the advisory check past its bounds. The differential
 *   (pre-existing-damage suppression) needs BOTH parses and gates on the
 *   SUM — above ~512 KB combined (one MAX_SYNTAX_BYTES) it is skipped
 *   while the check still runs: surfacing a mangled edit outranks
 *   attribution at that size, which can produce an undifferentiated
 *   (blame-shifted) warning
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
 * Position handling: tree-sitter 0.25's native binding reports rows and
 * columns in UTF-16 code units (verified empirically: a 2-byte é shifts a
 * reported column by 1, not 2) — the same coordinates as JS string
 * indexing, so rows/columns/splice offsets are used verbatim, no
 * conversion anywhere. Excerpts quote the right text and printed columns
 * match what a re-reading model sees.
 */

/** PI_SUPEREDIT_SYNTAX=0|false (or off/no) disables the post-edit syntax check. */
export function parseSyntaxEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["PI_SUPEREDIT_SYNTAX"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
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
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  css: "css",
};

/** Grammar name for a path's extension, or null when the check does not apply. */
export function languageNameForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  const ext = path.slice(dot + 1).toLowerCase();
  // hasOwn, not plain indexing: `path` is model-supplied, and extensions
  // like "constructor" or "toString" would otherwise inherit a function
  // off Object.prototype and flow into the loader as a bogus language.
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : null;
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
// Walk ceilings. Diagnostics are the expensive visits (detail formatting);
// plain nodes inside a pre-broken ERROR subtree cost only a pop, so their
// ceiling is higher but still absolute — a wide ERROR node swallowing most
// of a 512 KB file must not make the walk unbounded. Both are high enough
// that a pre-existing cluster above the edited lines cannot starve the
// walk before it reaches them (the silence direction).
const MAX_WALK_VISITS = 5_000;
const MAX_WALK_NODES = 50_000;
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
 * `keep(startRow, endRow, kind)` filters (and counts against the kept
 * cap) — the span end lets callers attribute multi-line ERROR nodes by
 * ANY line they cover (recovery can start an ERROR far before the actual
 * damage), while zero-width nodes (MISSING) keep start-line-only
 * semantics. Filtering DURING the walk, not after, is what keeps a kept
 * cap meaningful: pre-existing errors earlier in the file cannot consume
 * the cap before the walk reaches the lines the edit rewrote — a
 * half-mangled file with 60 old errors must not hide the one error the
 * edit introduced. `detail` is formatted only for kept diagnostics (it
 * splits the source; formatting it for filtered ones would be the
 * expensive part of walking a pre-broken file), and a separate visited
 * cap bounds the walk itself for the case where nothing is kept at all.
 */
export function collectSyntaxDiagnostics(
  tree: SyntaxTree,
  source: string,
  keep?: (startRow: number, endRow: number, kind: "error" | "missing") => boolean,
  maxDiags: number = MAX_COLLECTED_DIAGS,
): { diagnostics: SyntaxDiagnostic[]; truncated: boolean; reachedRow: number } {
  const lines = source.split("\n"); // once — never re-split per diagnostic
  const out: SyntaxDiagnostic[] = [];
  let visited = 0;
  let walked = 0;
  // Document frontier of the walk (highest row popped so far). The walk
  // is document-ordered, so everything at or before this row was visited:
  // a caller can tell a cap that fired BEFORE the edited lines (their
  // damage was never seen) from one that fired later, in unrelated damage.
  let reachedRow = -1;
  const stack: Array<{ node: SyntaxNode; inError: boolean; root: boolean }> = [
    { node: tree.rootNode, inError: false, root: true },
  ];
  while (stack.length > 0) {
    const { node, inError, root } = stack.pop()!;
    const nodeRow = node.startPosition.row;
    if (nodeRow > reachedRow) reachedRow = nodeRow;
    if (++walked > MAX_WALK_NODES) return { diagnostics: out.sort(byPosition), truncated: true, reachedRow };
    // ERROR-inside-ERROR stays sub-noise, but a childless NON-ERROR node
    // carrying hasError is damage the binding cannot enumerate: some
    // grammars (tree-sitter-css's `color: ;` → integer_value) hide a
    // MISSING token that appears in toString but is never yielded by
    // child(). The leaf itself is the only visible witness, so report it
    // with the MISSING kind: the damage is zero-width (the absent token
    // had no extent), and zero-width diagnostics get the ±1-line widened
    // attribution scope — a hidden leaf sits at the missing token's
    // insertion point, which for a deletion at the end of a run is often
    // the line after the splice's terminal, and exact-scope would drop it
    // exactly there. Its detail distinguishes it from token reports. Not
    // under a visible ERROR ancestor (inError): there the outer node
    // already anchors the region. Not the root either: a childless
    // hasError root is the whole-file shape (empty or all-garbage), and
    // `error inside "program"` at line 1 would be pure noise — the
    // visible ERROR/MISSING children carry whatever is reportable.
    const hiddenLeaf =
      !root && node.type !== "ERROR" && !inError && node.hasError && node.childCount === 0 && !node.isMissing;
    const kind: SyntaxDiagnostic["kind"] | null =
      node.type === "ERROR" && !inError ? "error" : node.isMissing || hiddenLeaf ? "missing" : null;
    if (kind !== null) {
      visited++;
      const row = node.startPosition.row;
      // tree-sitter endPosition is EXCLUSIVE: an end at [R, 0] stops at the
      // line boundary and covers nothing on line R+1 (editedLineRanges
      // encodes the same convention for its terminals). The keep predicate
      // receives this inclusive last-covered row so a boundary-ended node
      // cannot claim the next line.
      const lastRow =
        node.endPosition.row > row && node.endPosition.column === 0 ? node.endPosition.row - 1 : node.endPosition.row;
      const kept = !keep || keep(row, lastRow, kind);
      if (kept && out.length < maxDiags) {
        out.push({
          kind,
          row,
          // tree-sitter 0.25 native columns are UTF-16 code units (see
          // EditSplice) — exactly what printing and slicing want. Clamped
          // to the line's text length so every consumer — excerpt, offset
          // identity, printed location — sees the same normalized value
          // (ERROR recovery routinely reports columns past the line end,
          // and a printed column that does not exist misdirects a
          // re-reading model; the differential's compare-time clamps are
          // idempotent under this).
          column: Math.min(node.startPosition.column, lines[row]?.length ?? 0),
          detail: hiddenLeaf
            ? `error inside "${node.type}"`
            : kind === "missing"
              ? `missing "${node.type}"`
              : errorDetail(node, lines),
        });
      } else if (kept) {
        // A kept diagnostic exists past the cap — the list really is
        // truncated. Exactly-at-cap files report truncated: false instead.
        return { diagnostics: out.sort(byPosition), truncated: true, reachedRow };
      }
      // Nothing-kept files would otherwise walk and count unbounded. Strict
      // >, not >=: visiting exactly the cap is complete, not truncated — the
      // first visit past MAX_WALK_VISITS is what gets dropped, and only then
      // do we claim it.
      if (visited > MAX_WALK_VISITS) {
        return { diagnostics: out.sort(byPosition), truncated: true, reachedRow };
      }
    }
    if (!node.hasError) continue; // clean subtree
    const childInError = inError || node.type === "ERROR";
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, inError: childInError, root: false });
    }
  }
  return { diagnostics: out.sort(byPosition), truncated: false, reachedRow };
}

function byPosition(a: SyntaxDiagnostic, b: SyntaxDiagnostic): number {
  return a.row - b.row || a.column - b.column;
}

function errorDetail(node: SyntaxNode, lines: string[]): string {
  // Index the split lines by row, never the raw string by byte index, and
  // clamp at the line end: columns past it (a common ERROR-recovery shape)
  // must yield an empty excerpt, not a slice from the next line.
  const line = lines[node.startPosition.row] ?? "";
  const start = Math.min(node.startPosition.column, line.length);
  const excerpt = line.slice(start, start + MAX_EXCERPT_CHARS);
  let detail = `unexpected ${JSON.stringify(excerpt)}`;
  // endPosition rows are exclusive: an end at [R, 0] stops before line
  // R+1. Print the inclusive last covered line (same rule as
  // collectSyntaxDiagnostics) — the range is the model's only repair
  // hint, and overshooting sends it to a line the node never touched.
  const lastRow =
    node.endPosition.row > node.startPosition.row && node.endPosition.column === 0
      ? node.endPosition.row - 1
      : node.endPosition.row;
  if (lastRow > node.startPosition.row + 2) {
    detail += ` (spans lines ${node.startPosition.row + 1}–${lastRow + 1})`;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Edited line ranges (splice positions → final-content line numbers)
// ---------------------------------------------------------------------------

/**
 * One replacement applied in memory: a UTF-16 code-unit span at application
 * time (JS string offsets from indexOf matching). tree-sitter 0.25's native
 * binding also reports columns in UTF-16 code units (verified empirically:
 * a 2-byte é shifts the reported column by 1, not 2), so columns and splice
 * offsets are directly comparable — no conversion anywhere in this module.
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

/**
 * Map a position recorded when splice `after` applied back through every
 * earlier splice, yielding pre-edit (original-file) coordinates — the exact
 * inverse of forwardThrough: positions inside an earlier insertion clamp
 * into that splice's old span, preserving distance from the end.
 */
function backwardThrough(splices: EditSplice[], before: number, p: number): number {
  for (let j = before - 1; j >= 0; j--) {
    const s = splices[j];
    if (p < s.start) continue;
    if (p >= s.start + s.insertLen) {
      p += s.end - s.start - s.insertLen;
      continue;
    }
    // p === s.start is the BEFORE-edge of the splice (forwardThrough maps
    // it to itself), so only strictly-inside positions clamp into the old
    // span — preserving distance from the end keeps the mapping monotone.
    if (p === s.start) continue;
    p = Math.max(s.start, s.end - (s.start + s.insertLen - p));
  }
  return p;
}

/**
 * Map a FINAL-content offset back to its pre-edit (original-file) offset
 * by inverting every splice in reverse application order. Positions past a
 * splice shift by its delta; anything inside a splice's inserted text has
 * no pre-image (-1): inserted text is new, and no prior diagnostic may
 * speak for it. The BEFORE-EDGE (the first position, which is also where
 * the old span began) keeps its pre-image — see the inline rationale.
 */
function toPreOffset(splices: EditSplice[], p: number): number {
  for (let j = splices.length - 1; j >= 0; j--) {
    const s = splices[j];
    if (p < s.start) continue;
    if (p >= s.start + s.insertLen) {
      p += s.end - s.start - s.insertLen;
      continue;
    }
    // Everything strictly inside a splice's inserted text is new — no
    // pre-image. The BEFORE-EDGE (p === s.start) is the exception, but
    // ONLY for splices that replaced existing text: it is also the first
    // position of the old span, and statement-level MISSING damage
    // reports exactly there — a same-length rewrite of a damaged line
    // must still recognize its own pre-existing damage (the 50+
    // diagnostics test is that shape). A PURE INSERTION (s.end ===
    // s.start) replaced nothing, so its first position is as new as the
    // rest and gets no pre-image. Definitive either way: earlier splices
    // cannot restore a pre-image.
    if (p > s.start || s.end === s.start) return -1;
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
 * Per-splice PRE-EDIT line ranges, for scoping the prior collection to
 * the lines the edit family touched. Splice i's offsets live in the
 * content after edits 0..i-1, so the pre side inverse-maps through the
 * earlier splices. The union of these ranges is what the caller uses;
 * which splice a line came from does not matter, because the suppression
 * decision itself is offset-exact (see runSyntaxCheck).
 */
function pairedSpliceRanges(previous: string, splices: EditSplice[]): Array<{ pre: [number, number] }> {
  if (splices.length === 0) return [];
  const preStarts = lineStarts(previous);
  return splices.map((s, i) => {
    const pa = backwardThrough(splices, i, s.start);
    const pb = backwardThrough(splices, i, s.end);
    return {
      // The upper bound includes the line AT pb: a whole-line edit's old
      // span ends exactly at the next line's start, and a post diagnostic
      // mapping back to that offset must find its prior candidate there.
      pre: [lineOf(preStarts, pa), lineOf(preStarts, Math.max(pa, pb))],
    };
  });
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
// Ceiling on the splice lists this module will build offset maps from:
// every consumer (editedLineRanges, pairedSpliceRanges, the pre/post
// inversion) is quadratic in the list length. The producer (applyEdits)
// caps its own output at the same number; this bound guards the exported
// runSyntaxCheck against callers that are not the producer.
export const MAX_TOTAL_SPLICES = 512;

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
    // YAML: the npm "tree-sitter-yaml" name is a 2023 ABI-13 build that
    // core 0.25 rejects; the tree-sitter-grammars fork ships ABI-14 prebuilds.
    case "yaml":
      return (await import("@tree-sitter-grammars/tree-sitter-yaml")).default;
    // HTML/CSS bindings predate the "module.exports = Language" convention:
    // they export { language, nodeTypeInfo }, and core 0.25 needs the whole
    // object — passing just .language crashes node-class lookup on walk.
    case "html":
      return (await import("tree-sitter-html")).default;
    case "css":
      return (await import("tree-sitter-css")).default;
    default:
      throw new Error(`No grammar configured for ${language}`);
  }
}

/**
 * The production loader: dynamic-imports the core and per-language grammar
 * on first use (a ~1 ms cold load), caches one parser per language, and
 * returns null on any failure — missing deps after vendoring, incompatible
 * ABI, anything. Load failures are retried, never cached: without a
 * cooldown, a failing import costs one throw per edit and a HANGING one
 * (NFS home, stuck prebuild) costs the caller's full 5 s budget on every
 * single edit, all session. So each failed attempt parks its language for
 * LOAD_RETRY_MS, and an attempt still pending after PENDING_PARK_MS is
 * presumed hung and parked too — a hang costs one stall per edit inside
 * the (budget-sized) window plus the parking edit's one fresh attempt,
 * then every call fails open instantly for the cooldown — and each
 * failure mode leaves one breadcrumb per language, so "checker dead" is
 * distinguishable from an intentional PI_SUPEREDIT_SYNTAX=0. Settled
 * (thrown) failures are NOT parked — they retry on the next edit, since
 * their common causes are transient. The
 * `as unknown as` casts are the honest boundary: the ambient grammar
 * declarations only say "object", and Node's CJS-ESM interop puts
 * module.exports on `.default`.
 */
const LOAD_RETRY_MS = 60_000;
// An in-flight import older than this is presumed hung (healthy grammar
// loads take ~1 ms; the caller-side budget is 5 s) — sharing it further
// would burn that budget on every edit, so it gets parked like a failure.
// Aligned with the caller budget: an import that has outlived one full
// budget has already cost some edit its whole stall. Realistic cost of a
// hang: one stall per edit arriving inside the window (usually one —
// edits are spaced by tool-call latency), plus the parking edit's single
// fresh attempt; after that every call fails open instantly for the
// cooldown. A legitimately slow import that settles between one and two
// budgets old is the accepted loss — healthy loads are ~1 ms, not 5 s.
export const PENDING_PARK_MS = 5_000;

interface InflightAttempt {
  startedAt: number;
  promise: Promise<SyntaxLanguage | null>;
  /**
   * Resolves the EXPOSED promise as null. A hung import never settles, so
   * parking must release the old attempt's awaiters itself — each holds an
   * edit's content — instead of pinning them (and it) for the process
   * lifetime. Null, not a rejection: every awaiter fails open the same way
   * the settled-failure path does, with no unhandled-rejection surface.
   */
  abandon: () => void;
}

export function createRealSyntaxLoader(
  deps: {
    importCore?: () => Promise<{ default: new () => TreeSitterParser }>;
    importGrammar?: typeof importGrammar;
    now?: () => number;
  } = {},
): SyntaxLoader {
  const importCore =
    deps.importCore ?? (() => import("tree-sitter") as unknown as Promise<{ default: new () => TreeSitterParser }>);
  const loadGrammar = deps.importGrammar ?? importGrammar;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, SyntaxLanguage>();
  const complained = new Set<string>();
  const parkedUntil = new Map<string, number>(); // language → retry-not-before (parked hangs; settled failures retry next edit)
  const inflight = new Map<string, InflightAttempt>();
  // Park-and-release a pending attempt: shared by the caller that finds it
  // stale and the abandon timer, so both paths behave identically.
  const park = (language: string, attempt: InflightAttempt): void => {
    parkedUntil.set(language, now() + LOAD_RETRY_MS);
    if (inflight.get(language) === attempt) inflight.delete(language);
    attempt.abandon();
    if (!complained.has(`pending:${language}`)) {
      complained.add(`pending:${language}`);
      console.error(
        `superedit syntax check: grammar load for ${language} still pending after ${PENDING_PARK_MS / 1000}s — parking it`,
      );
    }
  };
  return async (language) => {
    const cached = cache.get(language);
    if (cached !== undefined) return cached;
    const parked = parkedUntil.get(language);
    if (parked !== undefined && now() < parked) return null;
    const existing = inflight.get(language);
    if (existing !== undefined) {
      if (now() - existing.startedAt < PENDING_PARK_MS) {
        // A concurrent edit shares the in-flight load instead of stacking a
        // second import; each caller's own budget race bounds its wait.
        return existing.promise;
      }
      // Pending past PENDING_PARK_MS and still unsettled: a hung import
      // (NFS home, stuck prebuild). It never rejects, so it can never reach
      // the catch below — park it here so later edits fail open instantly
      // instead of burning their budget on the same dead promise (only the
      // caller that hit this branch funds the one fresh attempt per
      // window), and release the dead attempt's awaiters. Breadcrumb once,
      // or the hang is invisible.
      park(language, existing);
    }
    const attempt: InflightAttempt = { startedAt: now(), promise: null!, abandon: null! };
    // Register before starting the attempt: a synchronously-throwing import
    // (only possible with an injected fake — dynamic imports return
    // promises) must find itself registered so the finally clears only its
    // own marker and the catch breadcrumbs once instead of silently
    // bypassing both. (Settled failures do not park — see the catch.)
    inflight.set(language, attempt);
    // Abandon timer: a follow-up loader call is what normally notices a
    // hung import, but if none comes the awaiters (each holding an edit's
    // content) stay pinned until process end — so every attempt also parks
    // itself on the clock. unref'd: an advisory check must never hold the
    // process open; cleared on settle in the attempt's finally.
    const parkTimer = setTimeout(() => {
      if (inflight.get(language) === attempt) park(language, attempt);
    }, PENDING_PARK_MS);
    parkTimer.unref?.();
    const runAttempt = async (): Promise<SyntaxLanguage | null> => {
      try {
        const core = await importCore();
        const parser = new core.default();
        parser.setLanguage(await loadGrammar(language));
        const result: SyntaxLanguage = { parse: (source) => parser.parse(source) as SyntaxTree };
        cache.set(language, result);
        return result;
      } catch (error) {
        // Settled failures do NOT park: transient causes (EMFILE under
        // parallel workers, a prebuild extraction still in flight, a brief
        // mount hiccup) self-heal on the next edit, and a rejected import
        // is cheap — the cooldown is for imports that never settle (the
        // PENDING_PARK machinery above). The once-per-language breadcrumb
        // below is the operator signal; the check fails open either way.
        if (!complained.has(`failed:${language}`)) {
          complained.add(`failed:${language}`);
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`superedit syntax check unavailable for ${language}: ${detail}`);
        }
        return null;
      } finally {
        clearTimeout(parkTimer);
        // Only the registered attempt may clear its marker — a stale attempt
        // settling late must not un-park a newer one.
        if (inflight.get(language) === attempt) inflight.delete(language);
      }
    };
    // The exposed promise wraps the attempt so parking can settle it as
    // null without the (possibly hung) import's cooperation: awaiters each
    // hold an edit's content, and a never-settling import would pin them
    // for the process lifetime. A late real settle after abandonment is
    // dropped here but still lands in the cache, where the next call finds
    // it before the parked check.
    attempt.promise = new Promise<SyntaxLanguage | null>((resolve) => {
      attempt.abandon = () => resolve(null);
      void runAttempt().then(resolve, resolve.bind(null, null));
    });
    return attempt.promise;
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
  /** Pre-edit content for the differential pass; optional, callers without it skip the refinement. */
  previous?: string;
  splices: EditSplice[];
  /**
   * Whole replaced ranges for line ATTRIBUTION, in the same per-frame
   * convention as `splices`. When omitted, `splices` doubles for it.
   * The two serve different masters: attribution wants the whole match
   * (damage can surface on byte-identical lines inside a rewritten
   * block), while the differential wants the minimal changed runs
   * (unchanged bytes keep their pre-image). Callers that record minimal
   * runs in `splices` pass the whole-match list here.
   */
  edited?: EditSplice[];
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
    // Boundary guard: the maps below are quadratic in the splice lists, and
    // this entry point is exported — a caller that is not applyEdits is not
    // bound by the producer-side cap. Past it, attribution and the
    // differential give way to the whole-file scope: every diagnostic is
    // reported (maximally conservative — nothing suppressed) at linear
    // cost, instead of seconds of blocked event loop on unbounded input.
    if (opts.splices.length > MAX_TOTAL_SPLICES || (opts.edited ?? opts.splices).length > MAX_TOTAL_SPLICES) {
      const all = collectSyntaxDiagnostics(tree, opts.content);
      return formatSyntaxWarning(opts.path, all.diagnostics, all.truncated);
    }
    const exact = editedLineRanges(opts.content, opts.edited ?? opts.splices, 0);
    if (exact.length === 0) return null;
    // ±1 line of slack applies to MISSING tokens only: they are zero-width
    // and often sit just past the replacement. An ERROR node starts inside
    // the rewritten text, so widening for it would blame a pre-existing
    // error on the adjacent line for an edit that introduced nothing. The
    // scope is the same whole replaced span as ERROR attribution (`edited`):
    // a MISSING at a statement anchor can sit on a byte-identical line deep
    // inside a rewritten block — scoping it to the minimal changed runs
    // would drop such damage at collection and report a broken edit clean.
    const widened = editedLineRanges(opts.content, opts.edited ?? opts.splices);
    // Filter inside collection, not after: with a post-filter, ~50
    // pre-existing errors before the edited region would exhaust the cap
    // and hide the error the edit actually introduced. Span-intersection
    // for ERROR kinds: recovery routinely starts an ERROR node on a line
    // BEFORE the damage (yaml's `b: [unclosed` reports at the block's
    // first line) — attribution must keep a node whose span covers an
    // edited line even when its start line is not one. MISSING tokens are
    // zero-width, so the same formula degenerates to start-line-only.
    const mine = (startRow: number, endRow: number, kind: "error" | "missing") =>
      (kind === "missing" ? widened : exact).some(([a, b]) => endRow + 1 >= a && startRow + 1 <= b);
    const { diagnostics, truncated, reachedRow } = collectSyntaxDiagnostics(tree, opts.content, mine);
    if (diagnostics.length === 0) {
      // A capped walk that did not get PAST the edited scope is not a
      // clean bill of health — say so, or the silence would be
      // indistinguishable from a clean parse and hide exactly the
      // wide-mangled-file damage the check exists to surface. The gate is
      // deliberately conservative in the warn direction: `widened` is
      // 1-based and includes the ±1 MISSING slack while `reachedRow` is a
      // 0-based frontier, so a cap firing ON — or one row short of — the
      // last in-scope line still warns. The alternative (silence unless
      // the region is entirely beyond the frontier) would drop partially
      // walked lines, and a cap that fires mid-line has not seen that
      // line's deeper diagnostics. A cap that fired further down, in
      // unrelated pre-existing damage, clears the gate and stays silent.
      return truncated && widened.some(([, b]) => b > reachedRow)
        ? `warning: the syntax check's diagnostic walk capped before clearing the edited lines of ${opts.path} — re-read the changed region.`
        : null;
    }
    // Differential vs the pre-edit content: suppress diagnostics that
    // already existed before the edit. The line filter above cannot help
    // when the pre-existing damage sits ON an edited line — the canonical
    // case is JSONC (tsconfig.json): a `// comment` or trailing comma on the
    // edited line is a strict-JSON ERROR the edit did not introduce, and
    // warning on it would send the model to delete valid config.
    // Identity is OFFSET-EXACT: the post-edit diagnostic's line+column is
    // one code-unit offset in the final content; inverting the splices maps
    // it to the pre-edit offset it came from, and only a prior diagnostic
    // at that exact offset — same kind — is the same damage. No covering
    // check is needed on top: `mine` already kept only diagnostics near an
    // edit, and kind + exact offset cannot coincide across different
    // damage — this also covers MISSING tokens reported one line past their
    // home (kept by the ±1 slack, suppressed when their offset maps onto a
    // prior). Offsets inside inserted text have no pre-image — an edit owns
    // the text it inserted. Both sides' collections must be complete: a
    // truncated walk means partial data, and suppressing on partial data
    // could hide real new damage — so any truncation disables the
    // refinement. Runs only on the about-to-warn path (and never once the
    // caller stopped waiting): clean edits pay one parse, never two, and an
    // oversize `previous` skips the refinement.
    if (opts.previous !== undefined && opts.previous !== opts.content && !truncated) {
      try {
        // Combined budget: the post-edit parse already ran, so a second
        // ~512 KB parse would double the documented worst-case stall. The
        // guard is on content + previous together, keeping the total
        // synchronous parse work near one file cap.
        if (
          Buffer.byteLength(opts.content, "utf8") + Buffer.byteLength(opts.previous, "utf8") <= MAX_SYNTAX_BYTES &&
          !opts.cancelled?.()
        ) {
          const before = grammar.parse(opts.previous);
          if (before.rootNode.hasError) {
            // The prior scope must mirror ATTRIBUTION, not the minimal
            // runs: post diagnostics are kept from the whole replaced
            // range (`edited`), so pre-existing damage on an unchanged
            // line inside that range needs its prior collected or it
            // would be re-reported as new. Suppression stays offset-exact
            // against the minimal `splices`, so the wider scope only adds
            // candidates that can never coincide with fresh text.
            const pairs = pairedSpliceRanges(opts.previous, opts.edited ?? opts.splices);
            const postStarts = lineStarts(opts.content);
            const preStarts = lineStarts(opts.previous);
            // Merge the per-splice pre ranges (and a MISSING-widened copy —
            // the same ±1 slack the attribution filter gives MISSING tokens,
            // whose home line is one past where they report) so the prior
            // walk's keep predicate checks a handful of merged intervals
            // instead of every splice per visit. Scope still matters: a
            // rewritten block can hold hundreds of pre-existing diagnostics,
            // and dropping the one being diffed against would blame the edit
            // for damage it did not introduce.
            const merged = (widen: number): Array<[number, number]> => {
              const sorted = [...pairs]
                .map((c) => [c.pre[0] - widen, c.pre[1] + widen] as [number, number])
                .sort((x, y) => x[0] - y[0]);
              const out: Array<[number, number]> = [];
              for (const r of sorted) {
                const last = out[out.length - 1];
                if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
                else out.push([r[0], r[1]]);
              }
              return out;
            };
            const errorScope = merged(0);
            const missingScope = merged(1);
            const inScope = (startRow: number, endRow: number, kind: "error" | "missing"): boolean =>
              (kind === "missing" ? missingScope : errorScope).some(([a, b]) => endRow + 1 >= a && startRow + 1 <= b);
            const prior = collectSyntaxDiagnostics(before, opts.previous, inScope, MAX_WALK_VISITS);
            if (!prior.truncated) {
              // Precompute the insertion before-edges once: forwarding every
              // splice start is O(splices²), and occurrence:"all" edits can
              // push close to a thousand splices — per-diagnostic recomputes
              // would dominate the filter.
              const insertedStarts = new Set(
                opts.splices.flatMap((s, i) => (s.insertLen > 0 ? [forwardThrough(opts.splices, i, s.start)] : [])),
              );
              // Precompute the prior side's offsets with the SAME
              // end-of-line clamp the post side applies: past-EOL recovery
              // columns are as common before the edit as after, and an
              // unclamped prior offset spills into the next line — unable
              // to equal its own clamped pre-image (false blame) yet able
              // to collide with that line's real damage (false silence).
              const priorOffsets = prior.diagnostics.map((p) => {
                const start = preStarts[p.row] ?? 0;
                const next = preStarts[p.row + 1];
                const len = (next === undefined ? opts.previous!.length : next - 1) - start;
                return { kind: p.kind, offset: start + Math.min(p.column, len) };
              });
              let cancelledMidFilter = false;
              const fresh = diagnostics.filter((d) => {
                if (opts.cancelled?.()) {
                  cancelledMidFilter = true;
                  return true;
                }
                // Columns past end-of-line are a common ERROR-recovery
                // shape (see errorDetail): clamp to the line's text end —
                // newline excluded, matching errorDetail — before inverting,
                // or the offset spills into the next line's first character
                // and could suppress — or fabricate — a pre-image there.
                const lineStart = postStarts[d.row] ?? 0;
                const next = postStarts[d.row + 1];
                const lineLen = (next === undefined ? opts.content.length : next - 1) - lineStart;
                const at = lineStart + Math.min(d.column, lineLen);
                const origin = toPreOffset(opts.splices, at);
                if (origin < 0) return true; // inside an insertion: no pre-image, never suppressible
                // The BEFORE-EDGE of an insertion is ambiguous (it is also
                // the old span's first position): only MISSING damage may
                // claim it — MISSING reports at statement anchors, while an
                // ERROR at the first character of fresh text is new damage
                // in text the edit just wrote.
                if (d.kind === "error" && insertedStarts.has(at)) return true;
                return !priorOffsets.some((p) => p.kind === d.kind && p.offset === origin);
              });
              // Suppression on partial filtering could hide real damage:
              // fall through to the undifferentiated warning instead.
              if (!cancelledMidFilter) return formatSyntaxWarning(opts.path, fresh, truncated);
            }
            // prior collection truncated: fall through undifferentiated
          }
        }
      } catch {
        // fail-open: fall through to the undifferentiated warning
      }
    }
    return formatSyntaxWarning(opts.path, diagnostics, truncated);
  } catch {
    return null;
  }
}
