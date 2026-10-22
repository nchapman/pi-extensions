import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, createSuperEditTool } from "../lib/superedit";
import supereditExtension from "../extensions/superedit";
import {
  collectSyntaxDiagnostics,
  createRealSyntaxLoader,
  editedLineRanges,
  formatSyntaxWarning,
  languageNameForPath,
  parseSyntaxEnabled,
  PENDING_PARK_MS,
  runSyntaxCheck,
  type SyntaxDiagnostic,
  type SyntaxLanguage,
  type SyntaxLoader,
  type SyntaxNode,
  type SyntaxTree,
} from "../lib/superedit-syntax";

// ---------------------------------------------------------------------------
// Fake trees (the house pattern: the boundary is injected, never the real parser)
// ---------------------------------------------------------------------------

interface Spec {
  type?: string;
  isMissing?: boolean;
  hasError?: boolean;
  /** [row, column, byte index]; the start defaults to the end and vice versa. */
  start?: [number, number, number];
  end?: [number, number, number];
  children?: Spec[];
}

function realize(spec: Spec): SyntaxNode {
  const start = spec.start ?? spec.end ?? [0, 0, 0];
  const end = spec.end ?? spec.start ?? [0, 0, 0];
  const children = (spec.children ?? []).map(realize);
  return {
    type: spec.type ?? "node",
    isMissing: spec.isMissing ?? false,
    hasError: spec.hasError ?? false,
    startIndex: start[2],
    endIndex: end[2],
    startPosition: { row: start[0], column: start[1] },
    endPosition: { row: end[0], column: end[1] },
    childCount: children.length,
    child: (i: number) => children[i] ?? null,
  };
}

function fakeTree(spec: Spec): SyntaxTree {
  return { rootNode: realize(spec) };
}

/** A language whose parse result is fixed per test. */
const fixedLanguage = (tree: SyntaxTree): SyntaxLanguage => ({ parse: () => tree });

const ERROR_NODE = (row: number, column = 0, source = ""): Spec => ({
  type: "ERROR",
  hasError: true,
  start: [row, column, offsetOf(source, row, column)],
  end: [row, column + 2, offsetOf(source, row, column) + 2],
  children: [],
});

const MISSING_NODE = (row: number, token: string): Spec => ({
  type: token,
  isMissing: true,
  hasError: true,
  start: [row, 0, 0],
  end: [row, 0, 0],
  children: [],
});

function offsetOf(source: string, row: number, column: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < row; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset + column;
}

// ---------------------------------------------------------------------------
// Knobs and mapping
// ---------------------------------------------------------------------------

describe("parseSyntaxEnabled", () => {
  it("defaults to enabled", () => {
    expect(parseSyntaxEnabled({})).toBe(true);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "" })).toBe(true);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "1" })).toBe(true);
  });
  it("0/false (and off/no, with surrounding whitespace) disable", () => {
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "0" })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "FALSE" })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "off" })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "no" })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: " 0 " })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: " Off\n" })).toBe(false);
  });
});

describe("languageNameForPath", () => {
  it("maps known extensions case-insensitively", () => {
    expect(languageNameForPath("a.ts")).toBe("typescript");
    expect(languageNameForPath("a.TSX")).toBe("tsx");
    expect(languageNameForPath("b.mjs")).toBe("javascript");
    expect(languageNameForPath("c.PY")).toBe("python");
    expect(languageNameForPath("d.pyi")).toBe("python");
    expect(languageNameForPath("e.json")).toBe("json");
    expect(languageNameForPath("f.go")).toBe("go");
    expect(languageNameForPath("g.rs")).toBe("rust");
    expect(languageNameForPath("dir/h.mts")).toBe("typescript");
    expect(languageNameForPath("ci.yaml")).toBe("yaml");
    expect(languageNameForPath("ci.YML")).toBe("yaml");
    expect(languageNameForPath("p.html")).toBe("html");
    expect(languageNameForPath("p.htm")).toBe("html");
    expect(languageNameForPath("s.css")).toBe("css");
  });
  it("returns null for unknown or missing extensions", () => {
    expect(languageNameForPath("a.md")).toBeNull();
    expect(languageNameForPath("Makefile")).toBeNull();
    expect(languageNameForPath(".gitignore")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Diagnostic collection
// ---------------------------------------------------------------------------

describe("collectSyntaxDiagnostics", () => {
  it("returns nothing for a clean tree", () => {
    const tree = fakeTree({ type: "program", children: [{ type: "statement" }] });
    expect(collectSyntaxDiagnostics(tree, "")).toEqual({ diagnostics: [], truncated: false, reachedRow: 0 });
  });

  it("reports ERROR nodes with an excerpt and MISSING nodes with the token name", () => {
    const source = "const x = ;\nfunction f(a {\n";
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [
        { type: "declaration", hasError: true, children: [ERROR_NODE(0, 10, source)] },
        {
          type: "function",
          hasError: true,
          children: [{ type: ")", isMissing: true, hasError: true, start: [1, 13, 25], end: [1, 13, 25] }],
        },
      ],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, source);
    expect(diagnostics).toEqual([
      { kind: "error", row: 0, column: 10, detail: 'unexpected ";"' },
      { kind: "missing", row: 1, column: 13, detail: 'missing ")"' },
    ]);
  });

  it("reports damage hidden in an error leaf the binding cannot enumerate", () => {
    // tree-sitter-css shape: `color: ;` recovers into a childless
    // integer_value with hasError=true — the MISSING token shows in
    // toString but is never yielded by child(). The leaf is the only
    // visible witness; without this rule the damage is invisible to the
    // walk and a broken edit reports clean.
    const source = "a {\n  color: ;\n}\n";
    const tree = fakeTree({
      type: "stylesheet",
      hasError: true,
      children: [
        {
          type: "rule_set",
          hasError: true,
          children: [
            {
              type: "block",
              hasError: true,
              children: [
                {
                  type: "declaration",
                  hasError: true,
                  children: [
                    { type: "property_name", start: [1, 2, 0], end: [1, 7, 0], children: [] },
                    { type: "integer_value", hasError: true, start: [1, 8, 0], end: [1, 8, 0], children: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, source);
    // MISSING kind: zero-width damage needs the ±1-line widened scope
    expect(diagnostics).toEqual([{ kind: "missing", row: 1, column: 8, detail: 'error inside "integer_value"' }]);
  });

  it("keeps a hidden-error leaf one line past the spliced line", async () => {
    // A deletion at the end of a run leaves the missing token's insertion
    // point on the FOLLOWING line (editedLineRanges attributes a pure
    // deletion only up to its start line). The hidden-leaf diagnostic is
    // zero-width, so it must ride the MISSING ±1-line widened scope —
    // exact error-scope would drop it and the broken edit report clean.
    const content = "a {\n  color: ;\n}\n";
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "stylesheet",
          hasError: true,
          children: [
            { type: "rule", hasError: true, start: [0, 0, 0], end: [2, 1, 10], children: [] },
            { type: "integer_value", hasError: true, start: [1, 2, 4], end: [1, 2, 4], children: [] },
          ],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.css",
      content,
      splices: [{ start: 0, end: 1, insertLen: 1 }], // line 1 only; leaf is line 2
      loader,
      enabled: true,
    });
    expect(warning).toContain('error inside "integer_value"');
  });

  it("does not double-report an invisible leaf under a visible ERROR", () => {
    // inError guard: the outer ERROR anchors the region; a childless
    // hasError leaf inside it must not add a second diagnostic.
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [
        {
          type: "ERROR",
          hasError: true,
          start: [0, 0, 0],
          end: [1, 0, 10],
          children: [{ type: "value", hasError: true, start: [0, 5, 0], end: [0, 5, 0], children: [] }],
        },
      ],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, "aa\nbb\n");
    expect(diagnostics.map((d) => d.row)).toEqual([0]);
  });

  it("prunes subtrees without hasError", () => {
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [
        { type: "clean", hasError: false, children: [ERROR_NODE(5)] }, // must be skipped
        { type: "dirty", hasError: true, children: [ERROR_NODE(9)] },
      ],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, "");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].row).toBe(9);
  });

  it("suppresses ERROR-inside-ERROR but keeps MISSING inside", () => {
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [
        {
          type: "ERROR",
          hasError: true,
          start: [2, 0, 10],
          end: [8, 0, 90],
          children: [ERROR_NODE(4), { type: "}", isMissing: true, start: [6, 4, 60], end: [6, 4, 60] }],
        },
      ],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, "x".repeat(100));
    // The outer ERROR anchors the region; the nested one at row 4 is
    // suppressed as sub-noise; the MISSING token inside is kept.
    expect(diagnostics.map((d) => [d.kind, d.row])).toEqual([
      ["error", 2],
      ["missing", 6],
    ]);
  });

  it("notes wide ERROR spans and sorts by position", () => {
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [{ ...ERROR_NODE(9), end: [41, 0, 99] as [number, number, number] }, ERROR_NODE(2, 4)],
    });
    const { diagnostics } = collectSyntaxDiagnostics(tree, "");
    expect(diagnostics.map((d) => d.row)).toEqual([2, 9]);
    // End [41, 0] is exclusive: the node covers through line 41, not 42.
    expect(diagnostics[1].detail).toContain("spans lines 10–41");
  });

  it("stops collecting at the cap", () => {
    const children = Array.from({ length: 60 }, (_, i) => ERROR_NODE(i));
    const tree = fakeTree({ type: "program", hasError: true, children });
    const { diagnostics, truncated } = collectSyntaxDiagnostics(tree, "");
    expect(truncated).toBe(true);
    expect(diagnostics.length).toBe(50);
  });

  it("reports truncated only when a kept diagnostic exists past the cap", () => {
    // Exactly 50 diagnostics: the list is complete, not truncated — saying
    // otherwise would tell the model the file may hide more than it does.
    const exactly = fakeTree({
      type: "program",
      hasError: true,
      children: Array.from({ length: 50 }, (_, i) => ERROR_NODE(i)),
    });
    const exact = collectSyntaxDiagnostics(exactly, "");
    expect(exact.diagnostics.length).toBe(50);
    expect(exact.truncated).toBe(false);
    const over = fakeTree({
      type: "program",
      hasError: true,
      children: Array.from({ length: 51 }, (_, i) => ERROR_NODE(i)),
    });
    const past = collectSyntaxDiagnostics(over, "");
    expect(past.diagnostics.length).toBe(50);
    expect(past.truncated).toBe(true);
  });

  it("bounds the walk when every diagnostic is filtered out", () => {
    // Editing one line of an already-mangled file: nothing is kept, so the
    // kept cap never fires — the visited cap must still stop the walk (and
    // per-diagnostic formatting never happens for filtered nodes).
    const n = 7_000;
    const source = Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
    const children = Array.from({ length: n }, (_, i) => ERROR_NODE(i, 0, source));
    const tree = fakeTree({ type: "program", hasError: true, children });
    const capped = collectSyntaxDiagnostics(tree, source, () => false);
    // The visited cap fires on the 5001st ERROR child — row 5000, the frontier.
    expect(capped).toEqual({ diagnostics: [], truncated: true, reachedRow: 5_000 });
    const under = collectSyntaxDiagnostics(
      fakeTree({ type: "program", hasError: true, children: children.slice(0, 4_000) }),
      source,
      () => false,
    );
    expect(under).toEqual({ diagnostics: [], truncated: false, reachedRow: 3_999 });
  });

  it("walk caps at MAX_WALK_NODES inside one wide ERROR subtree", () => {
    // The visited cap counts diagnostics; a pre-broken ERROR node can
    // contain tens of thousands of plain children, and the walk must stay
    // bounded even when none of them reports.
    const n = 50_001;
    const children = Array.from({ length: n }, () => ({
      type: "ident",
      hasError: false,
      start: [0, 0, 0] as [number, number, number],
      end: [0, 1, 1] as [number, number, number],
      children: [],
    }));
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [{ ...children[0]!, type: "ERROR", hasError: true, children }],
    });
    const out = collectSyntaxDiagnostics(tree, "x\n", () => false);
    expect(out).toEqual({ diagnostics: [], truncated: true, reachedRow: 0 });
  });

  it("says so when the walk caps before reaching any diagnostic", async () => {
    // A capped walk that stopped before the edited lines is not a clean
    // bill of health — silence would hide exactly the wide-mangled-file
    // damage the check exists to surface. The damage sits ABOVE the edit
    // (rows 0–1 vs edited line 8) so the walk's frontier never reaches the
    // edited region. Children positions stay inside the wrapper's range —
    // real trees guarantee that, and the frontier logic relies on it.
    const n = 50_001;
    const children = Array.from({ length: n }, () => ({
      type: "ident",
      hasError: false,
      start: [1, 0, 6] as [number, number, number],
      end: [1, 1, 7] as [number, number, number],
      children: [],
    }));
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [
            {
              type: "ERROR",
              hasError: true,
              start: [1, 0, 6] as [number, number, number],
              end: [1, 2, 8] as [number, number, number],
              children,
            },
          ],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: "x\ny\n\n\n\n\n\nedited\n",
      splices: [{ start: 8, end: 9, insertLen: 6 }], // rewrites line 7 only
      loader,
      enabled: true,
    });
    expect(warning).toContain("diagnostic walk capped");
    expect(warning).toContain("f.ts");
  });

  it("falls back to the whole-file scope past the splice-list cap", async () => {
    // Boundary guard: runSyntaxCheck is exported and cannot trust its
    // caller to obey applyEdits' cap, and its offset maps are quadratic in
    // the splice lists. Past the cap, attribution and the differential give
    // way to the whole-file scope — damage on a line NO splice covers must
    // still warn (the naive scoped path would drop it and report clean).
    const lines = ["const a = 1;", "const b = 2;", "const c = ;", "const d = 4;"];
    const content = `${lines.join("\n")}\n`;
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [ERROR_NODE(2, 9, content)], // line 3, outside every splice
        }),
    });
    // 513 zero-length splices, all on line 1 (12-unit lines: i % 12) — the
    // scoped path would attribute only line 1 and drop the line-3 damage.
    const manySplices = Array.from({ length: 513 }, (_, i) => ({ start: i % 12, end: i % 12, insertLen: 0 }));
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous: content, // a prior exists — the fallback must skip the differential, not mis-run it
      splices: manySplices,
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:3:10:");
  });
  it("still warns when the cap fires inside the edited scope's slack", async () => {
    // The gate is deliberately conservative: an ERROR one line past the
    // edit is dropped by `mine` (errors attribute to exact lines only),
    // but the walk still descends into it — and a cap there has not
    // cleared the ±1 MISSING slack the scope claims. Warn rather than go
    // silent; the alternative (silence unless the region is entirely
    // beyond the frontier) would drop partially walked lines.
    const n = 50_001;
    const children = Array.from({ length: n }, () => ({
      type: "ident",
      hasError: false,
      start: [2, 0, 9] as [number, number, number],
      end: [2, 1, 10] as [number, number, number],
      children: [],
    }));
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [
            {
              type: "ERROR",
              hasError: true,
              start: [2, 0, 9] as [number, number, number],
              end: [2, 8, 17] as [number, number, number],
              children,
            },
          ],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: "x\nedited\nmore\n",
      splices: [{ start: 2, end: 8, insertLen: 6 }], // rewrites line 2 only
      loader,
      enabled: true,
    });
    expect(warning).toContain("capped before clearing");
  });

  it("stays silent when the cap fires in damage past the edited lines", async () => {
    // The frontier gate: the same capped, zero-kept walk, but the damage
    // sits BELOW the edit — the edited lines were walked and were clean,
    // so the capped note (with its re-read instruction) would be a false
    // alarm on every edit to such a file.
    const n = 50_001;
    const children = Array.from({ length: n }, () => ({
      type: "ident",
      hasError: false,
      start: [6, 0, 12] as [number, number, number],
      end: [6, 1, 13] as [number, number, number],
      children: [],
    }));
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [
            {
              type: "ERROR",
              hasError: true,
              start: [6, 0, 12] as [number, number, number],
              end: [6, 2, 14] as [number, number, number],
              children,
            },
          ],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: "edited\nx\n\n\n\n\ny\n",
      splices: [{ start: 0, end: 6, insertLen: 6 }], // rewrites line 1 only
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("reports visited-cap truncation only past the boundary", () => {
    const n = 5_001;
    const source = Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
    const at = (k: number) =>
      fakeTree({
        type: "program",
        hasError: true,
        children: Array.from({ length: k }, (_, i) => ERROR_NODE(i, 0, source)),
      });
    // Exactly 5_000 visits: the walk drained the tree — complete, not truncated.
    expect(collectSyntaxDiagnostics(at(5_000), source, () => false).truncated).toBe(false);
    // The 5_001st is dropped, and only then is truncation claimed.
    expect(collectSyntaxDiagnostics(at(5_001), source, () => false).truncated).toBe(true);
  });

  it("reaches diagnostics past a pre-existing error cluster", () => {
    // The walk must not let a near-cap filtered ERROR cluster above the
    // edited line starve the budget before reaching the kept one — a repair
    // edit in an already-mangled file is the feature's core scenario, and
    // missing it would report the edit as clean while it broke syntax.
    // Sized just under MAX_WALK_VISITS: 4_999 junk + 1 kept = exactly cap,
    // which is complete, not truncated.
    const junk = Array.from({ length: 4_999 }, (_, i) => ERROR_NODE(i, 0));
    const kept = MISSING_NODE(4_999, ";");
    const source = Array.from({ length: 5_001 }, (_, i) => `line ${i + 1}\n`).join("");
    const out = collectSyntaxDiagnostics(
      fakeTree({ type: "program", hasError: true, children: [...junk, kept] }),
      source,
      (row, _endRow, kind) => kind === "missing" && row === 4_999,
    );
    expect(out.truncated).toBe(false);
    expect(out.diagnostics).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edited line ranges
// ---------------------------------------------------------------------------

describe("editedLineRanges", () => {
  it("returns nothing for no splices", () => {
    expect(editedLineRanges("abc\n", [])).toEqual([]);
  });

  it("expands a single splice by one line of slack", () => {
    // "abcd" sits on line 2: [line 1, line 3].
    expect(editedLineRanges("1234\nabcd\nxyz\n", [{ start: 5, end: 9, insertLen: 4 }])).toEqual([[1, 3]]);
  });

  it("forwards an earlier splice through a later line-inserting splice", () => {
    // Edit 1 rewrites "7"; edit 2 (applied later) turns line 1 into five lines.
    // Without forwarding, the "SEVEN" splice would land on the wrong line.
    const { newContent, splices } = applyEdits(
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
      [
        { oldText: "7", newText: "SEVEN" },
        { oldText: "1\n", newText: "a\nb\nc\nd\ne\n" },
      ],
      { path: "f.ts", allCap: 20 },
    );
    expect(newContent).toBe("a\nb\nc\nd\ne\n2\n3\n4\n5\n6\nSEVEN\n8\n9\n10\n");
    expect(editedLineRanges(newContent, splices)).toEqual([
      [1, 6], // the inserted five-line block (its inserted end, not the old span end)
      [10, 12], // SEVEN is line 11 after the shift
    ]);
  });

  it("attributes every line of an insertion longer than what it replaced", () => {
    // "two" becomes four lines; the range must reach the last inserted line,
    // not stop at the old single-line span.
    expect(editedLineRanges("one\nAA\nBB\nCC\nDD\nthree\n", [{ start: 4, end: 7, insertLen: 11 }])).toEqual([[1, 6]]);
  });

  it("does not reach into the lines that slid up after a deletion", () => {
    // Four lines collapse to one; the untouched t1–t4 lines must stay outside
    // the attributed range (they were not rewritten by the splice).
    expect(editedLineRanges("one\nX\nt1\nt2\nt3\nt4\n", [{ start: 4, end: 12, insertLen: 1 }])).toEqual([[1, 3]]);
  });

  it("does not attribute identical-text splices", () => {
    // An elastic match that reproduces the existing bytes (tabs in oldText,
    // spaces in the file, zero shift) records no splice — a pre-existing
    // error on those lines must not be blamed on the call.
    const { splices } = applyEdits("    a\n    b\n", [{ oldText: "\ta\n\tb", newText: "    a\n    b" }], {
      path: "f.ts",
      allCap: 20,
    });
    expect(splices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formatting and orchestration
// ---------------------------------------------------------------------------

describe("formatSyntaxWarning", () => {
  const diag = (row: number): SyntaxDiagnostic => ({
    kind: "missing",
    row,
    column: 3,
    detail: 'missing ")"',
  });

  it("returns null for no diagnostics", () => {
    expect(formatSyntaxWarning("f.ts", [])).toBeNull();
  });

  it("renders 1-based positions and caps the list", () => {
    const many = Array.from({ length: 7 }, (_, i) => diag(i));
    const text = formatSyntaxWarning("f.ts", many)!;
    expect(text).toContain("f.ts:1:4: missing");
    expect(text).toContain("…and 2 more");
    expect(text.match(/f\.ts:\d+/g)).toHaveLength(5);
  });
});

describe("runSyntaxCheck", () => {
  const source = "const ok = 1;\nconst bad = ;\n";

  it("reports a diagnostic on an edited line", async () => {
    const tree = fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 11, source)] });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: 14, end: 27, insertLen: 13 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toContain("warning:");
    expect(warning).toContain("f.ts:2:12:");
  });

  it("stays silent when the error is outside the edited lines", async () => {
    const source = "const ok = 1;\nconst val = 2;\n\n\nconst far = ;\n";
    const tree = fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(4, 11, source)] });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: 14, end: 27, insertLen: 13 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("is silent for a clean parse, disabled knob, unknown language, and oversize content", async () => {
    // The loader records every call and hands back an ERRORING tree, so each
    // guard assertion fails if its short-circuit is removed: with the guard
    // gone the erroring tree would produce a warning, and the call log would
    // show a load that should never have happened.
    const calls: string[] = [];
    const base = {
      content: source,
      splices: [{ start: 14, end: 27, insertLen: 13 }],
      loader: (async (language: string) => {
        calls.push(language);
        return fixedLanguage(fakeTree({ type: "program", hasError: true }));
      }) as SyntaxLoader,
    };
    // A genuinely clean parse stays silent.
    expect(
      await runSyntaxCheck({
        ...base,
        path: "f.ts",
        enabled: true,
        loader: async () => fixedLanguage(fakeTree({ type: "program" })),
      }),
    ).toBeNull();
    expect(await runSyntaxCheck({ ...base, path: "f.ts", enabled: false })).toBeNull();
    expect(await runSyntaxCheck({ ...base, path: "f.md", enabled: true })).toBeNull();
    expect(await runSyntaxCheck({ ...base, path: "f.ts", content: "x".repeat(513_000), enabled: true })).toBeNull();
    // The bound is bytes, not UTF-16 code units: 300k astral characters are
    // 600k code units but 1.2MB of UTF-8.
    expect(await runSyntaxCheck({ ...base, path: "f.ts", content: "𝕏".repeat(300_000), enabled: true })).toBeNull();
    expect(calls).toEqual([]); // every guard above short-circuits before any load
  });

  it("suppresses pre-existing damage on the edited line (differential parse)", async () => {
    // The JSONC case: a `// comment` (or trailing comma) on the edited line
    // is a strict-JSON ERROR that predates the edit — the row filter cannot
    // help because the damage sits ON the rewritten line.
    const previous = '{\n  "strict": true, // strict mode\n}\n';
    const content = '{\n  "strict": false, // strict mode\n}\n';
    const errorAt = (source: string, column: number) =>
      fakeTree({
        type: "program",
        hasError: true,
        children: [ERROR_NODE(1, column, source)],
      });
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) => (source === previous ? errorAt(previous, 11) : errorAt(content, 11)),
    });
    const warning = await runSyntaxCheck({
      path: "tsconfig.json",
      content,
      previous,
      splices: [{ start: 14, end: 18, insertLen: 5 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull(); // same kind+column pre-edit: not this edit's fault
  });

  it("still warns for damage the edit newly introduced on that line", async () => {
    const previous = '{\n  "strict": true, // strict mode\n}\n';
    const content = '{\n  "strict": false,, // strict mode\n}\n';
    // Pre-edit: one ERROR at the comment. Post-edit: that plus a NEW one at
    // the double comma — different column, so the differential keeps it.
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 11, source)] })
          : fakeTree({
              type: "program",
              hasError: true,
              children: [ERROR_NODE(1, 18, source), ERROR_NODE(1, 11, source)],
            }),
    });
    const warning = await runSyntaxCheck({
      path: "tsconfig.json",
      content,
      previous,
      splices: [{ start: 14, end: 18, insertLen: 5 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain("tsconfig.json:2:19:");
    expect(warning).not.toContain(":2:12:"); // the pre-existing comment ERROR is gone
  });

  it("attributes a multi-line ERROR node by span, not start line", async () => {
    // yaml shape (`b: [unclosed`): recovery starts the ERROR on the line
    // BEFORE the damage, swallowing the preceding sibling — start-line
    // attribution would drop a node whose span covers the edited line.
    // The position still reports the span start (the excerpt anchors
    // there); what must change is whether it is KEPT at all.
    const previous = "a: 1\nb: 2\n";
    const content = "a: 1\nb: [unclosed\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "block_mapping", children: [] })
          : fakeTree({
              type: "block_mapping",
              hasError: true,
              children: [{ type: "ERROR", hasError: true, start: [0, 0, 0], end: [1, 11, 17], children: [] }],
            }),
    });
    const warning = await runSyntaxCheck({
      path: "f.yaml",
      content,
      previous,
      splices: [{ start: 8, end: 9, insertLen: 9 }], // run: 2 -> [unclosed on line 2
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.yaml:1:1:");
    expect(warning).toContain("unexpected");
  });

  it("does not attribute a node that merely ends at a line boundary", async () => {
    // tree-sitter endPosition is exclusive: a node ending at [2, 0]
    // covers nothing on line 3. Attribution must treat that end as
    // row 1 — claiming row 3 would let pre-existing damage blame an edit
    // on the next line when the differential is skipped (no `previous`,
    // oversize, or truncated prior).
    const content = "aa\nbb\ncc\n";
    const loader: SyntaxLoader = async () => ({
      parse: () =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [{ type: "ERROR", hasError: true, start: [0, 0, 0], end: [2, 0, 4], children: [] }],
        }),
    });
    const boundary = await runSyntaxCheck({
      path: "f.ts",
      content,
      splices: [{ start: 6, end: 8, insertLen: 2 }], // line 3 only
      loader,
      enabled: true,
    });
    expect(boundary).toBeNull(); // ends AT line 3's start: covers nothing there
    const covering = await runSyntaxCheck({
      path: "f.ts",
      content,
      splices: [{ start: 6, end: 8, insertLen: 2 }],
      loader: async () => ({
        parse: () =>
          fakeTree({
            type: "program",
            hasError: true,
            children: [{ type: "ERROR", hasError: true, start: [0, 0, 0], end: [2, 2, 6], children: [] }],
          }),
      }),
      enabled: true,
    });
    expect(covering).toContain("f.ts:1:1:"); // ends INSIDE line 3: covers it
  });

  it("suppresses when a length-changing edit shifts the column", async () => {
    // true → false slides the trailing comma one column right: columns are
    // no identity, but the comma's OFFSET inverts through the splice
    // exactly, so the same pre-existing damage is still recognized.
    const previous = '{\n  "strict": true,\n}\n';
    const content = '{\n  "strict": false,\n}\n';
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 16, source)] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 17, source)] }),
    });
    const warning = await runSyntaxCheck({
      path: "tsconfig.json",
      content,
      previous,
      splices: [{ start: 14, end: 18, insertLen: 5 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("attributes damage on unchanged lines inside a wide replaced block", async () => {
    // The production split: splices carry the minimal changed runs (the
    // differential's offset identity) while `edited` carries the whole
    // replaced range (line attribution). Damage reported on a
    // byte-identical line INSIDE the block — the brace-break shape — must
    // still warn; run-level splices alone would narrow attribution to the
    // changed line and go silent.
    const previous = "aaa\nbbb\n";
    const content = "AAA\nbbb\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        fakeTree({
          type: "program",
          hasError: true,
          children: source === previous ? [] : [ERROR_NODE(1, 0, content)],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      splices: [{ start: 0, end: 3, insertLen: 3 }], // run: aaa→AAA on line 1
      edited: [{ start: 0, end: 7, insertLen: 7 }], // whole two-line match
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:2:1:");
  });

  it("attributes MISSING damage on unchanged lines inside a wide replaced block", async () => {
    // Same split as above, MISSING flavor: a dropped closing delimiter
    // reports as a zero-width token at a statement anchor — possibly on a
    // byte-identical line more than ±1 from the changed run. Attribution
    // must come from the whole replaced span (`edited`), not the minimal
    // runs; scoping MISSING to run±1 would drop the damage at collection
    // and report a broken edit clean.
    const previous = "aaa\nbbb\nccc\n";
    const content = "AAA\nbbb\nccc\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        fakeTree({
          type: "program",
          hasError: true,
          children: source === previous ? [] : [MISSING_NODE(2, '"')],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      splices: [{ start: 0, end: 3, insertLen: 3 }], // run: aaa→AAA on line 1
      edited: [{ start: 0, end: 11, insertLen: 11 }], // whole three-line match
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:3:1: missing "');
  });

  it("suppresses pre-existing damage on unchanged lines inside a wide replaced block", async () => {
    // The prior scope must mirror attribution (the whole replaced span),
    // not the minimal changed runs: the post side keeps diagnostics from
    // unchanged lines inside the block, so scoping the prior collection to
    // the changed runs alone would re-report pre-existing damage there as
    // new. Same shape as the attribution test above, but the line-2 ERROR
    // predates the edit and must be silenced.
    const previous = "aaa\nbbb\n";
    const content = "AAA\nbbb\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        fakeTree({
          type: "program",
          hasError: true,
          children: source === previous ? [ERROR_NODE(1, 0, previous)] : [ERROR_NODE(1, 0, content)],
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 0, end: 3, insertLen: 3 }], // run: aaa→AAA on line 1
      edited: [{ start: 0, end: 7, insertLen: 7 }], // whole two-line match
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("clamps past-end-of-line columns before inverting offsets", async () => {
    // ERROR recovery often reports a column past the line's end. The
    // unclamped offset would spill into the following line's text — and a
    // newline-inclusive clamp lands on its FIRST CHARACTER, pre offset 6,
    // where a same-kind prior sits. Clamped to the line's text end (offset
    // 5, the newline) the damage has no pre-image and must warn.
    const previous = "aa\nbb\ncc\n";
    const content = "aa\nBb\ncc\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        fakeTree({
          type: "program",
          hasError: true,
          children:
            source === previous
              ? [ERROR_NODE(2, 0, previous)] // pre offset 6 — the next line's first char
              : [ERROR_NODE(1, 5, content)], // column 5 on a 2-char line
        }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 3, end: 5, insertLen: 2 }], // run: bb→Bb on line 2
      edited: [{ start: 0, end: 7, insertLen: 7 }], // whole two-line match
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:2:"); // the new damage survives; the spill target does not silence it
  });

  it("clamps printed columns to the line's text end", async () => {
    // ERROR recovery routinely reports columns past the line's end; the
    // diagnostic's column is stored pre-clamped (unlike the excerpt and
    // the offset identity, which clamp at use) the printed location would
    // point at a column that does not exist and misdirect a re-reading
    // model. Storage-time clamp makes every consumer see one value; the
    // EOL-damage suppression tests below pin that the offset math is
    // unchanged (the compare-time clamps are idempotent under it).
    const previous = '{\n  "strict": true,\n}\n';
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        fakeTree({
          type: "program",
          hasError: true,
          children: [ERROR_NODE(1, 20, source)], // column 20 on an 18-unit line
        }),
    });
    const warning = await runSyntaxCheck({
      path: "tsconfig.json",
      content: previous, // unchanged: pure attribution, no prior to suppress
      splices: [{ start: 14, end: 18, insertLen: 4 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain("tsconfig.json:2:18:"); // min(20, 17) + 1
    expect(warning).not.toContain("tsconfig.json:2:21:");
  });

  it("does not let same-shaped damage far away swallow a new diagnostic", async () => {
    // End-to-end contract pin: a `missing ";"` seven lines below the edit
    // must not hide the one the edit just introduced. The load-bearing rule
    // is the offset-exact identity (the far-away prior's pre offset cannot
    // equal the new damage's pre-image 13); the row scoping of the prior
    // collection is defense-in-depth that also bounds its walk cost.
    // Whole-file, row- and offset-independent matching would break this.
    // (Damage on the ADJACENT line can still suppress — via the ±1 MISSING
    // slack on the prior scope plus an exact offset match.)
    const previous = "const a = 1;\nconst b = 2;\n// pad\n// pad\n// pad\n// pad\n// pad\n// pad\nconst j = ;\n";
    const content = previous.replace("const b = 2;", "const b = ;");
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({
              type: "program",
              hasError: true,
              // The row-0 candidate (in scope via the ±1 MISSING slack, at
              // pre offset 0) pins the offset-exact identity: a same-kind
              // prior at a DIFFERENT offset must not suppress. The row-8
              // one pins the scope: an unscoped collection would gather it
              // too, and without the offset comparison either could match.
              children: [MISSING_NODE(0, ";"), MISSING_NODE(8, ";")],
            })
          : fakeTree({
              type: "program",
              hasError: true,
              children: [MISSING_NODE(1, ";"), MISSING_NODE(8, ";")],
            }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 13, end: 25, insertLen: 11 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:2:1: missing ";"'); // the new one survives
  });

  it("maps a splice starting exactly at the damaged offset back to itself", async () => {
    // Edit 0 collapses pre lines 2–3 into "XYZ"; edit 1 rewrites the first
    // char of that insertion, starting exactly where a pre-existing missing
    // \";\" sits. The before-edge of an insertion is also the first position
    // of the old span — the offset where statement-level MISSING damage
    // reports — so the pre-existing damage is recognized, not blamed on the
    // edit (same shape as the 50+ diagnostics test, chained through two
    // splices).
    const previous = "aaaa\nbbbb\ncccc\ndddd\n";
    const content = "aaaa\nQYZdddd\n";
    const loader: SyntaxLoader = async () => ({
      parse: () => fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(1, ";")] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [
        { start: 5, end: 15, insertLen: 3 },
        { start: 5, end: 6, insertLen: 1 },
      ],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("suppresses pre-existing MISSING damage on a line adjacent to the edit", async () => {
    // A clean rewrite of line 2 next to line 1's pre-existing missing \";\":
    // the post collection keeps the damage via the ±1 MISSING slack, the
    // prior scope widens the same way, and the untouched offset maps onto
    // the prior exactly — so the edit is not blamed for old damage. The
    // second check is the discriminator: with a CLEAN prior tree the same
    // post collection must WARN — otherwise "suppressed" could not be
    // told apart from "never collected" (the attribution filter dropping
    // the diagnostic would also null the first check).
    const previous = "const a = ;\nconst b = 2;\n";
    const content = previous.replace("const b = 2;", "const b = 3;");
    const makeLoader =
      (priorHasDamage: boolean): SyntaxLoader =>
      async () => ({
        parse: (source: string) =>
          source === previous
            ? fakeTree({
                type: "program",
                hasError: true,
                children: priorHasDamage ? [MISSING_NODE(0, ";")] : [],
              })
            : fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(0, ";")] }),
      });
    const suppressed = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 12, end: 24, insertLen: 12 }],
      loader: makeLoader(true),
      enabled: true,
    });
    expect(suppressed).toBeNull();
    const surfaced = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 12, end: 24, insertLen: 12 }],
      loader: makeLoader(false),
      enabled: true,
    });
    expect(surfaced).toContain('f.ts:1:1: missing ";"');
  });

  it("keeps an ERROR at an insertion edge that a later edit shifted", async () => {
    // Splices may be recorded in descending file order (occurrence: "all"
    // pushes them that way): the second splice grows the head of the line
    // from 2 to 5 chars, so the FIRST splice's before-edge (recorded at 6)
    // sits at final offset 9. The edge test must forward each start to
    // final coordinates, or the ERROR sitting on the shifted edge is
    // treated as suppressible prior damage — and silently swallowed.
    const previous = "ab0123456789\n";
    const content = "ABCDE0123XXXXXXXX9\n";
    const splices = [
      { start: 6, end: 11, insertLen: 8 },
      { start: 0, end: 2, insertLen: 5 },
    ];
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 6, previous)] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 9, content)] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices,
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:10:");
  });

  it("collects the prior on the line where a whole-line edit's span ends", async () => {
    // The splice replaces "b\n" with "B", so post offset 3 (the ERROR on
    // "Bc") maps back to pre offset 4 — the start of pre line 3, exactly
    // where the old span ends. The prior scope must include that boundary
    // line or the pre-existing ERROR is re-reported as the edit's fault.
    const previous = "a\nb\nc\n";
    const content = "a\nBc\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(2, 0, previous)] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 1, content)] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 2, end: 4, insertLen: 1 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull(); // the line-3 damage predates the edit
  });

  it("keeps an ERROR at the first character of inserted text", async () => {
    // The insertion starts exactly where a pre-existing ERROR sat. The
    // before-edge is ambiguous — it is also the old span's first position —
    // but an ERROR there is located damage in text the edit just wrote:
    // only MISSING damage (statement anchors) may claim the edge.
    const previous = "a;\n";
    const content = "x\n";
    const loader: SyntaxLoader = async () => ({
      parse: () => fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 0)] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 0, end: 2, insertLen: 1 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:1:");
  });

  it("skips the differential pass for an oversize pre-edit content", async () => {
    // An edit that shrinks a huge file: content passes the byte guard, the
    // old body would not — the differential must not parse it unbounded.
    const bigTail = "x".repeat(520_000);
    const previous = `const a = 1;\n${bigTail}\n`;
    const content = "const a = ;\n";
    const parsedPrevious: string[] = [];
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) => {
        if (source === previous) parsedPrevious.push(source);
        return source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 10, "const a = 1;\n")] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 10, source)] });
      },
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 10, end: 11, insertLen: 0 }], // deletes the "1": 13 - 1 = 12 = content.length
      loader,
      enabled: true,
    });
    expect(parsedPrevious).toEqual([]); // never parsed the oversize previous
    expect(warning).toContain("f.ts:1:11:"); // undifferentiated warning survives
  });

  it("an adjacent edit's pre-existing damage cannot suppress a new diagnostic", async () => {
    // The suppression set is scoped to the edit family's pre lines, and the
    // identity test is offset-exact: the pre-existing `missing ";"` on line 1
    // (pre offset 0) is a different offset from the new damage's pre-image
    // (pre offset 13), so no same-kind coincidence can hide it — even with
    // the same bare token text and the same column.
    const previous = "const a = 1;\nconst b = 2;\n";
    // edit 0: "const a" → "const aa"; edit 1: "= 2" at offset 22 in the
    // post-edit-0 content (14 for line 1 + 8 for "const b ") → "= x".
    const splices = [
      { start: 0, end: 7, insertLen: 8 },
      { start: 22, end: 25, insertLen: 3 },
    ];
    const content = "const aa = 1;\nconst b = x;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(0, ";")] })
          : fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(1, ";")] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices,
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:2:1: missing ";"');
  });

  it("inverse-maps pre-edit lines through an earlier length-changing edit", async () => {
    // Two chained edits: the first turns line 1 into five lines, so the
    // second splice's offsets (recorded AFTER that insertion) must be
    // walked back to pre-edit coordinates or its prior scope pairs with
    // the wrong pre-edit lines. The pre-existing missing-semicolon damage
    // sits at pre offset 21 (row 7, \u201cl8\u201d) — exactly where the post
    // diagnostic's offset inverse-maps — so the CORRECT inversion scopes
    // the prior collection to rows 6-8, collects it, and suppression
    // yields null. A naive un-inverted mapping would scope rows 10-12,
    // drop the prior, and blame the edit for damage it did not introduce
    // (a warning where this test asserts silence).
    const previous = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
    // edit 0: "l1" (offset 0) → five lines; edit 1: "l8" at offset 28 in
    // the post-edit-0 content (21 + 7) → "L8".
    const splices = [
      { start: 0, end: 2, insertLen: 9 },
      { start: 28, end: 30, insertLen: 2 },
    ];
    const content = "a\nb\nc\nd\ne\nl2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(7, ";")] })
          : fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(11, ";")] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices,
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("tracks end-of-line damage across a length change by offset, not excerpt", async () => {
    // Both ERRORs sit PAST their line ends (columns 20/21 on a 17/18-unit
    // line — the common ERROR-recovery shape), so both excerpts clamp to
    // `unexpected ""` and both offsets clamp to the line's text end. The
    // offsets map exactly (the +1 of true→false slides the damage one
    // unit), so the same damage stays suppressed — which requires the
    // prior side's column to be clamped like the post side's.
    const previous = '{\n  "strict": true,\n}\n';
    const content = '{\n  "strict": false,\n}\n';
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 20, source)] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(1, 21, source)] }),
    });
    const warning = await runSyntaxCheck({
      path: "tsconfig.json",
      content,
      previous,
      splices: [{ start: 14, end: 18, insertLen: 5 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("keeps a pure insertion's first byte unsuppressible", async () => {
    // A pure insertion replaced nothing, so its before-edge is as new as
    // the rest of the inserted text: a MISSING token reported at the head
    // of the inserted statement must survive even when pre-existing damage
    // sits at exactly that pre-edit offset (EOF here) — the edge exception
    // is for replacements, whose first position is also the old span's.
    const previous = "const a = 1;\n";
    const content = "const a = 1;\nconst b = ;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(1, ";")] })
          : fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(1, ";")] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 13, end: 13, insertLen: 12 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:2:1: missing ";"');
  });

  it("refuses column coincidence against a pure insertion", async () => {
    // A pure insertion collapses its whole pre side to one line, so the
    // pre-existing missing ";" at column 0 shares a column with the new
    // one on any inserted line — coincidence, not identity. Positions
    // inside inserted text have no pre-image (toPreOffset → -1), so the
    // coincidence can never satisfy the offset-exact rule: keep it. The
    // prior EOF-position MISSING makes that rule load-bearing: without
    // the -1, the post offset would map to pre offset 13 and match it,
    // suppressing this warning (the test would go green on the bug).
    const previous = "const a = 1;\n";
    const content = "const a = 1;\nconst b = ;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({
              type: "program",
              hasError: true,
              children: [MISSING_NODE(0, ";"), MISSING_NODE(1, ";")],
            })
          : fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(1, ";")] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 13, end: 13, insertLen: 12 }], // 13 + 12 = 25 = content.length; line 2 starts AT the insertion
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:2:1: missing ";"');
  });

  it("keeps suppression working when the pre-edit file holds 50+ diagnostics", async () => {
    // End-to-end pin: a pre-broken file whose damage elsewhere dwarfs the
    // edited line's still suppresses that line's pre-existing diagnostic.
    // The far-row junk is dropped from the post collection by the edited-
    // line attribution and from the prior collection by the pre-line
    // scope; the offset-exact identity then recognizes the row-80 damage
    // as pre-existing. (The scope also bounds the prior walk's kept list,
    // keeping the per-diagnostic suppression checks cheap.)
    const junk = Array.from({ length: 60 }, (_, i) => MISSING_NODE(i, ";"));
    const lines = Array.from({ length: 90 }, (_, i) => `line ${i}`);
    lines[79] = "const p = ;";
    const previous = `${lines.join("\n")}\n`;
    const content = previous.replace("const p = ;", "const q = ;");
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [...junk, MISSING_NODE(79, ";")] })
          : fakeTree({ type: "program", hasError: true, children: [...junk, MISSING_NODE(79, ";")] }),
    });
    const line80 = lines.slice(0, 79).join("\n").length + 1; // offset of "const p = ;"
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: line80, end: line80 + 11, insertLen: 11 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull(); // the row-80 damage predates the edit
  });

  it("disables the differential when the prior walk truncates", async () => {
    // The pre-edit file carries a matching MISSING diagnostic plus 5_100
    // out-of-scope ERROR nodes — past the MAX_WALK_VISITS (5_000) walk
    // budget — so the scoped prior collection truncates with PARTIAL data
    // that does contain the offset-matching candidate. Using it would
    // suppress the diagnostic entirely (empty fresh list, no warning at
    // all); the guard instead skips refinement and keeps the warning. The
    // real candidate is placed first so it is collected before truncation
    // — otherwise the fixture cannot tell a guarded run from an unguarded
    // one (verified: with the guard disabled, this test fails).
    const junk = Array.from({ length: 5_100 }, (_, i) => ERROR_NODE(i, 0));
    const lines = Array.from({ length: 610 }, (_, i) => `line ${i}`);
    lines[605] = "const p = ;";
    const previous = `${lines.join("\n")}\n`;
    const content = previous.replace("const p = ;", "const q = ;");
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(605, ";"), ...junk] })
          : // Post tree: only the edited line's damage — the post collection
            // is complete, so only the PRIOR truncation guard can fire.
            fakeTree({ type: "program", hasError: true, children: [MISSING_NODE(605, ";")] }),
    });
    const line606 = lines.slice(0, 605).join("\n").length + 1; // offset of "const p = ;"
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: line606, end: line606 + 11, insertLen: 11 }],
      loader,
      enabled: true,
    });
    expect(warning).toContain('f.ts:606:1: missing ";"');
  });

  it("keeps the warning when the pre-edit content was clean", async () => {
    const previous = "const a = 1;\n";
    const content = "const a = ;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program" })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 10, source)] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 10, end: 11, insertLen: 0 }], // deletes the "1": 13 - 1 = 12 = content.length
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:11:");
  });

  it("maps a deletion's post offset through the pre-side shift", async () => {
    // Deleting the "b" (splice {6,7,0}): the post "=" at offset 11 must
    // invert through the deletion — 11 + (end - start) = 12 — to the
    // prior's offset 12, where the same ERROR already sat. A wrong shift
    // (dropping the end-start term) breaks the identity and this warning
    // comes back, blaming the edit for pre-existing damage.
    const previous = "const ab = 1;\n";
    const content = "const a = 1;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) =>
        source === previous
          ? fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 12, source)] })
          : fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 11, source)] }),
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 6, end: 7, insertLen: 0 }],
      loader,
      enabled: true,
    });
    expect(warning).toBeNull();
  });

  it("fails open when the differential parse throws", async () => {
    const previous = "const a = 1;\n";
    const content = "const a = ;\n";
    const loader: SyntaxLoader = async () => ({
      parse: (source: string) => {
        if (source === previous) throw new Error("pre-edit parse exploded");
        return fakeTree({ type: "program", hasError: true, children: [ERROR_NODE(0, 10, source)] });
      },
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content,
      previous,
      splices: [{ start: 10, end: 11, insertLen: 0 }], // deletes the "1": 13 - 1 = 12 = content.length
      loader,
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:11:"); // undifferentiated warning, never an error
  });

  it("fails open on a null loader and on a throwing one", async () => {
    const opts = { path: "f.ts", content: source, splices: [{ start: 0, end: 5, insertLen: 5 }], enabled: true };
    expect(await runSyntaxCheck({ ...opts, loader: async () => null })).toBeNull();
    expect(
      await runSyntaxCheck({
        ...opts,
        loader: async () => {
          throw new Error("grammar blew up");
        },
      }),
    ).toBeNull();
    expect(
      await runSyntaxCheck({
        ...opts,
        loader: async () => ({
          parse: () => {
            throw new Error("parse blew up");
          },
        }),
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool level (fake fs + injected syntax boundary)
// ---------------------------------------------------------------------------

function fakeFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: EditOperations = {
    readFile: async (p) => Buffer.from(files.get(p) ?? "", "utf-8"),
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    access: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
  };
  return { ops, read: (p: string) => files.get(p) as string };
}

describe("createSuperEditTool syntax check", () => {
  const files = { "/w/f.ts": "const ok = 1;\nconst val = 2;\n" };
  const breakingEdit = { path: "f.ts", edits: [{ oldText: "const val = 2;", newText: "const val = ;" }] };

  async function run(
    input: { path: string; edits: Array<{ oldText: string; newText: string }> },
    loader: SyntaxLoader,
    opts: { budgetMs?: number; signal?: AbortSignal } = {},
  ) {
    const fs = fakeFs(files);
    const tool = createSuperEditTool("/w", {
      operations: fs.ops,
      syntax: { enabled: () => true, loader, budgetMs: opts.budgetMs },
    });
    const result = await tool.execute("1", input, opts.signal, undefined, { cwd: "/w" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { text, details: result.details as { syntaxWarning?: string }, read: fs.read };
  }

  it("appends the warning when the edited region is broken", async () => {
    const seen: string[] = [];
    const parsed: string[] = [];
    const post = "const ok = 1;\nconst val = ;\n";
    const previous = "const ok = 1;\nconst val = 2;\n";
    const errorTree = fakeTree({
      type: "program",
      hasError: true,
      children: [ERROR_NODE(1, 11, post)],
    });
    const cleanTree = fakeTree({ type: "program" });
    const { text, details } = await run(breakingEdit, async (language) => {
      seen.push(language);
      // Source-sensitive like a real grammar: the pre-edit content was
      // clean, so the differential parse must not suppress the new damage.
      return { parse: (source) => (parsed.push(source), source === post ? errorTree : cleanTree) };
    });
    expect(seen).toEqual(["typescript"]); // path → grammar mapping reaches the loader
    // The checker parses the POST-EDIT content first (LF-normalized, no
    // BOM), then the pre-edit content for the differential pass.
    expect(parsed).toEqual([post, previous]);
    expect(text).toContain("Applied 1 edit to f.ts");
    expect(text).toContain("warning:");
    expect(text).toContain("f.ts:2:12:");
    expect(details.syntaxWarning).toContain("f.ts:2:");
  });

  it("keeps the edit quiet and applied when no grammar is available", async () => {
    const { text, read } = await run(breakingEdit, async () => null);
    expect(text).not.toContain("warning");
    expect(read("/w/f.ts")).toBe("const ok = 1;\nconst val = ;\n");
  });

  it("fails open when the loader throws", async () => {
    const { text, read } = await run(breakingEdit, async () => {
      throw new Error("boom");
    });
    expect(text).not.toContain("warning");
    expect(read("/w/f.ts")).toBe("const ok = 1;\nconst val = ;\n");
  });

  it("stops waiting on a stalled grammar load once the budget expires", async () => {
    // A loader that never resolves models a native import hung on a slow or
    // network filesystem: the budget must expire the wait so the advisory
    // check never gates delivery of the committed edit.
    const { text, read } = await run(breakingEdit, () => new Promise(() => {}), { budgetMs: 10 });
    expect(text).toContain("Applied 1 edit to f.ts");
    expect(text).not.toContain("warning");
    expect(read("/w/f.ts")).toBe("const ok = 1;\nconst val = ;\n");
  });

  it("skips the check when the signal aborts after the write commits", async () => {
    // Abort between write and check: the queue callback must finish (the
    // file lands), and the advisory check must be skipped without turning
    // the landed edit into an error.
    const controller = new AbortController();
    const fs = fakeFs(files);
    const ops = {
      ...fs.ops,
      writeFile: async (p: string, content: string) => {
        controller.abort();
        await fs.ops.writeFile(p, content);
      },
    };
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [ERROR_NODE(1, 11, "const ok = 1;\nconst val = ;\n")],
    });
    const tool = createSuperEditTool("/w", {
      operations: ops,
      syntax: { enabled: () => true, loader: async () => fixedLanguage(tree), budgetMs: 60_000 },
    });
    const result = await tool.execute("1", breakingEdit, controller.signal, undefined, { cwd: "/w" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("Applied 1 edit");
    expect(text).not.toContain("warning");
    expect(fs.read("/w/f.ts")).toBe("const ok = 1;\nconst val = ;\n");
  });

  it("does not let pre-existing errors starve the cap before the edited lines", async () => {
    // 60 pre-existing errors sit above the single line this call rewrote,
    // which carries the one error the edit introduced. With a post-collection
    // filter the first 50 (pre-existing) diags would exhaust the cap and the
    // real damage would never be reported; filtering inside collection must
    // find it.
    const source = Array.from({ length: 101 }, (_, i) => `line ${i + 1}\n`).join("");
    const children = Array.from({ length: 60 }, (_, i) => ERROR_NODE(i, 0, source));
    children.push(ERROR_NODE(100, 0, source));
    const tree = fakeTree({ type: "program", hasError: true, children });
    const editedOffset = offsetOf(source, 100, 0);
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: editedOffset, end: editedOffset + 9, insertLen: 9 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toContain("f.ts:101:");
  });

  it("derives excerpts from the row, not from UTF-8 byte indexes", async () => {
    // 你好 is 6 UTF-8 bytes but 2 code units: a real tree-sitter node on line
    // 2 carries startIndex 18, which as a string index slices past the line.
    // The excerpt must come from row/column instead.
    const source = "你好\nconst val = ;\n";
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [{ type: "ERROR", hasError: true, start: [1, 11, 18], end: [1, 13, 20], children: [] }],
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: 4, end: 15, insertLen: 13 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toContain('unexpected " ;"');
  });

  it("uses tree-sitter's code-unit columns verbatim for display", async () => {
    // Native tree-sitter 0.25 columns are UTF-16 units: on "你好 = ;" the
    // " = ;" span starts at unit column 2 (byte column 6). The printed
    // position and the excerpt must use the units directly — no conversion.
    const source = "你好 = ;\n";
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [{ type: "ERROR", hasError: true, start: [0, 2, 2], end: [0, 6, 6], children: [] }],
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: 0, end: 8, insertLen: 8 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:3:"); // unit col 2 → printed 3
    expect(warning).toContain('unexpected " = ;"');
  });

  it("skips the parse when the caller stopped waiting (budget or abort)", async () => {
    const parsed: string[] = [];
    // `cancelled` flips exactly when the loader resolves — true before the
    // parse would run, false at function entry — pinning that the poll sits
    // between the load and the parse, not at the top of the call.
    let cancelled = false;
    let releaseLoader: (() => void) | undefined;
    const loader: SyntaxLoader = () =>
      new Promise((resolve) => {
        releaseLoader = () => {
          cancelled = true;
          resolve({ parse: (source: string) => (parsed.push(source), fakeTree({ type: "program" })) });
        };
      });
    const check = runSyntaxCheck({
      path: "f.ts",
      content: "const a = ;\n",
      splices: [{ start: 0, end: 12, insertLen: 12 }],
      loader,
      enabled: true,
      cancelled: () => cancelled,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseLoader!();
    expect(await check).toBeNull();
    expect(parsed).toEqual([]); // the sync parse never ran for the discarded result
  });
});

describe("createRealSyntaxLoader failure handling", () => {
  // Fakes, not the real imports: the cooldown logic is what is under test.
  const fakeCoreResult = {
    default: class {
      setLanguage(): void {}
      parse(): unknown {
        return null;
      }
    },
  };
  const fakeCore = async () => fakeCoreResult;

  it("retries a failing language on the next edit, breadcrumbing once", async () => {
    // Settled failures are NOT parked: their common causes (EMFILE, a
    // prebuild extraction still in flight) self-heal on the next edit,
    // and a rejected import is cheap. The once-per-language breadcrumb is
    // the operator signal; the check fails open either way.
    const imports: string[] = [];
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => errors.push(String(msg)));
    try {
      const loader = createRealSyntaxLoader({
        importCore: fakeCore,
        importGrammar: async (language) => {
          imports.push(language);
          throw new Error("boom");
        },
        now: () => 0,
      });
      expect(await loader("yaml")).toBeNull();
      expect(await loader("yaml")).toBeNull(); // immediate retry: a transient EMFILE heals here
      expect(imports).toEqual(["yaml", "yaml"]);
      expect(errors).toHaveLength(1); // one breadcrumb, not one per retry
      expect(errors[0]).toContain("superedit syntax check unavailable for yaml: boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("shares one in-flight load across concurrent callers", async () => {
    let clock = 0;
    let calls = 0;
    let releaseImport: (() => void) | undefined;
    const loader = createRealSyntaxLoader({
      importCore: async () => {
        calls++;
        return new Promise((resolve) => {
          releaseImport = () => resolve(fakeCoreResult);
        });
      },
      importGrammar: async () => ({}),
      now: () => clock,
    });
    const first = loader("typescript");
    const second = loader("typescript"); // arrives while the load is still running
    clock = 5_000;
    releaseImport!();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1); // one import, two callers
    expect(a).toBe(b); // both resolve to the cached instance
  });

  it("parks and replaces a hung import, saying so once", async () => {
    // Fake timers: the second attempt also hangs, and its 5 s park timer
    // must fire INSIDE the test — a real timer would park (and log) after
    // the test ended, bleeding a fake hang breadcrumb into whatever test
    // runs next.
    vi.useFakeTimers();
    let clock = 0;
    let calls = 0;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => errors.push(String(msg)));
    try {
      const never = new Promise<never>(() => {});
      const loader = createRealSyntaxLoader({
        importCore: async () => {
          calls++;
          return never; // hangs forever, never rejects — so the catch can never fire
        },
        importGrammar: async () => ({}),
        now: () => clock,
      });
      const first = loader("typescript"); // first attempt starts and hangs
      clock = 4_000; // within PENDING_PARK_MS: shares the pending attempt
      const second = loader("typescript");
      expect(calls).toBe(1);
      expect(errors).toEqual([]); // no breadcrumb while the load looks alive
      clock = 6_000; // past PENDING_PARK_MS: park + one fresh attempt + breadcrumb
      void loader("typescript");
      expect(calls).toBe(2);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("still pending");
      // Parking releases the dead attempt's awaiters as null — each holds an
      // edit's content, and a never-settling import would pin them (and it)
      // for the process lifetime.
      expect(await first).toBeNull();
      expect(await second).toBeNull();
      // Parked: callers inside the window fail open instantly — no new
      // attempt, no shared wait on a possibly-dead promise.
      clock = 6_500;
      void loader("typescript");
      expect(calls).toBe(2);
      // Dispose the hanging second attempt: advance past its park timer
      // so it parks (and is released) here — and pins that the breadcrumb
      // stays once-per-language even on the timer path.
      await vi.advanceTimersByTimeAsync(PENDING_PARK_MS);
      expect(calls).toBe(2);
      expect(errors.length).toBe(1); // deduped: "pending" said it already
    } finally {
      // Restore even on assertion failure: a leaked spy would swallow
      // later tests' legitimate console.error output.
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("abandons a hung import on the clock, with no follow-up caller", async () => {
    // The caller-driven park only fires when a later edit notices the
    // staleness; without one, the awaiting frame (holding an edit's
    // content) would stay pinned until process end. The timer parks and
    // releases it regardless of later traffic.
    vi.useFakeTimers();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => errors.push(String(msg)));
    try {
      const never = new Promise<never>(() => {});
      let calls = 0;
      const loader = createRealSyntaxLoader({
        importCore: async () => {
          calls++;
          return never;
        },
        importGrammar: async () => ({}),
        now: () => 0,
      });
      const first = loader("typescript");
      await vi.advanceTimersByTimeAsync(4_999); // just inside PENDING_PARK_MS
      expect(errors).toEqual([]); // still inside the window: no park
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toBeNull(); // released without any follow-up call
      expect(calls).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("still pending");
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("caches successes and keeps languages independent", async () => {
    const imports: string[] = [];
    const loader = createRealSyntaxLoader({
      importCore: fakeCore,
      importGrammar: async (language) => {
        imports.push(language);
        return {};
      },
      now: () => 0,
    });
    const first = await loader("yaml");
    const second = await loader("yaml");
    expect(first).toBe(second); // same cached instance, one import
    expect(imports).toEqual(["yaml"]);
    expect(await loader("css")).not.toBeNull();
    expect(imports).toEqual(["yaml", "css"]); // a yaml failure does not affect css
  });
});

// ---------------------------------------------------------------------------
// Real grammars (skipped when the native deps are not installed, e.g. vendored)
// ---------------------------------------------------------------------------

// Probe every package the suite uses, not just the core: a partial native
// install (core loads, one grammar's prebuild does not) would otherwise fail
// these tests with null-deref noise instead of skipping. Direct imports, not
// the loader, so a missing package skips quietly instead of logging
// breadcrumbs through the loader's fail-open path.
// The core set is what the suite's end-to-end tests (TypeScript/TSX/JS/
// Python) actually parse; the rest gate their own tests below so a
// missing prebuild for one language skips only that language's coverage,
// not the whole suite.
const GRAMMAR_PACKAGES = ["tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python"];
// These probes run as top-level awaits during collection, where vitest's
// testTimeout cannot reach them: a HANGING native import (the exact
// failure mode the production loader parks) would block the whole file —
// including the pure fake-tree unit tests — until the outer CI timeout.
// Racing a short timer turns a hang into an ordinary skip. The timer is
// unref'd so it can never hold the process open.
const packageAvailable = async (pkg: string): Promise<boolean> =>
  Promise.race([
    import(pkg).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 2_000);
      t.unref?.();
    }),
  ]);
// All-or-nothing gating silently disarms the suite when any ONE grammar is
// missing, so availability is probed per group: the core languages (the
// only real-tree-sitter coverage of the production path) must not lose
// their tests because an unrelated new grammar failed to import.
const realAvailable = await Promise.all(GRAMMAR_PACKAGES.map(packageAvailable)).then((loaded) => loaded.every(Boolean));
const jsonAvailable = await packageAvailable("tree-sitter-json");
const goRustAvailable = await Promise.all([
  packageAvailable("tree-sitter-go"),
  packageAvailable("tree-sitter-rust"),
]).then((loaded) => loaded.every(Boolean));
const newGrammarAvailable = {
  yaml: await packageAvailable("@tree-sitter-grammars/tree-sitter-yaml"),
  html: await packageAvailable("tree-sitter-html"),
  css: await packageAvailable("tree-sitter-css"),
};
// The added-grammar tests go through createRealSyntaxLoader, which imports
// the tree-sitter core — a partial native install (core prebuild broken,
// grammar packages fine) would otherwise turn their assertions into
// TypeErrors instead of skips.
const coreAvailable = await packageAvailable("tree-sitter");
// The extension-wiring suite edits only .ts files, so it needs the core plus
// the TypeScript grammar — not the full set. A vendored copy missing one
// unrelated grammar must not lose coverage of the only production
// enablement path.
const tsAvailable = await Promise.all([
  packageAvailable("tree-sitter"),
  packageAvailable("tree-sitter-typescript"),
]).then((loaded) => loaded.every(Boolean));

describe.skipIf(!realAvailable)("superedit-syntax with real grammars", () => {
  const loader = createRealSyntaxLoader();
  const check = (
    path: string,
    content: string,
    splices: Array<{ start: number; end: number; insertLen: number }>,
    previous?: string,
  ) => runSyntaxCheck({ path, content, splices, loader, enabled: true, ...(previous ? { previous } : {}) });

  it("flags a broken TypeScript edit end-to-end via applyEdits", async () => {
    const { newContent, splices } = applyEdits(
      "const a = 1;\nconst b = 2;\n",
      [{ oldText: "const b = 2;", newText: "const b = ;" }],
      { path: "f.ts", allCap: 20 },
    );
    const warning = await check("f.ts", newContent, splices);
    expect(warning).toContain("f.ts:2:");
    expect(warning).toContain("unexpected");
  });

  it("attributes errors on the far lines of a multi-line insertion", async () => {
    // One line becomes four; the breakage sits on the last inserted line —
    // the range must cover the whole inserted block, not just its start.
    const { newContent, splices } = applyEdits(
      "const a = 1;\nconst b = 2;\n",
      [{ oldText: "const b = 2;", newText: "const b = [\n  1,\n  2\n;" }],
      { path: "f.ts", allCap: 20 },
    );
    expect(newContent).toBe("const a = 1;\nconst b = [\n  1,\n  2\n;\n");
    const warning = await check("f.ts", newContent, splices);
    expect(warning).toMatch(/f\.ts:[2-5]:/);
  });

  it("names the missing token when a delimiter is dropped", async () => {
    const { newContent, splices } = applyEdits(
      "call(one, two);\n",
      [{ oldText: "call(one, two);", newText: "call(one, two;" }],
      { path: "f.js", allCap: 20 },
    );
    const warning = await check("f.js", newContent, splices);
    expect(warning).toContain('missing ")"');
  });

  it("stays silent for a clean edit", async () => {
    const { newContent, splices } = applyEdits(
      "const a = 1;\nconst b = 2;\n",
      [{ oldText: "const b = 2;", newText: "const b = 3;" }],
      { path: "f.ts", allCap: 20 },
    );
    expect(await check("f.ts", newContent, splices)).toBeNull();
  });

  it("does not blame a pre-existing error elsewhere in the file", async () => {
    const content = "const broken = ;\n\nconst a = 1;\nconst b = 2;\nconst c = 3;\n";
    const { newContent, splices } = applyEdits(content, [{ oldText: "const b = 2;", newText: "const b = 22;" }], {
      path: "f.ts",
      allCap: 20,
    });
    expect(await check("f.ts", newContent, splices)).toBeNull();
  });

  it("does not blame a pre-existing error on the adjacent line", async () => {
    // Line 1 is already broken; the edit rewrites line 2 cleanly. The ±1
    // slack exists for zero-width MISSING tokens, so an ERROR on the
    // neighboring line must stay out of the warning.
    const content = "const broken = ;\nconst fine = 2;\n";
    const { newContent, splices } = applyEdits(content, [{ oldText: "const fine = 2;", newText: "const fine = 42;" }], {
      path: "f.ts",
      allCap: 20,
    });
    expect(await check("f.ts", newContent, splices)).toBeNull();
  });

  it.skipIf(!jsonAvailable)("stays silent for a JSONC edit under the strict JSON grammar", async () => {
    // tsconfig.json reality: comments and trailing commas are strict-JSON
    // ERRORs that predate the edit. The differential parse must suppress
    // them; warning would send the model to delete valid config.
    const previous = '{\n  // compiler options\n  "strict": true,\n}\n';
    const { newContent, splices } = applyEdits(previous, [{ oldText: '"strict": true', newText: '"strict": false' }], {
      path: "tsconfig.json",
      allCap: 60,
    });
    expect(await check("tsconfig.json", newContent, splices, previous)).toBeNull();
  });

  it.skipIf(!jsonAvailable)("warns for JSON the edit actually broke", async () => {
    const previous = '{\n  "name": "pi",\n  "version": "1.0.0"\n}\n';
    const { newContent, splices } = applyEdits(
      previous,
      [{ oldText: '"version": "1.0.0"', newText: '"version": 1.0.0' }],
      { path: "package.json", allCap: 60 },
    );
    const warning = await check("package.json", newContent, splices, previous);
    expect(warning).toContain("package.json:3:");
  });

  it("parses TSX with the tsx grammar", async () => {
    const { newContent, splices } = applyEdits(
      "const el = <div>hi</div>;\n",
      [{ oldText: "<div>hi</div>", newText: "<div>hi</div" }],
      { path: "f.tsx", allCap: 20 },
    );
    const warning = await check("f.tsx", newContent, splices);
    expect(warning).toContain("f.tsx:1:");
  });

  it("accepts broken indentation in Python (known grammar leniency, not a mangled edit)", async () => {
    const { newContent, splices } = applyEdits("x = 1\ny = 2\n", [{ oldText: "y = 2", newText: "  y = 2" }], {
      path: "f.py",
      allCap: 20,
    });
    expect(await check("f.py", newContent, splices)).toBeNull();
  });

  it("catches a genuinely broken Python edit", async () => {
    const { newContent, splices } = applyEdits("values = [1, 2]\n", [{ oldText: "[1, 2]", newText: "[1, 2" }], {
      path: "f.py",
      allCap: 20,
    });
    const warning = await check("f.py", newContent, splices);
    expect(warning).toContain("f.py:1:");
  });

  it.skipIf(!jsonAvailable || !goRustAvailable)("catches broken JSON, Go, and Rust", async () => {
    const json = applyEdits('{"a": 1}\n', [{ oldText: '"a": 1', newText: '"a": 1,' }], { path: "f.json", allCap: 20 });
    expect(await check("f.json", json.newContent, json.splices)).toContain("f.json:1:");

    const go = applyEdits("func main() {\n\tprintln(1)\n}\n", [{ oldText: "println(1)", newText: "println(1" }], {
      path: "f.go",
      allCap: 20,
    });
    expect(await check("f.go", go.newContent, go.splices)).toContain("f.go:2:");

    const rust = applyEdits("fn main() {\n    let x = 1;\n}\n", [{ oldText: "let x = 1;", newText: "let x = ;" }], {
      path: "f.rs",
      allCap: 20,
    });
    expect(await check("f.rs", rust.newContent, rust.splices)).toContain("f.rs:2:");
  });
});

// The code-unit column premise is checked against a REAL grammar under the
// narrowest gate that can still run it (core + TypeScript): the fabricated-
// tree tests construct the columns they assert, so only a real parse can
// falsify the claim that tree-sitter 0.25 reports UTF-16 units.
describe.skipIf(!tsAvailable)("superedit-syntax column semantics with a real grammar", () => {
  it("reports columns in code units on non-ASCII lines", async () => {
    // tree-sitter 0.25 native columns are UTF-16 units: the ERROR on
    // `const é = ;` starts at `=` — unit column 8, byte column 9. A byte
    // conversion here would print 1:8 instead of the correct 1:9.
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: "const é = ;\n",
      splices: [{ start: 0, end: 11, insertLen: 11 }],
      loader: createRealSyntaxLoader(),
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:9:");
  });
});

// The new languages are gated per PACKAGE: each grammar's tests skip only
// on their own availability — the yaml fork is the platform-fragile one,
// and a machine missing its prebuild must not silently drop the HTML and
// CSS coverage too.
describe.skipIf(!coreAvailable)("superedit-syntax with the added grammars", () => {
  const loader = createRealSyntaxLoader();
  const check = (
    path: string,
    content: string,
    splices: Array<{ start: number; end: number; insertLen: number }>,
    previous?: string,
  ) => runSyntaxCheck({ path, content, splices, loader, enabled: true, ...(previous ? { previous } : {}) });

  it.skipIf(!newGrammarAvailable.yaml)("parses YAML with the tree-sitter-grammars grammar", async () => {
    const clean = applyEdits(
      "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      [{ oldText: "ubuntu-latest", newText: "macos-latest" }],
      { path: "f.yaml", allCap: 60 },
    );
    expect(await check("f.yaml", clean.newContent, clean.splices)).toBeNull();
    const broken = applyEdits(
      "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      [{ oldText: "name: ci", newText: 'name: "unterminated' }],
      { path: "f.yaml", allCap: 60 },
    );
    const warning = await check("f.yaml", broken.newContent, broken.splices);
    expect(warning).toContain("f.yaml:1:");
  });

  it.skipIf(!newGrammarAvailable.yaml)("attributes an unclosed flow sequence by span, not start line", async () => {
    // Live-found shape: recovery starts the ERROR on line 1 while the
    // damage is line 2 — the edited line is INSIDE the node's span.
    const broken = applyEdits("a: 1\nb: 2\n", [{ oldText: "b: 2", newText: "b: [unclosed" }], {
      path: "f.yaml",
      allCap: 20,
    });
    const warning = await check("f.yaml", broken.newContent, broken.splices, "a: 1\nb: 2\n");
    expect(warning).toContain("f.yaml:1:"); // span start — see the span-attribution unit test
  });

  it.skipIf(!newGrammarAvailable.html)("parses HTML with the html grammar", async () => {
    // The grammar is lenient about tag mismatches; it flags unterminated
    // attribute quotes and stray close tags. Break the quote.
    const broken = applyEdits('<div class="a"><p>hi</p></div>\n', [{ oldText: 'class="a"', newText: 'class="a' }], {
      path: "f.html",
      allCap: 40,
    });
    const warning = await check("f.html", broken.newContent, broken.splices);
    expect(warning).toContain("f.html:1:");
  });

  it.skipIf(!newGrammarAvailable.css)("parses CSS with the css grammar", async () => {
    const broken = applyEdits(".card { color: red; }\n", [{ oldText: "red; }", newText: "red;" }], {
      path: "f.css",
      allCap: 40,
    });
    const warning = await check("f.css", broken.newContent, broken.splices);
    expect(warning).toContain("f.css:1:");
  });

  it.skipIf(!newGrammarAvailable.css)("reports damage the css grammar hides in a childless error leaf", async () => {
    // Live-found shape: `color: ;` recovers into a zero-width integer_value
    // whose MISSING token the native binding never yields via child() —
    // without the invisible-leaf rule this edit reports clean.
    const broken = applyEdits("a {\n  color: red;\n}\n", [{ oldText: "red", newText: "" }], {
      path: "f.css",
      allCap: 40,
    });
    const warning = await check("f.css", broken.newContent, broken.splices);
    expect(warning).toContain("f.css:2:");
    expect(warning).toContain("integer_value");
  });
});

// ---------------------------------------------------------------------------
// Extension entry — the only production wiring that turns the check on
// (the tool layer defaults it off), so it needs its own coverage.
// ---------------------------------------------------------------------------

describe.skipIf(!tsAvailable)("extensions/superedit wiring", () => {
  const ENV_KEYS = ["PI_SUPEREDIT", "PI_SUPEREDIT_SYNTAX"] as const;
  let saved: Record<string, string | undefined>;
  let dir: string;

  const makePi = () => {
    const tools = new Map<
      string,
      {
        name: string;
        execute: (
          id: string,
          input: unknown,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      }
    >();
    const pi = {
      registerTool: (t: { name: string }) => {
        tools.set(t.name, t as never);
      },
    } as unknown as ExtensionAPI;
    return { pi, tools };
  };

  const brokenEdit = { path: "app.ts", edits: [{ oldText: 'greet("world");', newText: 'greet("world";' }] };

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    dir = mkdtempSync(join(tmpdir(), "superedit-ext-"));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the edit tool and warns on a broken edit", async () => {
    delete process.env.PI_SUPEREDIT;
    delete process.env.PI_SUPEREDIT_SYNTAX;
    const { pi, tools } = makePi();
    supereditExtension(pi);
    const tool = tools.get("edit");
    expect(tool).toBeDefined();
    writeFileSync(join(dir, "app.ts"), 'function greet(n: string) {\n  return n;\n}\n\ngreet("world");\n');
    const result = await tool!.execute("1", brokenEdit, undefined, undefined, { cwd: dir } as never);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("warning:");
    expect(text).toContain("app.ts:5:");
  });

  it("reads PI_SUPEREDIT_SYNTAX per call, after registration", async () => {
    delete process.env.PI_SUPEREDIT;
    delete process.env.PI_SUPEREDIT_SYNTAX;
    const { pi, tools } = makePi();
    supereditExtension(pi);
    writeFileSync(join(dir, "app.ts"), 'function greet(n: string) {\n  return n;\n}\n\ngreet("world");\n');
    process.env.PI_SUPEREDIT_SYNTAX = "0"; // set AFTER the tool was constructed
    const result = await tools.get("edit")!.execute("1", brokenEdit, undefined, undefined, { cwd: dir } as never);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).not.toContain("warning:");
  });

  it("registers nothing when PI_SUPEREDIT=0", () => {
    process.env.PI_SUPEREDIT = "0";
    const { pi, tools } = makePi();
    supereditExtension(pi);
    expect(tools.size).toBe(0);
  });
});
