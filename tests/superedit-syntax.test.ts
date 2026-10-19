import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("0/false disable", () => {
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "0" })).toBe(false);
    expect(parseSyntaxEnabled({ PI_SUPEREDIT_SYNTAX: "FALSE" })).toBe(false);
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
  });
  it("returns null for unknown or missing extensions", () => {
    expect(languageNameForPath("a.yaml")).toBeNull();
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
    expect(collectSyntaxDiagnostics(tree, "")).toEqual({ diagnostics: [], truncated: false });
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
    expect(diagnostics[1].detail).toContain("spans lines 10–42");
  });

  it("stops collecting at the cap", () => {
    const children = Array.from({ length: 60 }, (_, i) => ERROR_NODE(i));
    const tree = fakeTree({ type: "program", hasError: true, children });
    const { diagnostics, truncated } = collectSyntaxDiagnostics(tree, "");
    expect(truncated).toBe(true);
    expect(diagnostics.length).toBe(50);
  });

  it("bounds the walk when every diagnostic is filtered out", () => {
    // Editing one line of an already-mangled file: nothing is kept, so the
    // kept cap never fires — the visited cap must still stop the walk (and
    // per-diagnostic formatting never happens for filtered nodes).
    const source = Array.from({ length: 700 }, (_, i) => `line ${i + 1}\n`).join("");
    const children = Array.from({ length: 700 }, (_, i) => ERROR_NODE(i, 0, source));
    const tree = fakeTree({ type: "program", hasError: true, children });
    const capped = collectSyntaxDiagnostics(tree, source, () => false);
    expect(capped).toEqual({ diagnostics: [], truncated: true });
    const under = collectSyntaxDiagnostics(
      fakeTree({ type: "program", hasError: true, children: children.slice(0, 400) }),
      source,
      () => false,
    );
    expect(under).toEqual({ diagnostics: [], truncated: false });
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
    expect(await runSyntaxCheck({ ...base, path: "f.yaml", enabled: true })).toBeNull();
    expect(await runSyntaxCheck({ ...base, path: "f.ts", content: "x".repeat(513_000), enabled: true })).toBeNull();
    // The bound is bytes, not UTF-16 code units: 300k astral characters are
    // 600k code units but 1.2MB of UTF-8.
    expect(await runSyntaxCheck({ ...base, path: "f.ts", content: "𝕏".repeat(300_000), enabled: true })).toBeNull();
    expect(calls).toEqual([]); // every guard above short-circuits before any load
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
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [ERROR_NODE(1, 11, "const ok = 1;\nconst val = ;\n")],
    });
    const { text, details } = await run(breakingEdit, async (language) => {
      seen.push(language);
      return { parse: (source) => (parsed.push(source), tree) };
    });
    expect(seen).toEqual(["typescript"]); // path → grammar mapping reaches the loader
    // The checker must see the POST-EDIT content: LF-normalized, no BOM.
    expect(parsed).toEqual(["const ok = 1;\nconst val = ;\n"]);
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

  it("converts byte columns to code-unit columns for display", async () => {
    // On "你好 = ;" the " = ;" span starts at byte column 6 but code-unit
    // column 2: the printed position and the excerpt must both use units.
    const source = "你好 = ;\n";
    const tree = fakeTree({
      type: "program",
      hasError: true,
      children: [{ type: "ERROR", hasError: true, start: [0, 6, 6], end: [0, 10, 10], children: [] }],
    });
    const warning = await runSyntaxCheck({
      path: "f.ts",
      content: source,
      splices: [{ start: 0, end: 8, insertLen: 8 }],
      loader: async () => fixedLanguage(tree),
      enabled: true,
    });
    expect(warning).toContain("f.ts:1:3:"); // byte col 6 → unit col 2 → printed 3
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

// ---------------------------------------------------------------------------
// Real grammars (skipped when the native deps are not installed, e.g. vendored)
// ---------------------------------------------------------------------------

// Probe every package the suite uses, not just the core: a partial native
// install (core loads, one grammar's prebuild does not) would otherwise fail
// these tests with null-deref noise instead of skipping. Direct imports, not
// the loader, so a missing package skips quietly instead of logging
// breadcrumbs through the loader's fail-open path.
const GRAMMAR_PACKAGES = [
  "tree-sitter",
  "tree-sitter-typescript",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-json",
  "tree-sitter-go",
  "tree-sitter-rust",
];
const realAvailable = await Promise.all(
  GRAMMAR_PACKAGES.map((pkg) =>
    import(pkg).then(
      () => true,
      () => false,
    ),
  ),
).then((loaded) => loaded.every(Boolean));
// The extension-wiring suite edits only .ts files, so it needs the core plus
// the TypeScript grammar — not the full set. A vendored copy missing one
// unrelated grammar must not lose coverage of the only production
// enablement path.
const tsAvailable = await Promise.all([import("tree-sitter"), import("tree-sitter-typescript")]).then(
  () => true,
  () => false,
);

describe.skipIf(!realAvailable)("superedit-syntax with real grammars", () => {
  const loader = createRealSyntaxLoader();
  const check = (path: string, content: string, splices: Array<{ start: number; end: number; insertLen: number }>) =>
    runSyntaxCheck({ path, content, splices, loader, enabled: true });

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

  it("catches broken JSON, Go, and Rust", async () => {
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
