import { describe, expect, it } from "vitest";
import type { EditOperations } from "@earendil-works/pi-coding-agent";
import {
  applyEdits,
  createSuperEditTool,
  DEFAULT_ALL_CAP,
  detectLineEnding,
  expandIndent,
  findTierMatches,
  getLines,
  normalizeToLF,
  OffsetMap,
  parseAllCap,
  parseSupereditEnabled,
  prepareEditArguments,
  restoreLineEndings,
  shiftIndent,
  splitBom,
  TABSTOP,
  type EditSpec,
} from "../lib/superedit";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CWD = "/w";

/** In-memory file store with injectable EditOperations (the house fake). */
function fakeFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: "ENOENT" });
  const ops: EditOperations = {
    readFile: async (p) => {
      const f = files.get(p);
      if (f === undefined) throw enoent(p);
      return Buffer.from(f, "utf-8");
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    access: async (p) => {
      if (!files.has(p)) throw enoent(p);
    },
  };
  return { ops, read: (p: string) => files.get(p) as string };
}

const apply = (content: string, edits: EditSpec[], allCap = DEFAULT_ALL_CAP) =>
  applyEdits(content, edits, { path: "f.rs", allCap });

/** Run a tool call against a fake store; returns the result text, details, and a read(path) accessor. Relative keys are stored at CWD. */
async function runEdit(
  files: Record<string, string>,
  input: { path: string; edits: EditSpec[] },
  opts: { allCap?: () => number } = {},
) {
  const stored = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith("/") ? k : `${CWD}/${k}`, v]));
  const fs = fakeFs(stored);
  const tool = createSuperEditTool(CWD, { operations: fs.ops, ...opts });
  const result = await tool.execute("1", input, undefined, undefined, { cwd: CWD } as never);
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return {
    text,
    details: result.details as { diff: string; notes: string[]; firstChangedLine?: number },
    read: fs.read,
  };
}

/** Run a tool call expected to fail; returns the error message. */
async function runEditError(
  files: Record<string, string>,
  input: { path: string; edits: EditSpec[] },
  opts: { allCap?: () => number } = {},
) {
  const stored = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith("/") ? k : `${CWD}/${k}`, v]));
  const fs = fakeFs(stored);
  const tool = createSuperEditTool(CWD, { operations: fs.ops, ...opts });
  try {
    await tool.execute("1", input, undefined, undefined, { cwd: CWD } as never);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the edit to fail");
}

const applyError = (content: string, edits: EditSpec[], allCap = DEFAULT_ALL_CAP): string => {
  try {
    applyEdits(content, edits, { path: "f.rs", allCap });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected applyEdits to throw");
};

// ---------------------------------------------------------------------------
// Environment knobs
// ---------------------------------------------------------------------------

describe("env parsing", () => {
  it("enables superedit by default and only disables on explicit 0/false", () => {
    expect(parseSupereditEnabled({})).toBe(true);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "" })).toBe(true);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "0" })).toBe(false);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "false" })).toBe(false);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "FALSE" })).toBe(false);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "1" })).toBe(true);
    expect(parseSupereditEnabled({ PI_SUPEREDIT: "garbage" })).toBe(true);
  });

  it("caps occurrence all at 20 by default, rejecting or clamping invalid values", () => {
    expect(parseAllCap({})).toBe(DEFAULT_ALL_CAP);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "5" })).toBe(5);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "9999" })).toBe(1000);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "0" })).toBe(DEFAULT_ALL_CAP);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "-3" })).toBe(DEFAULT_ALL_CAP);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "abc" })).toBe(DEFAULT_ALL_CAP);
    expect(parseAllCap({ PI_SUPEREDIT_ALL_CAP: "" })).toBe(DEFAULT_ALL_CAP);
  });
});

// ---------------------------------------------------------------------------
// Argument leniency
// ---------------------------------------------------------------------------

describe("prepareEditArguments", () => {
  it("parses edits sent as a JSON string (array or single object)", () => {
    const arr = prepareEditArguments({ path: "a", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) }) as {
      edits: EditSpec[];
    };
    expect(arr.edits).toEqual([{ oldText: "x", newText: "y" }]);
    const single = prepareEditArguments({ path: "a", edits: JSON.stringify({ oldText: "x", newText: "y" }) }) as {
      edits: EditSpec[];
    };
    expect(single.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("wraps a single edit object and maps legacy top-level oldText/newText", () => {
    const wrapped = prepareEditArguments({ path: "a", edits: { oldText: "x", newText: "y" } }) as { edits: EditSpec[] };
    expect(wrapped.edits).toEqual([{ oldText: "x", newText: "y" }]);
    const legacy = prepareEditArguments({ path: "a", oldText: "x", newText: "y" }) as { edits: EditSpec[] };
    expect(legacy.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  it("maps the file_path alias to path", () => {
    const fixed = prepareEditArguments({ file_path: "a", edits: [{ oldText: "x", newText: "y" }] }) as {
      path: string;
      file_path?: string;
    };
    expect(fixed.path).toBe("a");
    expect(fixed.file_path).toBeUndefined();
  });

  it("leaves invalid input for schema validation to report", () => {
    expect(prepareEditArguments("nope")).toBe("nope");
    expect(prepareEditArguments(null)).toBe(null);
    const bad = prepareEditArguments({ path: "a", edits: "{not json" }) as { edits: string };
    expect(bad.edits).toBe("{not json");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("line and normalization helpers", () => {
  it("splits lines with offsets; no phantom final empty line", () => {
    expect(getLines("a\nb\n").map((l) => l.text)).toEqual(["a", "b"]);
    expect(getLines("a\nb").map((l) => l.text)).toEqual(["a", "b"]);
    expect(getLines("").map((l) => l.text)).toEqual([""]);
    const lines = getLines("ab\ncd");
    expect(lines[0]).toMatchObject({ start: 0, end: 2, hasNewline: true });
    expect(lines[1]).toMatchObject({ start: 3, end: 5, hasNewline: false });
  });

  it("detects and restores line endings like the built-in", () => {
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n"); // first \r\n wins
    expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
    expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("splits and preserves a UTF-8 BOM", () => {
    expect(splitBom("\uFEFFlet x;")).toEqual({ bom: "\uFEFF", text: "let x;" });
    expect(splitBom("let x;")).toEqual({ bom: "", text: "let x;" });
  });

  it("expands indentation columns with tabstops", () => {
    expect(expandIndent("    x")).toBe(4);
    expect(expandIndent("\tx")).toBe(TABSTOP);
    expect(expandIndent("  \tx")).toBe(TABSTOP); // tab from column 2 lands on 4
    expect(expandIndent("\t\tx")).toBe(8);
    expect(expandIndent("x")).toBe(0);
    expect(expandIndent("")).toBe(0);
  });

  it("shifts indentation: prepend, strip, clamp, and straddle tabs", () => {
    expect(shiftIndent("x", 4)).toBe("    x");
    expect(shiftIndent("    x", -4)).toBe("x");
    expect(shiftIndent("        x", -4)).toBe("    x");
    expect(shiftIndent("  x", -4)).toBe("  x"); // shallower than the shift: unchanged
    expect(shiftIndent("\tx", -2)).toBe("  x"); // straddled tab becomes padding
    expect(shiftIndent("", 4)).toBe("");
    expect(shiftIndent("   ", 4)).toBe("   "); // blank lines carry no indent
  });
});

describe("OffsetMap", () => {
  it("is the identity before any splice", () => {
    const m = new OffsetMap(10);
    expect(m.origOf(0)).toBe(0);
    expect(m.origOf(10)).toBe(10);
    expect(m.origOf(7)).toBe(7);
  });

  it("maps around a middle splice and reports its original span", () => {
    const m = new OffsetMap(10);
    const span = m.splice(4, 2, 6); // replace [4,6) with 6 bytes
    expect(span).toEqual({ origStart: 4, origEnd: 6 });
    expect(m.origOf(3)).toBe(3); // before: unchanged
    expect(m.origOf(4)).toBe(4); // replacement boundary: exact
    expect(m.origOf(10)).toBe(6); // after: shifted back
  });

  it("tracks several sequential splices", () => {
    const m = new OffsetMap(20);
    const s1 = m.splice(0, 5, 2); // [0,5) -> 2 bytes
    const s2 = m.splice(10, 2, 4); // in post-splice coordinates
    expect(s1).toEqual({ origStart: 0, origEnd: 5 });
    expect(s2).toEqual({ origStart: 13, origEnd: 15 });
    expect(m.origOf(2)).toBe(5); // content after first replacement maps past it
  });

  it("splices at file boundaries", () => {
    const m = new OffsetMap(5);
    expect(m.splice(0, 5, 9)).toEqual({ origStart: 0, origEnd: 5 });
    expect(m.origOf(9)).toBe(5);
    const m2 = new OffsetMap(5);
    expect(m2.splice(5, 0, 0)).toEqual({ origStart: 5, origEnd: 5 });
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("findTierMatches", () => {
  it("finds exact matches in content space", () => {
    const r = findTierMatches("abcXdefXghi", "X");
    expect(r.tier).toBe("exact");
    expect(r.space).toBe("content");
    expect(r.matches.map((m) => m.start)).toEqual([3, 7]);
  });

  it("falls back to normalized space (trailing whitespace, smart punctuation)", () => {
    const r = findTierMatches("foo(bar)   \nlet \u2014dash = “quoted”;\n", 'foo(bar)\nlet -dash = "quoted";');
    expect(r.tier).toBe("normalized");
    expect(r.space).toBe("fuzzy");
    expect(r.matches).toHaveLength(1);
  });

  it("matches a uniformly dedented block on the elastic tier with the shift", () => {
    const content = "fn main() {\n    let x = 1;\n    let y = 2;\n}\n";
    const r = findTierMatches(content, "let x = 1;\nlet y = 2;");
    expect(r.tier).toBe("indent-elastic");
    expect(r.space).toBe("content");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].indentShift).toBe(4);
  });

  it("matches tab/space confusion with zero shift", () => {
    const content = "if (c) {\n\tlet x = 1;\n}\n";
    const r = findTierMatches(content, "    let x = 1;"); // 4 spaces vs 1 tab
    expect(r.tier).toBe("indent-elastic");
    expect(r.matches[0].indentShift).toBe(0);
  });

  it("refuses internally inconsistent indentation", () => {
    const content = "fn main() {\n    let a = 1;\n        let b = 2;\n    let c = 3;\n}\n";
    const r = findTierMatches(content, "let a = 1;\nlet b = 2;\nlet c = 3;");
    expect(r.tier).toBe("none");
  });

  it("never matches partial lines on the elastic tier", () => {
    const content = "    foo(\n        bar,\n    );\n";
    // A true partial line ("ar," is a fragment of "bar,") must not match, even
    // elastically — trimmed line equality is whole-line content equality.
    expect(findTierMatches(content, "ar,\n);").tier).toBe("none");
    // A whole line at a different indent (tab vs spaces) matches elastically.
    const tabbed = findTierMatches(content, "\tbar,");
    expect(tabbed.tier).toBe("indent-elastic");
    expect(tabbed.matches[0].indentShift).toBe(4);
  });

  it("returns every elastic match (ambiguity is the caller's error)", () => {
    const content = "if (a) {\n    twin(1);\n    twin(2);\n} else {\n    twin(1);\n    twin(2);\n}\n";
    const r = findTierMatches(content, "twin(1);\ntwin(2);");
    expect(r.tier).toBe("indent-elastic");
    expect(r.matches).toHaveLength(2);
  });

  it("prefers an exact byte match over an elastic twin", () => {
    const content = "\tlet x = compute(a);\nif (c) {\n    let x = compute(a);\n}\n";
    const r = findTierMatches(content, "\tlet x = compute(a);"); // tab form exists exactly on line 1
    expect(r.tier).toBe("exact");
    expect(r.matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sequential application — the str.replace semantics
// ---------------------------------------------------------------------------

describe("sequential edits", () => {
  it("applies edits in order against the evolving content", () => {
    const content = "let a = 1;\nlet b = 2;\n";
    const r = apply(content, [
      { oldText: "let a = 1;", newText: "let a = 10;" },
      { oldText: "let a = 10;\nlet b = 2;", newText: "let a = 10;\nlet b = 20;" }, // chained: sees edit 0's result
    ]);
    expect(r.newContent).toBe("let a = 10;\nlet b = 20;\n");
    expect(r.applied.map((a) => a.tier)).toEqual(["exact", "exact"]);
  });

  it("explains when an edit targets text an earlier edit rewrote", () => {
    const content = "fn main() {\n    let x = 1;\n    let y = 2;\n}\n";
    const err = applyError(content, [
      { oldText: "let x = 1;", newText: "let x = 10;" },
      { oldText: "let x = 1;\n    let y = 2;", newText: "replaced block" }, // includes rewritten context
    ]);
    expect(err).toContain("edits[1]");
    expect(err).toContain("before edits[0] was applied");
    expect(err).toContain("original lines 2–3");
    expect(err).toContain("merge this edit into edits[0]");
  });

  it("counts occurrences against the content after earlier edits", () => {
    const content = "tok\ntok\nother\n";
    const r = apply(content, [
      { oldText: "other", newText: "tok" }, // now three toks
      { oldText: "tok", newText: "TOK", occurrence: 3 },
    ]);
    expect(r.newContent).toBe("tok\ntok\nTOK\n");
  });

  it("supports the python-script shape: several disjoint fixes in one call", () => {
    const content = [
      "//! Module docs with a stale ratio claim.",
      "fn main() {",
      "    let drift = mean_abs(&p, &d);",
      '    assert!(drift > 1e-6, "bit-identical");',
      '    let ma = load_twin(&model(), gpu()).expect("load");',
      "}",
    ].join("\n");
    const r = apply(content, [
      {
        oldText: '    assert!(drift > 1e-6, "bit-identical");',
        newText: '    // the int8 noise signature is ~0.22 nats\n    assert!(drift > 0.1, "f16 baseline");',
      },
      {
        oldText: '    let ma = load_twin(&model(), gpu()).expect("load");',
        newText:
          '    let ma = load_twin(&model(), gpu()).expect("load");\n    unsafe { std::env::remove_var("W3090_A8_PREFILL") };',
      },
      { oldText: "//! Module docs with a stale ratio claim.", newText: "//! Module docs with the measured ratio." },
    ]);
    expect(r.newContent).toContain("~0.22 nats");
    expect(r.newContent).toContain('remove_var("W3090_A8_PREFILL")');
    expect(r.newContent).toContain("the measured ratio.");
    expect(r.applied).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The heredoc battery — indentation elasticity
// ---------------------------------------------------------------------------

describe("indentation-elastic matching (heredoc repair)", () => {
  const content = "fn main() {\n    let x = 1;\n    let y = 2;\n}\n";

  it("repairs a uniformly dedented block and re-indents the replacement", () => {
    const r = apply(content, [{ oldText: "let x = 1;\nlet y = 2;", newText: "let x = 10;\nlet y = 20;" }]);
    expect(r.newContent).toBe("fn main() {\n    let x = 10;\n    let y = 20;\n}\n");
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", indentShift: 4, changed: true });
  });

  it("repairs a uniformly over-indented block by dedenting the replacement", () => {
    const r = apply(content, [
      { oldText: "        let x = 1;\n        let y = 2;", newText: "        let x = 10;\n  shallow;" },
    ]);
    expect(r.newContent).toBe("fn main() {\n    let x = 10;\n  shallow;\n}\n"); // shallow line clamps, not negative
  });

  it("matches tab-indented files from space-indented oldText with no shift; newText is used as sent", () => {
    const tabbed = "if (c) {\n\tlet x = 1;\n\tlet y = 2;\n}\n";
    const r = apply(tabbed, [
      { oldText: "    let x = 1;\n    let y = 2;", newText: "    let x = 10;\n    let y = 20;" },
    ]);
    // Zero shift: the replacement keeps the sent indentation (spaces),
    // column-identical to the file's tabs — the note says how it matched.
    expect(r.newContent).toBe("if (c) {\n    let x = 10;\n    let y = 20;\n}\n");
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", indentShift: 0 });
  });

  it("computes a positive shift when the file is deeper than the sent text", () => {
    const tabbed = "if (c) {\n\tlet x = 1;\n}\n"; // tab = 4 cols
    const r = apply(tabbed, [{ oldText: "  let x = 1;", newText: "  let x = 10;" }]); // sent 2 cols
    expect(r.newContent).toBe("if (c) {\n    let x = 10;\n}\n"); // 2 + shift 2 = 4 spaces
    expect(r.applied[0].indentShift).toBe(2);
  });

  it("exempts blank lines from the shift check and pairs whitespace-only file lines", () => {
    const spaced = "fn main() {\n    let a = 1;\n   \n    let b = 2;\n}\n"; // line 2 is three spaces
    const r = apply(spaced, [{ oldText: "let a = 1;\n\nlet b = 2;", newText: "let a = 10;\n\nlet b = 20;" }]);
    // The whitespace-only file line pairs with the blank oldText line (both trim
    // empty) and is replaced by newText's blank line — the pairing itself is
    // what lets the match succeed.
    expect(r.newContent).toBe("fn main() {\n    let a = 10;\n\n    let b = 20;\n}\n");
  });

  it("handles mixed tabs and spaces per line when the column delta is uniform", () => {
    const mixed = "if (c) {\n\tlet a = 1;\n\t    let b = 2;\n}\n"; // indents: 4, 8
    const r = apply(mixed, [
      { oldText: "  let a = 1;\n      let b = 2;", newText: "  let a = 10;\n      let b = 20;" },
    ]); // 2, 6 → delta +2
    expect(r.newContent).toBe("if (c) {\n    let a = 10;\n        let b = 20;\n}\n");
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", indentShift: 2 });
  });

  it("honors a trailing newline in oldText as part of the region", () => {
    const tabbed = "a\n\tb\nc\n";
    const r = apply(tabbed, [{ oldText: "    b\n", newText: "X\n" }]); // 4 spaces vs tab, same 4 cols
    expect(r.newContent).toBe("a\nX\nc\n");
  });

  it("matches a block ending at EOF without a final newline", () => {
    const tabbed = "a\n\tb"; // no trailing newline
    const r = apply(tabbed, [{ oldText: "    b", newText: "X" }]);
    expect(r.newContent).toBe("a\nX");
  });

  it("repairs a terminal-paste shift: every line uniformly off by one column", () => {
    const pasted = [" fn main() {", "     let x = 1;", "     let y = 2;", " }"].join("\n");
    const r = apply(content, [{ oldText: pasted, newText: " fn main() {\n     let x = 10;\n     let y = 20;\n }" }]);
    expect(r.newContent).toBe("fn main() {\n    let x = 10;\n    let y = 20;\n}\n");
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", indentShift: -1 });
  });

  it("chains an elastic edit with an exact edit on its re-indented output", () => {
    const r = apply(content, [
      { oldText: "let x = 1;\nlet y = 2;", newText: "let x = 10;\nlet y = 20;" },
      { oldText: "    let y = 20;", newText: "    let y = 99;" }, // exact against edit 0's result
    ]);
    expect(r.newContent).toBe("fn main() {\n    let x = 10;\n    let y = 99;\n}\n");
  });

  it("treats a newline-only oldText as the ambiguous needle it is", () => {
    const err = applyError("a\nb\nc\n", [{ oldText: "\n", newText: "x" }]);
    expect(err).toContain("Found 3 matches");
  });

  it("accepts an explicit occurrence: 1 on a unique match", () => {
    const r = apply("solo\n", [{ oldText: "solo", newText: "duo", occurrence: 1 }]);
    expect(r.newContent).toBe("duo\n");
  });

  it("matches oldText covering the entire file", () => {
    const r = apply("whole file\n", [{ oldText: "whole file", newText: "new file" }]);
    expect(r.newContent).toBe("new file\n");
  });

  it("reports the replace-all count in the result notes", async () => {
    const { text } = await runEdit(
      { "f.rs": "parse(x)\nmid\nparse(x)\n" },
      { path: "f.rs", edits: [{ oldText: "parse(x)", newText: "parse(y)", occurrence: "all" }] },
    );
    expect(text).toContain('replaced 2 occurrences (occurrence: "all")');
  });

  it("refuses a block whose first line is partial even when the rest aligns", () => {
    const content2 = "fn main() {\n    let x = compute(\n        1,\n    );\n}\n";
    // First old line "compute(" is a partial line; elastic must not splice mid-line.
    const err = applyError(content2, [{ oldText: "compute(\n1,\n);", newText: "nope" }]);
    expect(err).toContain("Could not find");
  });

  it("lists both elastic twins instead of guessing", () => {
    // Dedented two-line blocks: no exact substring (the file's newlines are
    // followed by indentation), so the elastic tier is what finds both sites.
    const twin = "if (a) {\n    twin(1);\n    twin(2);\n} else {\n    twin(1);\n    twin(2);\n}\n";
    const err = applyError(twin, [{ oldText: "twin(1);\ntwin(2);", newText: "twin(9);" }]);
    expect(err).toContain("Found 2 matches");
    expect(err).toContain("(matched with indentation flexibility)");
    expect(err).toContain("f.rs:2");
    expect(err).toContain("f.rs:5");
    expect(err).toContain("occurrence");
  });

  it("disambiguates elastic twins with occurrence", () => {
    const twin = "if (a) {\n    twin(1);\n    twin(2);\n} else {\n    twin(1);\n    twin(2);\n}\n";
    const r = apply(twin, [{ oldText: "twin(1);\ntwin(2);", newText: "twin(1);\ntwin(9);", occurrence: 2 }]);
    expect(r.applied[0].tier).toBe("indent-elastic");
    expect(r.newContent).toBe("if (a) {\n    twin(1);\n    twin(2);\n} else {\n    twin(1);\n    twin(9);\n}\n");
  });

  it("replaces every elastic twin with occurrence all", () => {
    const twin = "if (a) {\n    twin(1);\n    twin(2);\n} else {\n    twin(1);\n    twin(2);\n}\n";
    const r = apply(twin, [{ oldText: "twin(1);\ntwin(2);", newText: "twin(1);\ntwin(9);", occurrence: "all" }]);
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", occurrences: 2 });
    expect(r.newContent).toBe("if (a) {\n    twin(1);\n    twin(9);\n} else {\n    twin(1);\n    twin(9);\n}\n");
  });

  it("reports the elasticity it applied", async () => {
    const { text } = await runEdit(
      { "f.rs": content },
      {
        path: "f.rs",
        edits: [{ oldText: "let x = 1;\nlet y = 2;", newText: "let x = 10;\nlet y = 20;" }],
      },
    );
    expect(text).toContain("Applied 1 edit to f.rs");
    expect(text).toContain("matched with indentation flexibility (shift +4)");
  });

  it("flags a no-op elastic repair that reproduces the file exactly", () => {
    // Tab/space twins at the same columns: the sent replacement is byte-identical
    // to the matched region once the zero shift is applied.
    const spaced = "        let x = 1;\n"; // 8 spaces
    const r = apply(spaced, [{ oldText: "\t\tlet x = 1;", newText: "        let x = 1;" }]); // 2 tabs = 8 cols
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", indentShift: 0, changed: false });
    expect(r.newContent).toBe(spaced);
  });
});

// ---------------------------------------------------------------------------
// The normalized tier
// ---------------------------------------------------------------------------

describe("normalized matching", () => {
  it("matches despite trailing whitespace and smart punctuation", () => {
    const content = "call(one)   \nlet x = “quoted” — dash;\n";
    const r = apply(content, [{ oldText: 'call(one)\nlet x = "quoted" - dash;', newText: "REPLACED" }]);
    expect(r.newContent).toBe("REPLACED\n");
    expect(r.applied[0].tier).toBe("normalized");
  });

  it("keeps untouched lines byte-identical", () => {
    // The model sent two trailing spaces; the file has three — normalized tier.
    const content = "keep me   \nfoo(bar)   \nalso keep\t\n";
    const r = apply(content, [{ oldText: "foo(bar)  \n", newText: "baz(qux)\n" }]);
    expect(r.newContent).toBe("keep me   \nbaz(qux)\nalso keep\t\n");
    expect(r.applied[0].tier).toBe("normalized");
  });

  it("replaces two matches on one line with occurrence all (exact tier)", () => {
    const content = "foo  ; foo  ;\n";
    const r = apply(content, [{ oldText: "foo ", newText: "STOP", occurrence: "all" }]);
    expect(r.newContent).toBe("STOP ; STOP ;\n");
  });

  it("handles a mid-line normalized match with NBSP", () => {
    const content = "let x = f(a\u00A0b);\n";
    const r = apply(content, [{ oldText: "f(a b)", newText: "g()" }]);
    expect(r.newContent).toBe("let x = g();\n");
    expect(r.applied[0].tier).toBe("normalized");
  });

  it("rebuilds multi-line groups when newText adds lines", () => {
    const content = "a\nSMUDGE   \nb\nc\n"; // 3 trailing spaces; 2 sent → normalized tier
    const r = apply(content, [{ oldText: "SMUDGE  \n", newText: "one\ntwo\n" }]);
    expect(r.newContent).toBe("a\none\ntwo\nb\nc\n");
  });
});

// ---------------------------------------------------------------------------
// Duplicates and occurrence
// ---------------------------------------------------------------------------

describe("duplicate matches and occurrence", () => {
  const trip = "head\nparse(x)\nmid\nparse(x)\ntail\nparse(x)\nend\n";

  it("lists every location when oldText is not unique", () => {
    const err = applyError(trip, [{ oldText: "parse(x)", newText: "parse(y)" }]);
    expect(err).toContain("Found 3 matches");
    expect(err).toContain("f.rs:2");
    expect(err).toContain("f.rs:4");
    expect(err).toContain("f.rs:6");
    expect(err).toContain("occurrence: N (1-based, in file order)");
    expect(err).toContain('occurrence: "all"');
  });

  it("replaces the chosen occurrence", () => {
    const r = apply(trip, [{ oldText: "parse(x)", newText: "parse(y)", occurrence: 2 }]);
    expect(r.newContent).toBe("head\nparse(x)\nmid\nparse(y)\ntail\nparse(x)\nend\n");
  });

  it("replaces every occurrence with all, and reports the count", async () => {
    const r = apply(trip, [{ oldText: "parse(x)", newText: "parse(y)", occurrence: "all" }]);
    expect(r.newContent).toBe("head\nparse(y)\nmid\nparse(y)\ntail\nparse(y)\nend\n");
    expect(r.applied[0].occurrences).toBe(3);
  });

  it("refuses replace-all over the cap", () => {
    const many = Array.from({ length: 25 }, (_, i) => `x = ${i};`).join("\n") + "\n";
    const err = applyError(many, [{ oldText: "x = ", newText: "y = ", occurrence: "all" }], 20);
    expect(err).toContain("would replace 25 locations");
    expect(err).toContain("cap: 20");
    expect(err).toContain("too generic");
  });

  it("rejects an occurrence index past the match count, listing sites", () => {
    const err = applyError(trip, [{ oldText: "parse(x)", newText: "parse(y)", occurrence: 5 }]);
    expect(err).toContain("requests occurrence: 5, but only 3 match(es) exist");
    expect(err).toContain("f.rs:2, f.rs:4, f.rs:6");
  });

  it("rejects invalid occurrence values", () => {
    expect(applyError("a\n", [{ oldText: "a", newText: "b", occurrence: 0 }])).toContain("positive integer");
    expect(applyError("a\n", [{ oldText: "a", newText: "b", occurrence: 1.5 }])).toContain("positive integer");
    expect(applyError("a\n", [{ oldText: "a", newText: "b", occurrence: -2 }])).toContain("positive integer");
  });

  it("treats a whitespace-only oldText as not-found, never as phantom matches", () => {
    // Whitespace-only needles — with or without newlines — normalize to empty
    // or newline-only fuzzy needles; indexOf would spin out phantom zero-length
    // matches, and a bare "\n" would match every line break. None of these may
    // produce a match, let alone an insert at offset 0.
    for (const bad of ["\t", "  ", "  \n", "\t\n", " \n ", "\n\n\n"]) {
      const err = applyError("abcdef\n", [{ oldText: bad, newText: "X" }]);
      expect(err, `oldText ${JSON.stringify(bad)}`).toContain("Could not find");
    }
    const errAll = applyError("abcdef\n", [{ oldText: "  \n", newText: "X", occurrence: "all" }]);
    expect(errAll).toContain("Could not find");
    expect(errAll).toContain("no region looks similar");
  });

  it("still honors a byte-exact whitespace-only line as oldText", () => {
    // A whitespace line that exists verbatim is a legitimate exact match; only
    // the forgiving tiers refuse whitespace-only needles.
    const r = apply("a\n   \nb", [{ oldText: "   \n", newText: "REPL\n" }]);
    expect(r.newContent).toBe("a\nREPL\nb");
    expect(r.applied[0].tier).toBe("exact");
  });

  it("reports truncated match collections as lower bounds and refuses replace-all past the cap", () => {
    const many = Array.from({ length: 1500 }, () => "a").join("\n") + "\n";
    // Without occurrence: the multi-match error marks the count as truncated.
    const err = applyError(many, [{ oldText: "a", newText: "b" }]);
    expect(err).toContain("Found 1001+ matches");
    // With occurrence: "all" past the cap: refuse instead of partially rewriting.
    const errAll = applyError(many, [{ oldText: "a", newText: "b", occurrence: "all" }], 1000);
    expect(errAll).toContain("would replace 1001+ locations");
    // An occurrence index past the truncated collection is still out of range.
    const errIdx = applyError(many, [{ oldText: "a", newText: "b", occurrence: 1002 }]);
    expect(errIdx).toContain("only 1001+");
  });

  it("replaces all sites when the count exactly meets the cap (no false truncation)", () => {
    const exactly = Array.from({ length: 1000 }, () => "a").join("\n") + "\n";
    const r = apply(exactly, [{ oldText: "a", newText: "b", occurrence: "all" }], 1000);
    expect(r.applied[0].occurrences).toBe(1000);
    expect(r.newContent).toBe(Array.from({ length: 1000 }, () => "b").join("\n") + "\n");
    // Exactly MAX_COLLECTED (1001) is also not flagged as truncated: the probe
    // looks one past the ceiling, so the count prints without a "+".
    const exactCeiling = Array.from({ length: 1001 }, () => "a").join("\n") + "\n";
    const errCeil = applyError(exactCeiling, [{ oldText: "a", newText: "b" }]);
    expect(errCeil).toContain("Found 1001 matches");
    expect(errCeil).not.toContain("1001+");
    const rCeil = apply(exactCeiling, [{ oldText: "a", newText: "b", occurrence: "all" }], 1001);
    expect(rCeil.applied[0].occurrences).toBe(1001);
  });

  it("does not flag exactly MAX_COLLECTED elastic matches as truncated", () => {
    // "\ta" matches every "    a" line elastically (tab vs 4 spaces, shift 0).
    const exactly = "    a\n".repeat(1001);
    const err = applyError(exactly, [{ oldText: "\ta", newText: "b" }]);
    expect(err).toContain("Found 1001 matches");
    expect(err).not.toContain("1001+");
    const oneMore = applyError("    a\n".repeat(1002), [{ oldText: "\ta", newText: "b" }]);
    expect(oneMore).toContain("Found 1001+ matches");
  });

  it("refuses replace-all when elastic windows overlap instead of dropping sites", () => {
    // "foo\nfoo" slides: windows (lines 1–2) and (2–3) overlap at line 2.
    const tiled = "    foo\n    foo\n    foo\n";
    const err = applyError(tiled, [{ oldText: "foo\nfoo", newText: "bar", occurrence: "all" }]);
    expect(err).toContain("overlap");
    expect(err).toContain("f.rs:1");
    expect(err).toContain("f.rs:2");
    expect(err).toContain('occurrence: "all" cannot replace every site');
    // Three tiled windows, middle one dropped: the message must name the
    // conflicting pair (1–2 vs 2–3), never the same site twice.
    const tiled4 = "    a\n    a\n    a\n    a\n";
    const err4 = applyError(tiled4, [{ oldText: "a\na", newText: "b", occurrence: "all" }]);
    expect(err4).toContain("its 3 matches overlap (f.rs:1–2 and f.rs:2–3)");
    expect(err4).not.toContain("f.rs:3–4 and f.rs:3–4");
    // A single occurrence index stays well-defined on the same content.
    const r = apply(tiled, [{ oldText: "foo\nfoo", newText: "bar", occurrence: 2 }]);
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", occurrences: 1 });
    expect(r.newContent).toBe("    foo\n    bar\n");
  });

  it("caps the number of listed sites", () => {
    const many = Array.from({ length: 8 }, () => "dup").join("\n") + "\n";
    const err = applyError(many, [{ oldText: "dup", newText: "x" }]);
    expect(err).toContain("Found 8 matches");
    expect(err).toContain("…and 3 more");
  });
});

// ---------------------------------------------------------------------------
// Not-found diagnostics
// ---------------------------------------------------------------------------

describe("not-found diagnostics", () => {
  const content = [
    "fn main() {",
    "    let drift = mean_abs(&p, &d);",
    "    assert!(",
    "        drift > 1e-6,",
    '        "bit-identical"',
    "    );",
    "}",
    "",
    "fn other() {",
    "    let z = 0;",
    "}",
  ].join("\n");

  it("reports the closest region as a diff with real line numbers", () => {
    // Two of three lines match exactly (above the anchor threshold), one drifted.
    const err = applyError(content, [
      { oldText: "    let drift = mean_abs(&p, &d);\n    assert!(\n        drift > 2e-6,", newText: "x" },
    ]);
    expect(err).toContain("Closest region: lines 2–4 (2 of 3 lines match)");
    expect(err).toContain('"-" is your oldText, "+" is the file');
    expect(err).toContain("let drift = mean_abs(&p, &d);");
    expect(err).toContain("drift > 2e-6,");
    expect(err).toContain("drift > 1e-6,");
  });

  it("flags non-uniform indentation as the specific near-miss", () => {
    const mixed = "fn main() {\n    let a = 1;\n        let b = 2;\n    let c = 3;\n}\n";
    const err = applyError(mixed, [{ oldText: "let a = 1;\nlet b = 2;\nlet c = 3;", newText: "x" }]);
    expect(err).toContain("lines 2–4 match modulo indentation and the shift is not uniform");
    expect(err).toContain("line 3: file 8 cols, you sent 0 cols (shift +8)");
    expect(err).toContain("← breaks the uniform shift");
    expect(err).toContain("Read f.rs around line 2");
  });

  it("locates typo'd text by similarity when no line matches exactly", () => {
    const err = applyError(content, [{ oldText: "let drfit = mean_abs(&p, &d);", newText: "x" }]);
    expect(err).toContain("found by fuzzy similarity");
    expect(err).toContain("let drfit = mean_abs(&p, &d);");
    expect(err).toContain("let drift = mean_abs(&p, &d);");
  });

  it("notes tab-vs-space confusion in the closest region", () => {
    const tabbed = 'fn main() {\n\tassert!(x > 1e-6, "m");\n}\n';
    const err = applyError(tabbed, [{ oldText: '    assert!(x > 1e-5, "m");', newText: "x" }]);
    expect(err).toContain("Closest region");
    expect(err).toContain("file uses tabs, you sent spaces");
  });

  it("says when the flexible search was cut short on massively repetitive input", () => {
    // Every window fails the uniform-shift check (alternating 0/2 sent indent
    // against uniform 1 in the file), so the elastic search burns its budget
    // without a match and must say so instead of claiming nothing is similar.
    const content = " x\n".repeat(30_000);
    const oldText = "x\n  x\n".repeat(50);
    const err = applyError(content, [{ oldText, newText: "y" }]);
    expect(err).toContain("cut short");
    expect(err).toContain("too large or oldText too repetitive");
    expect(err).toContain("Narrow oldText");
  });

  it("still matches elastically in a large non-repetitive file (size must not eat the window budget)", () => {
    // The position scan is one pass over the file; a per-distinct-key rescan
    // would cost ~100 x 30_000 > MAX_VERIFY_COMPARISONS and refuse this edit
    // with a bogus "too repetitive" diagnosis.
    const lines: string[] = [];
    for (let i = 0; i < 15_000; i++) lines.push(`filler ${i}`);
    for (let i = 0; i < 100; i++) lines.push(`    uniq deep ${i}`);
    for (let i = 0; i < 15_000; i++) lines.push(`trailer ${i}`);
    const content = lines.join("\n") + "\n";
    // Dedented (0-indent) oldText against the 4-space block in the file.
    const oldText = Array.from({ length: 100 }, (_, i) => `uniq deep ${i}`).join("\n");
    const r = apply(content, [{ oldText, newText: "gone" }]);
    expect(r.applied[0]).toMatchObject({ tier: "indent-elastic", occurrences: 1, indentShift: 4 });
    expect(r.newContent).not.toContain("uniq deep 0");
    expect(r.newContent).toContain("    gone");
  });

  it("says so honestly when nothing looks similar", () => {
    const err = applyError("a\nb\nc\n", [{ oldText: "completely unrelated text\non multiple lines", newText: "x" }]);
    expect(err).toContain("no region looks similar");
    expect(err).toContain("file has 3 lines");
  });

  it("points at the file line containing a drifted sentence (dice alone collapses on length skew)", () => {
    const long =
      "BOM and line endings round-trip exactly like the built-in. The whole search runs under one comparison budget, so neither a huge nor a massively repetitive file can wedge it.";
    const content = `# intro\n${long}\n# outro\n`;
    // One word changed ("precisely" for "exactly") inside a 170-char line:
    // oldText is 59 chars, so dice maxes near 0.25 — containment carries it.
    const oldText = "BOM and line endings round-trip precisely like the built-in.";
    const err = applyError(content, [{ oldText, newText: "x" }]);
    expect(err).toContain("Closest region (found by fuzzy similarity): lines 2–2");
    expect(err).toContain("precisely like the built-in");
    expect(err).toContain("check the diff above for typos or drifted text");
  });

  it("stays honest for oldText longer than the file", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const err = applyError("tiny\n", [{ oldText: long, newText: "x" }]);
    expect(err).toContain("no region looks similar");
  });

  it("caps the diagnostic size for huge blocks", () => {
    const big = Array.from({ length: 120 }, (_, i) => `unique${i}`).join("\n");
    const drifted = big.replace("unique60", "drifted60");
    const err = applyError(drifted, [{ oldText: big, newText: "x" }]);
    const lineCount = err.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(60);
    expect(err).toContain("…");
  });

  it("names edits[i] in multi-edit calls and 'the text' in single-edit calls", () => {
    expect(applyError("a\n", [{ oldText: "nope", newText: "x" }])).toContain("the text");
    expect(
      applyError("a\n", [
        { oldText: "a", newText: "b" },
        { oldText: "nope", newText: "x" },
      ]),
    ).toContain("edits[1]");
  });
});

// ---------------------------------------------------------------------------
// Validation and no-ops
// ---------------------------------------------------------------------------

describe("validation and no-ops", () => {
  it("rejects empty oldText with the insert idiom", () => {
    const err = applyError("a\n", [{ oldText: "", newText: "b" }]);
    expect(err).toContain("oldText is empty");
    expect(err).toContain("include the surrounding lines in oldText");
  });

  it("rejects identical oldText and newText", () => {
    expect(applyError("a\n", [{ oldText: "a", newText: "a" }])).toContain("identical");
  });

  it("errors when the whole call produces no change", async () => {
    // Tab/space twins at the same columns: the elastic repair lands on the
    // file's existing bytes, so nothing changes.
    const err = await runEditError(
      { "f.rs": "        let x = 1;\n" },
      { path: "f.rs", edits: [{ oldText: "\t\tlet x = 1;", newText: "        let x = 1;" }] },
    );
    expect(err).toContain("No changes made to f.rs");
    expect(err).toContain("reproduced the existing text exactly");
  });

  it("rejects invalid tool input shapes", async () => {
    const fs = fakeFs({ "f.rs": "a\n" });
    const tool = createSuperEditTool(CWD, { operations: fs.ops });
    await expect(
      tool.execute("1", { path: "", edits: [{ oldText: "a", newText: "b" }] } as never, undefined, undefined, {
        cwd: CWD,
      } as never),
    ).rejects.toThrow("path must be a non-empty string");
    await expect(
      tool.execute("1", { path: "f.rs", edits: [] } as never, undefined, undefined, { cwd: CWD } as never),
    ).rejects.toThrow("at least one replacement");
    await expect(
      tool.execute(
        "1",
        { path: "f.rs", edits: [{ oldText: "a", newText: "b", occurrence: "many" }] } as never,
        undefined,
        undefined,
        {
          cwd: CWD,
        } as never,
      ),
    ).rejects.toThrow('occurrence must be a positive integer or "all"');
  });
});

// ---------------------------------------------------------------------------
// Tool-level behavior: files, BOM, line endings, abort, atomicity
// ---------------------------------------------------------------------------

describe("the edit tool", () => {
  it("replaces pi's built-in by name and documents the semantics", () => {
    const tool = createSuperEditTool(CWD, { operations: fakeFs({}).ops });
    expect(tool.name).toBe("edit");
    expect(tool.description).toContain("apply in order");
    expect(tool.description).toContain("occurrence");
    expect(tool.promptGuidelines?.join(" ")).toContain("Never rewrite files through a shell script");
  });

  it("applies an edit and returns a diff in details", async () => {
    const { text, details, read } = await runEdit(
      { "f.rs": "let x = 1;\n" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;", newText: "let x = 2;" }] },
    );
    expect(read("/w/f.rs")).toBe("let x = 2;\n");
    expect(text).toBe("Applied 1 edit to f.rs.");
    expect(details.diff).toContain("+1 let x = 2");
    expect(details.diff).toContain("-1 let x = 1");
    expect(details.firstChangedLine).toBe(1);
  });

  it("resolves relative paths against ctx.cwd", async () => {
    const fs = fakeFs({ "/elsewhere/f.rs": "a\n" });
    const tool = createSuperEditTool(CWD, { operations: fs.ops });
    await tool.execute("1", { path: "f.rs", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, {
      cwd: "/elsewhere",
    } as never);
    expect(fs.read("/elsewhere/f.rs")).toBe("b\n");
  });

  it("maps a write failure to the tool's own words and warns about partial state", async () => {
    const fs = fakeFs({ "/w/f.rs": "a\n" });
    const ops: EditOperations = {
      ...fs.ops,
      writeFile: async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      },
    };
    const tool = createSuperEditTool(CWD, { operations: ops });
    await expect(
      tool.execute("1", { path: "f.rs", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, {
        cwd: CWD,
      } as never),
    ).rejects.toThrow("Could not write file: f.rs. Error code: ENOSPC");
    await expect(
      tool.execute("1", { path: "f.rs", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, {
        cwd: CWD,
      } as never),
    ).rejects.toThrow("may be unchanged or partially written");
  });

  it("maps a read failure after the access probe to the tool's own words", async () => {
    // A directory passes R_OK|W_OK but fails the read with EISDIR.
    const fs = fakeFs({});
    const ops: EditOperations = {
      ...fs.ops,
      access: async () => {},
      readFile: async () => {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
      },
    };
    const tool = createSuperEditTool(CWD, { operations: ops });
    await expect(
      tool.execute("1", { path: "somedir", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, {
        cwd: CWD,
      } as never),
    ).rejects.toThrow("Could not read file: somedir. Error code: EISDIR");
  });

  it("suggests write for a missing file", async () => {
    const err = await runEditError({}, { path: "new.rs", edits: [{ oldText: "a", newText: "b" }] });
    expect(err).toContain("file not found");
    expect(err).toContain("use write to create it first");
  });

  it("preserves a UTF-8 BOM on write", async () => {
    const { read } = await runEdit(
      { "f.rs": "\uFEFFlet x = 1;\n" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;", newText: "let x = 2;" }] },
    );
    expect(read("/w/f.rs").charCodeAt(0)).toBe(0xfeff);
    expect(read("/w/f.rs")).toBe("\uFEFFlet x = 2;\n");
  });

  it("preserves BOM and CRLF together", async () => {
    const { read } = await runEdit(
      { "f.rs": "\uFEFFlet x = 1;\r\n" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;", newText: "let x = 2;" }] },
    );
    expect(read("/w/f.rs")).toBe("\uFEFFlet x = 2;\r\n");
  });

  it("round-trips CRLF files and accepts CRLF oldText", async () => {
    const { read } = await runEdit(
      { "f.rs": "let x = 1;\r\nlet y = 2;\r\n" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;\r\n", newText: "let x = 10;\r\n" }] },
    );
    expect(read("/w/f.rs")).toBe("let x = 10;\r\nlet y = 2;\r\n");
  });

  it("normalizes lone CRs to LF (documented built-in behavior)", async () => {
    const { read } = await runEdit(
      { "f.rs": "let x = 1;\rlet y = 2;\r" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;", newText: "let x = 10;" }] },
    );
    expect(read("/w/f.rs")).toBe("let x = 10;\nlet y = 2;\n");
  });

  it("restores the dominant ending for mixed files", async () => {
    const { read } = await runEdit(
      { "f.rs": "let x = 1;\r\nlet y = 2;\n" },
      { path: "f.rs", edits: [{ oldText: "let x = 1;", newText: "let x = 10;" }] },
    );
    expect(read("/w/f.rs")).toBe("let x = 10;\r\nlet y = 2;\r\n");
  });

  it("writes nothing when any edit fails (all-or-nothing)", async () => {
    const fs = fakeFs({ "/w/f.rs": "let x = 1;\n" });
    const tool = createSuperEditTool(CWD, { operations: fs.ops });
    await expect(
      tool.execute(
        "1",
        {
          path: "f.rs",
          edits: [
            { oldText: "let x = 1;", newText: "let x = 10;" },
            { oldText: "absent", newText: "z" },
          ],
        },
        undefined,
        undefined,
        { cwd: CWD } as never,
      ),
    ).rejects.toThrow("Could not find");
    // The passing first edit must not have reached the disk.
    expect(fs.read("/w/f.rs")).toBe("let x = 1;\n");
  });

  it("fails fast on an aborted signal", async () => {
    const fs = fakeFs({ "f.rs": "a\n" });
    const tool = createSuperEditTool(CWD, { operations: fs.ops });
    const ac = new AbortController();
    ac.abort();
    await expect(
      tool.execute("1", { path: "f.rs", edits: [{ oldText: "a", newText: "b" }] }, ac.signal, undefined, {
        cwd: CWD,
      } as never),
    ).rejects.toThrow("Operation aborted");
  });

  it("reads the occurrence-all cap per call", async () => {
    const many = Array.from({ length: 25 }, () => "dup").join("\n") + "\n";
    const err = await runEditError(
      { "f.rs": many },
      { path: "f.rs", edits: [{ oldText: "dup", newText: "x", occurrence: "all" }] },
      { allCap: () => 3 },
    );
    expect(err).toContain("cap: 3");
  });
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

describe("renderers", () => {
  const theme = {
    fg: (k: string, t: string) => `[${k}]${t}`,
    bold: (t: string) => `*${t}*`,
    inverse: (t: string) => t,
  } as never;
  const render = (c: unknown): string => (c as { render(width: number): string[] }).render(200).join("\n");

  it("renders the call title with the path, tolerating partial args", () => {
    const tool = createSuperEditTool(CWD, { operations: fakeFs({}).ops });
    const full = render(
      (tool.renderCall as (a: unknown, t: never, c: never) => unknown)({ path: "src/a.rs" }, theme, {} as never),
    );
    expect(full).toContain("[toolTitle]*edit* src/a.rs");
    const partial = render((tool.renderCall as (a: unknown, t: never, c: never) => unknown)({}, theme, {} as never));
    expect(partial).toContain("*edit*");
  });

  it("colors the diff on success and the message on error", () => {
    const tool = createSuperEditTool(CWD, { operations: fakeFs({}).ops });
    const ok = render(
      (tool.renderResult as (r: unknown, o: never, t: never, c: never) => unknown)(
        { content: [{ type: "text", text: "Applied 1 edit to f.rs." }], details: { diff: "+1 new\n-1 old\n 2 ctx" } },
        { expanded: false, isPartial: false } as never,
        theme,
        { isError: false } as never,
      ),
    );
    expect(ok).toContain("[muted]Applied 1 edit to f.rs.");
    expect(ok).toContain("[toolDiffAdded]+1 new");
    expect(ok).toContain("[toolDiffRemoved]-1 old");
    expect(ok).toContain("[toolDiffContext] 2 ctx");
    const bad = render(
      (tool.renderResult as (r: unknown, o: never, t: never, c: never) => unknown)(
        { content: [{ type: "text", text: "Could not find the text" }], details: {} },
        { expanded: false, isPartial: false } as never,
        theme,
        { isError: true } as never,
      ),
    );
    expect(bad).toContain("[error]Could not find the text");
  });
});
