import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { EventEmitter } from "node:events";
import { EventEmitter as EE } from "node:events";
import { describe, expect, it } from "vitest";
import {
  applyVerdicts,
  chunkDiffFiles,
  collectGuidelines,
  extractReviewGuidelines,
  GUIDELINES_MAX_CHARS,
  type Finding,
  finderAgent,
  finderTask,
  fitTask,
  foreignCheckAllowed,
  hunkRanges,
  isExcludedPath,
  mergeFindings,
  mergeRanges,
  parseFindings,
  parseReviewArgs,
  registerReview,
  renderAttachments,
  resolveInvocation,
  resolveReviewCwd,
  selectAttachments,
  sliceAttachment,
  summarizeForTool,
  symlinkFree,
  parseReviewConfig,
  parseVerdicts,
  planFinderRuns,
  renderReport,
  runReview,
  type ReviewConfig,
  splitDiffFiles,
  syntheticNewFileDiff,
  trackedSpawn,
  truncateUtf8Bytes,
  verifyAgent,
  verifyTask,
  type Verdict,
  walkTree,
  MANY_ENTRIES,
  withStallRetry,
  FINDER_LENSES,
} from "../extensions/review";
import type { ChildLike, ChildRun, ChildUsage, SpawnFn } from "../extensions/subagents";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-old",
  "+new",
  "+added",
  " context",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -10,3 +10,3 @@",
  " context",
  "-b-old",
  "+b-new",
].join("\n");

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "src/a.ts",
  line: 2,
  severity: "important",
  title: "Off-by-one in loop bound",
  detail: "The loop exits one iteration early.",
  recommendation: "Use <=.",
  lenses: ["correctness"],
  ...over,
});

const CONFIG = (over: Partial<ReviewConfig> = {}): ReviewConfig => ({
  chunkChars: 96_000,
  attachChars: 64_000,
  maxChildren: 8,
  concurrency: 8,
  timeoutMs: 60_000,
  idleTimeoutMs: 300_000,
  model: undefined,
  verifyModel: undefined,
  checkCmd: "",
  verify: true,
  maxFindings: 25,
  priorChars: 8_000,
  persist: false,
  untrackedMaxBytes: 256 * 1024,
  ...over,
});

/** Fake pi child that routes by task text: respond(task) -> final message. */
function fakeSpawn(
  respond: (task: string) => string,
  opts: { failVerify?: boolean } = {},
): SpawnFn & { tasks: string[] } {
  const tasks: string[] = [];
  const fn = ((_command: string, args: string[], _options: unknown) => {
    const dash = args.lastIndexOf("--");
    const task = dash >= 0 ? String(args[dash + 1]) : "";
    tasks.push(task);
    const isVerify = task.startsWith("# Verify code-review findings");
    const text = isVerify && opts.failVerify ? "verifier says no" : respond(task);
    return childWithMessage(text, isVerify && opts.failVerify ? 1 : 0);
  }) as SpawnFn & { tasks: string[] };
  fn.tasks = tasks;
  return fn;
}

function childWithMessage(text: string, exitCode = 0): ChildLike {
  const child = new EE() as unknown as { stdout: EE; stderr: EE } & EventEmitter;
  const stdout = new EE();
  const stderr = new EE();
  (child as unknown as { stdout: EE; stderr: EE }).stdout = stdout;
  (child as unknown as { stdout: EE; stderr: EE }).stderr = stderr;
  const line = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  queueMicrotask(() => {
    stdout.emit("data", Buffer.from(`${line}\n`));
    child.emit("close", exitCode);
  });
  return child as unknown as ChildLike;
}

/** A child that never emits stdout and exits only when killed — the shape of a
 * dead LLM request, for exercising the idle watchdog end to end. */
function silentChild(): ChildLike {
  const child = new EE() as unknown as { stdout: EE; stderr: EE } & EventEmitter;
  (child as unknown as { stdout: EE; stderr: EE }).stdout = new EE();
  (child as unknown as { stdout: EE; stderr: EE }).stderr = new EE();
  (child as unknown as { kill: (sig?: string) => void }).kill = () => queueMicrotask(() => child.emit("close", null));
  return child as unknown as ChildLike;
}

/** Spawn fake whose matching children emit nothing until killed (dead
 * requests); shouldStall sees the task text and its 1-based attempt number. */
function spawnWithStalls(
  shouldStall: (task: string, attempt: number) => boolean,
  respond: (task: string) => string,
): SpawnFn & { tasks: string[] } {
  const counts = new Map<string, number>();
  const tasks: string[] = [];
  const fn = ((_command: string, args: string[], _options: unknown) => {
    const dash = args.lastIndexOf("--");
    const task = dash >= 0 ? String(args[dash + 1]) : "";
    tasks.push(task);
    const attempt = (counts.get(task) ?? 0) + 1;
    counts.set(task, attempt);
    if (shouldStall(task, attempt)) return silentChild();
    return childWithMessage(respond(task));
  }) as SpawnFn & { tasks: string[] };
  fn.tasks = tasks;
  return fn;
}

const emptyDeps = (over: Record<string, unknown> = {}) => ({
  git: async () => ({ code: 1, stdout: "", stderr: "" }),
  shell: async () => null,
  readFile: async () => undefined,
  writeFile: async () => {},
  notify: () => {},
  spawnFn: fakeSpawn(() => "[]"),
  sessionModel: null,
  now: () => 1_000,
  ...over,
});

/** Production-shaped reader for tests with real files on disk: returns what
 * exists, undefined otherwise — the boundary fake must not invent content for
 * paths the guard refused (or the refusal would be unobservable). */
const realReadFile = async (p: string): Promise<string | undefined> => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

describe("attachments", () => {
  it("selects whole files smallest-first under the budget, naming the rest", () => {
    const sel = selectAttachments(
      [
        { path: "big.ts", size: 50_000 },
        { path: "a.ts", size: 2_000 },
        { path: "b.ts", size: 3_000 },
      ],
      4_000,
    );
    expect(sel.attached).toEqual(["a.ts"]); // whole small file first
    expect(sel.skipped).toEqual(["b.ts", "big.ts"]); // neither fits the remainder
  });

  it("renders contents as reference material and names over-budget files", () => {
    const text = renderAttachments([{ path: "src/a.ts", content: "const A = 1;" }], ["gen/huge.ts"]);
    expect(text).toContain("## Current contents of the changed files");
    expect(text).toContain("before reaching for tools");
    expect(text).toContain("### src/a.ts\nconst A = 1;");
    expect(text).toContain("read them if needed): gen/huge.ts");
  });

  it("parses hunk ranges including single-line and pure-deletion hunks", () => {
    const ranges = hunkRanges(
      ["@@ -1,3 +1,4 @@", " ctx", "@@ -10,1 +9,0 @@", "-gone", "@@ -20 +21 @@", "+solo"].join("\n"),
    );
    expect(ranges).toEqual([
      { start: 1, end: 4 },
      { start: 9, end: 9 }, // zero-count deletion still anchors a window
      { start: 21, end: 21 }, // count-less header is a single line
    ]);
  });

  it("widens, clamps, and merges overlapping ranges", () => {
    const merged = mergeRanges(
      [
        { start: 100, end: 110 },
        { start: 50, end: 60 },
        { start: 95, end: 96 },
      ],
      40,
      200,
    );
    expect(merged).toEqual([{ start: 10, end: 150 }]); // 50-60 and 95-110 windows overlap
  });

  it("slices hunk windows from large files and whole files from small ones", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const windowed = sliceAttachment(big, [{ start: 100, end: 105 }]);
    expect(windowed?.label).toBe("lines 60-145");
    expect(windowed?.content).toContain("line 100");
    expect(windowed?.content).not.toContain("\nline 10\n"); // outside the window (newline-anchored: "line 100" is inside)

    // Two distant hunks: two windows, with the elided span marked between.
    const huge = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const split = sliceAttachment(huge, [
      { start: 20, end: 25 },
      { start: 300, end: 305 },
    ]);
    expect(split?.label).toBe("lines 1-65; lines 260-345");
    expect(split?.content).toContain("…");
    expect(split?.content).toContain("\nline 302\n");
    expect(split?.content).not.toContain("\nline 200\n"); // between the windows

    const small = sliceAttachment("a\nb\nc", [{ start: 2, end: 2 }]);
    expect(small).toEqual({ label: "whole file", content: "a\nb\nc" });

    expect(sliceAttachment("a\nb", [])).toBeNull(); // nothing to anchor on
  });

  it("reports per-finder progress as the wave completes, and failures are named", async () => {
    const notes: Array<{ message: string; level: string }> = [];
    // Security lens exits nonzero: its completion line must say failed, not done.
    const spawn = ((_c: string, args: string[], _o: unknown) => {
      const task = String(args[args.lastIndexOf("--") + 1] ?? "");
      return childWithMessage("[]", task.includes("Code review: Security") ? 1 : 0);
    }) as SpawnFn;
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git,
        spawnFn: spawn,
        notify: (message: string, level: "info" | "warning" | "error") => notes.push({ message, level }),
      }) as never,
    });
    const done = notes.filter((n) => /finder \S+ done \(/.test(n.message));
    const failed = notes.filter((n) => /finder \S+ failed \(/.test(n.message));
    expect(done).toHaveLength(3); // one chunk × four lenses, security failed
    expect(failed).toHaveLength(1);
    // Completion order across the parallel wave is nondeterministic — only the
    // numbering's presence and range are the contract.
    expect(failed[0].message).toMatch(/finder security\/0 failed \(\d\/4\)/);
    expect(failed[0].level).toBe("warning");
    expect(done.every((n) => n.level === "info" && n.message.includes("0 finding(s)"))).toBe(true);
    // every completion is numbered, so progress is visible mid-wave
    const nums = [...done, ...failed].map((n) => n.message.match(/\((\d)\/4\)/)?.[1]).sort();
    expect(nums).toEqual(["1", "2", "3", "4"]);
  });

  it("attaches changed files' current contents to every finder task", async () => {
    const spawn = fakeSpawn(() => "[]");
    const reads: string[] = [];
    const readFile = async (p: string) => {
      reads.push(p);
      return p.endsWith("src/a.ts") ? "CONTENT_A" : p.endsWith("src/b.ts") ? "CONTENT_B" : undefined;
    };
    const git = gitFor([
      // repo root differs from cwd: git diff paths are repo-root-relative and
      // attachment reads must follow the root, not the session cwd.
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo/packages/app",
      config: CONFIG({ verify: false }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    expect(reads.some((p) => p === "/repo/src/a.ts")).toBe(true); // rooted, not cwd-joined
    expect(spawn.tasks.length).toBeGreaterThan(0);
    for (const task of spawn.tasks) {
      expect(task).toContain("### src/a.ts\nCONTENT_A");
      expect(task).toContain("### src/b.ts\nCONTENT_B");
      expect(task).toContain("## The diff"); // the review subject still rides along
      expect(Buffer.byteLength(task, "utf8")).toBeLessThanOrEqual(120_000); // the byte-cap invariant
    }
  });

  it("names over-budget files instead of attaching partials, and 0 disables attaching", async () => {
    const big = "B".repeat(5_000);
    const spawn = fakeSpawn(() => "[]");
    const readFile = async (p: string) =>
      p.endsWith("src/a.ts") ? "CONTENT_A" : p.endsWith("src/b.ts") ? big : undefined;
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, attachChars: 100 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    expect(spawn.tasks[0]).toContain("### src/a.ts\nCONTENT_A"); // whole file fits
    expect(spawn.tasks[0]).not.toContain("### src/b.ts"); // partials never attach
    expect(spawn.tasks[0]).toContain("read them if needed): src/b.ts"); // fallback is named

    const off = fakeSpawn(() => "[]");
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, attachChars: 0 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: off, readFile }) as never,
    });
    expect(off.tasks[0]).not.toContain("Current contents of the changed files");
  });

  it("runs the finder pool at the configured wave width, not a hardcoded 4", async () => {
    // Two fat files → two chunks (chunkChars 8k floor) → 8 lens×chunk runs.
    // Children close on a microtask, so every worker spawns before any child
    // settles — peak in-flight equals the pool limit, deterministically.
    const fatFile = (name: string) =>
      [
        `diff --git a/${name} b/${name}`,
        "--- a/" + name,
        "+++ b/" + name,
        "@@ -1,200 +1,200 @@",
        ...Array.from({ length: 200 }, () => "+" + "x".repeat(50)),
      ].join("\n");
    const bigDiff = [fatFile("src/big1.ts"), fatFile("src/big2.ts")].join("\n");
    const runAt = (concurrency: number) => {
      let inFlight = 0;
      let peak = 0;
      const spawn = ((_c: string, args: string[], _o: unknown) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const child = childWithMessage("[]");
        child.on?.("close", () => inFlight--);
        void args;
        return child;
      }) as SpawnFn;
      const git = gitFor([
        { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
        {
          match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
          result: { code: 0, stdout: bigDiff, stderr: "" },
        },
      ]);
      return runReview({
        cwd: "/repo",
        config: CONFIG({ verify: false, chunkChars: 8_000, concurrency }),
        target: { kind: "uncommitted" },
        deps: emptyDeps({ git, spawnFn: spawn, readFile: async () => undefined }) as never,
      }).then(() => peak);
    };
    expect(await runAt(8)).toBe(8); // one full wave — the new default
    expect(await runAt(4)).toBe(4); // the knob limits, not the run count
  });

  it("never shrinks the diff when attachment headers overflow the margin — drops attachments instead", async () => {
    // 150 changed files with long paths: bodies fit the budget, but ~45 bytes
    // of header per file (~6.7k) overflow the 2k margin — the compose-measure-
    // drop loop must shed attachments until the task fits, keeping the diff whole.
    const DEEP = "a/very/deeply/nested/path/component/src";
    const files = Array.from({ length: 150 }, (_, i) =>
      [
        `diff --git ${DEEP}/f${i}.ts ${DEEP}/f${i}.ts`,
        `--- ${DEEP}/f${i}.ts`,
        `+++ ${DEEP}/f${i}.ts`,
        "@@ -1 +1 @@",
        `+change-f${i}`,
      ].join("\n"),
    );
    const spawn = fakeSpawn(() => "[]");
    const readFile = async (p: string) => {
      const m = /f(\d+)\.ts$/.exec(p);
      return m ? `MARK-f${m[1]} ` + "x".repeat(700) : undefined;
    };
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: files.join("\n"), stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, attachChars: 300_000 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    for (const task of spawn.tasks) {
      // The byte-cap invariant holds without diff truncation…
      expect(Buffer.byteLength(task, "utf8")).toBeLessThanOrEqual(120_000);
      expect(task).toContain("+change-f0");
      expect(task).toContain("+change-f149");
      // …because attachments were shed: not all 150 made it.
      const attached = (task.match(/MARK-f\d+/g) ?? []).length;
      expect(attached).toBeGreaterThan(0);
      expect(attached).toBeLessThan(150);
    }
  });

  it("attaches hunk windows of files too large to attach whole", async () => {
    // 200 lines, changed at line 10 (SAMPLE_DIFF's b.ts hunk @@ -10,3 +10,3 @@):
    // the whole file cannot fit a 1k budget, but the window around the hunk can.
    const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const spawn = fakeSpawn(() => "[]");
    const readFile = async (p: string) => (p.endsWith("src/b.ts") ? big : undefined);
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, attachChars: 2_000 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    // The window (hunk at 10-12 widened by 40, clamped at file start) fits
    // where the whole file (≈3.8k) would not.
    expect(spawn.tasks[0]).toContain("### src/b.ts (lines 1-52)");
    expect(spawn.tasks[0]).toContain("const v10 = 10;");
  });

  it("names files whose windows overflow the per-file cap instead of attaching partials", async () => {
    // 400-byte lines × 120 lines: the 40-line window around the hunk far
    // exceeds ATTACH_SLICE_MAX_CHARS, so the file is named, not half-attached.
    const wide = Array.from({ length: 120 }, () => "x".repeat(400)).join("\n");
    const spawn = fakeSpawn(() => "[]");
    const readFile = async (p: string) => (p.endsWith("src/b.ts") ? wide : undefined);
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    expect(spawn.tasks[0]).not.toContain("### src/b.ts");
    expect(spawn.tasks[0]).toContain("read them if needed): src/b.ts");
  });

  it("skips deleted files silently — their absence is the diff", async () => {
    const spawn = fakeSpawn(() => "[]");
    const readFile = async (p: string) => (p.endsWith("src/a.ts") ? "CONTENT_A" : undefined);
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile }) as never,
    });
    expect(spawn.tasks[0]).toContain("### src/a.ts\nCONTENT_A");
    expect(spawn.tasks[0]).not.toContain("### src/b.ts");
    expect(spawn.tasks[0]).not.toContain("read them if needed");
  });
});

/** Git fake routed by arg matcher: first matching response wins, misses fail
 * with a stderr naming the unexpected command. */
const gitFor =
  (
    responses: Array<{
      match: (args: string[]) => boolean;
      result: { code: number; stdout: string; stderr: string };
    }>,
  ) =>
  async (args: string[]) =>
    responses.find((r) => r.match(args))?.result ?? { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };

describe("parseReviewConfig", () => {
  it("summarizes a review compactly for the agent-facing tool", () => {
    const full = {
      report: "# big report",
      findings: [
        finding({ severity: "critical", title: "Bug one" }),
        finding({ file: "src/b.ts", line: 9, severity: "suggestion", title: "Nit" }),
      ],
      coverage: { errors: [], uncoveredFiles: [], lensCoverage: {} },
      findingCount: 2,
      notes: [],
    };
    const text = summarizeForTool(full, "/repo/.pi/review-report.md");
    expect(text).toContain("2 finding(s): 1 critical, 1 suggestion.");
    expect(text).toContain("[critical] src/a.ts:2 — Bug one");
    expect(text).toContain("[suggestion] src/b.ts:9 — Nit");
    expect(text).toContain("Full report: /repo/.pi/review-report.md");
    expect(text).not.toContain("big report"); // details stay on disk
    const gaps = summarizeForTool({
      ...full,
      findings: [],
      findingCount: 0,
      coverage: { errors: ["finder died"], uncoveredFiles: ["src/x.ts"], lensCoverage: {} },
    });
    expect(gaps).toContain("No actionable findings.");
    expect(gaps).toContain("Coverage gaps: 1 file(s) unreviewed, 1 finder error(s).");
  });

  it("defaults without env (verification on, the measured config)", () => {
    const c = parseReviewConfig({});
    expect(c.verify).toBe(true);
    expect(c.chunkChars).toBe(96_000);
    expect(c.attachChars).toBe(64_000);
    expect(c.maxChildren).toBe(8);
    expect(c.concurrency).toBe(8);
    expect(c.model).toBe("opencode-go/muse-spark-1.2-contributor:off");
    expect(c.checkCmd).toBe("");
    expect(c.persist).toBe(true);
    expect(c.idleTimeoutMs).toBe(5 * 60_000);
  });

  it("accepts valid overrides and clamps invalid ones", () => {
    const c = parseReviewConfig({
      PI_REVIEW_VERIFY: "1",
      PI_REVIEW_CHUNK_CHARS: "1",
      PI_REVIEW_ATTACH_CHARS: "9999999",
      PI_REVIEW_MAX_CHILDREN: "999",
      PI_REVIEW_CONCURRENCY: "999",
      PI_REVIEW_TIMEOUT_MS: "5",
      PI_REVIEW_IDLE_TIMEOUT_MS: "1000",
      PI_REVIEW_MODEL: "ollama/qwen3 ",
      PI_REVIEW_CHECK_CMD: "npm run check",
      PI_REVIEW_STATE: "0",
    });
    expect(c.verify).toBe(true);
    expect(c.chunkChars).toBe(8_000); // clamped to min
    expect(c.attachChars).toBe(262_144); // clamped to max
    expect(parseReviewConfig({ PI_REVIEW_ATTACH_CHARS: "0" }).attachChars).toBe(0); // numeric zero disables
    expect(c.maxChildren).toBe(32); // clamped to max
    expect(c.concurrency).toBe(16); // clamped to max
    expect(parseReviewConfig({ PI_REVIEW_CONCURRENCY: "1" }).concurrency).toBe(1);
    expect(c.timeoutMs).toBe(10_000); // clamped to min
    expect(c.idleTimeoutMs).toBe(10_000); // clamped to min
    expect(c.model).toBe("ollama/qwen3");
    expect(c.checkCmd).toBe("npm run check");
    expect(c.persist).toBe(false);
  });

  it("falls back on garbage; verify opts out on 0/false/off", () => {
    const c = parseReviewConfig({ PI_REVIEW_VERIFY: "banana", PI_REVIEW_CHUNK_CHARS: "banana" });
    expect(c.verify).toBe(true); // garbage keeps the on-by-default
    expect(c.chunkChars).toBe(96_000);
    for (const off of ["0", "false", "off", " 0 "]) {
      expect(parseReviewConfig({ PI_REVIEW_VERIFY: off }).verify).toBe(false);
    }
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "1" }).verify).toBe(true);
  });

  it("treats blank env values as unset, not zero", () => {
    const c = parseReviewConfig({ PI_REVIEW_TIMEOUT_MS: "", PI_REVIEW_MAX_CHILDREN: "  " });
    expect(c.timeoutMs).toBe(20 * 60_000);
    expect(c.maxChildren).toBe(8);
    expect(c.idleTimeoutMs).toBe(5 * 60_000);
  });

  it("disables the idle watchdog on any numerically-zero value", () => {
    expect(parseReviewConfig({ PI_REVIEW_IDLE_TIMEOUT_MS: "0" }).idleTimeoutMs).toBe(0);
    expect(parseReviewConfig({ PI_REVIEW_IDLE_TIMEOUT_MS: "0 " }).idleTimeoutMs).toBe(0);
    expect(parseReviewConfig({ PI_REVIEW_IDLE_TIMEOUT_MS: "0.0" }).idleTimeoutMs).toBe(0);
    expect(parseReviewConfig({ PI_REVIEW_IDLE_TIMEOUT_MS: "00" }).idleTimeoutMs).toBe(0);
    expect(parseReviewConfig({ PI_REVIEW_IDLE_TIMEOUT_MS: "1000" }).idleTimeoutMs).toBe(10_000);
  });
});

describe("parseReviewArgs", () => {
  it("empty means default target", () => {
    expect(parseReviewArgs("")).toEqual({ target: { kind: "default" } });
    expect(parseReviewArgs("   ")).toEqual({ target: { kind: "default" } });
  });

  it("maps staged/cached and tree synonyms", () => {
    expect(parseReviewArgs("staged").target).toEqual({ kind: "staged" });
    expect(parseReviewArgs("cached").target).toEqual({ kind: "staged" });
    expect(parseReviewArgs("tree").target).toEqual({ kind: "uncommitted" });
    expect(parseReviewArgs("working").target).toEqual({ kind: "uncommitted" });
  });

  it("parses refs and ranges; first target token wins", () => {
    expect(parseReviewArgs("main").target).toEqual({ kind: "ref", ref: "main" });
    expect(parseReviewArgs("v1.2...v1.3").target).toEqual({ kind: "range", base: "v1.2", head: "v1.3" });
    expect(parseReviewArgs("main staged").target).toEqual({ kind: "ref", ref: "main" });
  });

  it("parses --model and --verify-model in space and equals form, anywhere", () => {
    expect(parseReviewArgs("--model glm-5.3")).toMatchObject({ model: "glm-5.3" });
    expect(parseReviewArgs("--verify-model=ollama/qwen3 staged")).toMatchObject({
      verifyModel: "ollama/qwen3",
      target: { kind: "staged" },
    });
    expect(parseReviewArgs("--model anthropic/claude-opus-4 main --verify-model glm-5.3")).toMatchObject({
      model: "anthropic/claude-opus-4",
      verifyModel: "glm-5.3",
      target: { kind: "ref", ref: "main" },
    });
    // a slashed model must never be mistaken for a ref
    expect(parseReviewArgs("--model ollama/qwen3").target).toEqual({ kind: "default" });
  });

  it("errors on flags missing a value, without swallowing the next flag", () => {
    expect(parseReviewArgs("--model")).toMatchObject({ error: expect.stringContaining("--model") });
    expect(parseReviewArgs("--verify-model --model x")).toMatchObject({
      error: expect.stringContaining("--verify-model"),
    });
    expect(parseReviewArgs("--model --verify-model x")).toMatchObject({ error: expect.stringContaining("--model") });
  });

  it("parses a review directory from --cwd or path-shaped tokens, never as a ref", () => {
    expect(parseReviewArgs("--cwd ~/Code/foo")).toMatchObject({ cwd: "~/Code/foo" });
    expect(parseReviewArgs("--cwd=../bar main")).toMatchObject({
      cwd: "../bar",
      target: { kind: "ref", ref: "main" },
    });
    expect(parseReviewArgs("~/Code/foo tree")).toMatchObject({ cwd: "~/Code/foo", target: { kind: "uncommitted" } });
    expect(parseReviewArgs("/abs/repo")).toMatchObject({ cwd: "/abs/repo" });
    expect(parseReviewArgs("./sibling").cwd).toBe("./sibling");
    expect(parseReviewArgs("..").cwd).toBe("..");
    // first directory wins, mirroring first-target-wins
    expect(parseReviewArgs("~/Code/foo ~/Code/other")).toMatchObject({ cwd: "~/Code/foo" });
    // bare and dot-free names stay refs — a branch like feature/x must not be
    // mistaken for a path, and a missing ref fails loudly in git instead.
    // ~user forms stay refs too: only ~/ resolves, so ~root would otherwise
    // resolve to a bogus <cwd>/~root instead of failing loudly
    expect(parseReviewArgs("main").cwd).toBeUndefined();
    expect(parseReviewArgs("feature/x")).toMatchObject({ target: { kind: "ref", ref: "feature/x" } });
    expect(parseReviewArgs("feature/x").cwd).toBeUndefined();
    expect(parseReviewArgs("~root/proj")).toMatchObject({ target: { kind: "ref", ref: "~root/proj" } });
  });

  it("rejects --cwd without a value", () => {
    expect(parseReviewArgs("--cwd")).toMatchObject({
      error: expect.stringContaining("--cwd requires a directory path"),
    });
    expect(parseReviewArgs("--cwd --model x")).toMatchObject({ error: expect.stringContaining("--cwd requires") });
  });

  it("resolves invocation models flag > env knob > inherit", () => {
    const envCfg = { model: "env-model" };
    expect(resolveInvocation(parseReviewArgs(""), envCfg)).toEqual({ model: "env-model", verifyModel: undefined });
    expect(resolveInvocation(parseReviewArgs("--model flag-model"), envCfg)).toEqual({
      model: "flag-model",
      verifyModel: undefined,
    });
    expect(resolveInvocation(parseReviewArgs("--model a --verify-model b"), {})).toEqual({
      model: "a",
      verifyModel: "b",
    });
  });
});

describe("resolveReviewCwd", () => {
  it("defaults to the session cwd and expands ~ and relative paths", () => {
    expect(resolveReviewCwd("/sess")).toBe("/sess");
    expect(resolveReviewCwd("/sess", "")).toBe("/sess");
    expect(resolveReviewCwd("/sess", "   ")).toBe("/sess");
    expect(resolveReviewCwd("/sess", "~")).toBe(homedir());
    expect(resolveReviewCwd("/sess", "~/Code/foo")).toBe(path.join(homedir(), "Code", "foo"));
    expect(resolveReviewCwd("/sess", "/abs/repo")).toBe("/abs/repo");
    expect(resolveReviewCwd("/sess", "../bar")).toBe(path.resolve("/sess", "../bar"));
    expect(resolveReviewCwd("/sess", "sub/repo")).toBe(path.resolve("/sess", "sub/repo"));
  });
});

describe("foreign check gating", () => {
  it("defaults off and accepts only 1/true/on", () => {
    expect(foreignCheckAllowed({})).toBe(false);
    expect(foreignCheckAllowed({ PI_REVIEW_CHECK_FOREIGN: "0" })).toBe(false);
    expect(foreignCheckAllowed({ PI_REVIEW_CHECK_FOREIGN: "yes" })).toBe(false);
    expect(foreignCheckAllowed({ PI_REVIEW_CHECK_FOREIGN: "1" })).toBe(true);
    expect(foreignCheckAllowed({ PI_REVIEW_CHECK_FOREIGN: " TRUE " })).toBe(true);
    expect(foreignCheckAllowed({ PI_REVIEW_CHECK_FOREIGN: "on" })).toBe(true);
  });
});

describe("symlinkFree", () => {
  it("passes real and missing paths, rejects symlinked components", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-symlink-"));
    mkdirSync(path.join(root, "pi-real"), { recursive: true });
    symlinkSync(root, path.join(root, "pi-link"));
    expect(await symlinkFree(path.join(root, "pi-real"))).toBe(true);
    expect(await symlinkFree(path.join(root, "never-created"))).toBe(true);
    expect(await symlinkFree(path.join(root, "pi-link"))).toBe(false);
    expect(await symlinkFree(path.join(root, "pi-real"), path.join(root, "pi-link"))).toBe(false);
  });
});

describe("diff parsing", () => {
  it("splits a multi-file diff and keeps full per-file text", () => {
    const files = splitDiffFiles(SAMPLE_DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0].text).toContain("@@ -1,3 +1,4 @@");
    expect(files[0].text).toContain("+added");
    expect(files[0].chars).toBe(files[0].text.length);
  });

  it("uses the b-side path on renames", () => {
    const files = splitDiffFiles("diff --git a/old.ts b/new.ts\nsimilarity index 90%\n+changed");
    expect(files[0].path).toBe("new.ts");
  });

  it("drops text before the first header", () => {
    const files = splitDiffFiles(`junk\nmore junk\n${SAMPLE_DIFF}`);
    expect(files).toHaveLength(2);
  });
});

describe("exclusions", () => {
  it("excludes lockfiles, logs, binaries, vendored and generated paths", () => {
    for (const p of [
      "package-lock.json",
      "pnpm-lock.yaml",
      "Cargo.lock",
      "app.log",
      "logo.svg",
      "bundle.min.js",
      "app.js.map",
      "node_modules/x/y.js",
      "dist/out.js",
      "src/gen/api.ts",
      "vendor/lib.js",
      "photo.png",
    ]) {
      expect(isExcludedPath(p), p).toBe(true);
    }
  });

  it("keeps source files", () => {
    for (const p of ["src/a.ts", "lib/index.js", "README.md", "tests/x.test.ts", "app.css"]) {
      expect(isExcludedPath(p), p).toBe(false);
    }
  });

  it("excludes our own persisted state so re-reviews do not ingest it as a new file", () => {
    expect(isExcludedPath(".pi/review-state.json")).toBe(true);
    expect(isExcludedPath(".pi/anything")).toBe(true);
  });
});

/** Fake directory listing for walkTree: dir path -> entries as
 * [name, kind] with f=file, d=directory, l=symlink. */
const listDirFor = (tree: Record<string, Array<[string, "f" | "d" | "l"]>>) => async (dir: string) => {
  const entries = tree[dir];
  if (!entries) {
    const err = new Error(`ENOENT: ${dir}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return entries.map(([name, kind]) => ({
    name,
    isDirectory: kind === "d",
    isSymbolicLink: kind === "l",
  }));
};

describe("walkTree", () => {
  const TREE: Record<string, Array<[string, "f" | "d" | "l"]>> = {
    "/repo": [
      [".git", "d"],
      [".hidden", "d"],
      ["node_modules", "d"],
      ["dist", "d"],
      ["src", "d"],
      ["README.md", "f"],
      ["a.ts", "f"],
      ["z.ts", "f"],
      ["out.log", "f"],
      ["img.png", "f"],
      ["link.ts", "l"],
      [".env", "f"],
      [".env.production.local", "f"],
      ["id_RSA", "f"],
      ["server.pem", "f"],
    ],
    "/repo/.hidden": [["h.ts", "f"]],
    "/repo/node_modules": [["m.js", "f"]],
    "/repo/dist": [["b.js", "f"]],
    "/repo/src": [
      ["b.ts", "f"],
      ["gen", "d"],
    ],
    "/repo/src/gen": [["g.ts", "f"]],
  };

  it("collects eligible files deterministically, skipping dot-dirs, excluded paths, and symlinks", async () => {
    const { paths, truncated, skippedDirs } = await walkTree("/repo", listDirFor(TREE));
    expect(paths).toEqual(["README.md", "a.ts", "src/b.ts", "z.ts"]); // byte-sorted per directory
    expect(truncated).toBe(null);
    expect(skippedDirs).toEqual([]);
    expect(paths).not.toContain("out.log"); // exclusion list applies to files
    expect(paths).not.toContain("h.ts"); // dot-directory skipped entirely
    expect(paths).not.toContain("g.ts"); // src/gen is on the exclusion list
  });

  it("skips and names symlinks and credential-shaped files instead of reading them", async () => {
    const out = await walkTree("/repo", listDirFor(TREE));
    expect(out.skippedSymlinks).toEqual(["link.ts"]); // named, not silently dropped
    expect(out.skippedSecrets).toEqual([".env", ".env.production.local", "id_RSA", "server.pem"]); // case/suffix-insensitive
    expect(out.paths).not.toContain(".env");
    expect(out.paths).not.toContain(".env.production.local");
  });

  it("stops at the file cap and reports truncation", async () => {
    const { paths, truncated } = await walkTree("/repo", listDirFor(TREE), { maxFiles: 2 });
    expect(paths).toEqual(["README.md", "a.ts"]);
    expect(truncated).toBe("files");
  });

  it("names unreadable directories instead of failing the walk", async () => {
    const errnoThrower = (code: string) => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    };
    const listing = listDirFor({
      "/repo": [
        ["a.ts", "f"],
        ["locked", "d"],
        ["toobig", "d"],
      ],
    });
    const broken = async (dir: string) => {
      if (dir === "/repo/locked") throw errnoThrower("EACCES");
      if (dir === "/repo/toobig") throw errnoThrower(MANY_ENTRIES); // the opendir cap marker
      return listing(dir);
    };
    const out = await walkTree("/repo", broken);
    expect(out.paths).toEqual(["a.ts"]);
    expect(out.skippedDirs).toEqual(["locked", "toobig"]); // per-directory facts are named skips
  });

  it("rethrows systemic listing failures instead of recasting them as skips", async () => {
    const listing = listDirFor({
      "/repo": [
        ["a.ts", "f"],
        ["dying", "d"],
      ],
    });
    const broken = async (dir: string) => {
      if (dir === "/repo/dying") {
        const err = new Error("EMFILE") as NodeJS.ErrnoException;
        err.code = "EMFILE";
        throw err;
      }
      return listing(dir);
    };
    await expect(walkTree("/repo", broken)).rejects.toThrow("cannot list /repo/dying");
  });

  it("fails loudly when the ROOT listing fails — an unreadable tree is not an empty tree", async () => {
    const noAccess = async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    await expect(walkTree("/repo", noAccess)).rejects.toThrow("cannot list /repo");
  });

  it("stops on the visited-entries bound even when nothing is collected", async () => {
    const { paths, truncated } = await walkTree("/repo", listDirFor(TREE), { maxEntries: 3 });
    expect(paths).toEqual([]); // first three entries are secrets/dot-dirs — no files collected
    expect(truncated).toBe("entries"); // but the WORK was bounded
  });

  it("honors the abort signal mid-walk", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(walkTree("/repo", listDirFor(TREE), { signal: controller.signal })).rejects.toThrow("review aborted");
  });
});

describe("syntheticNewFileDiff", () => {
  it("renders a git-shaped new-file diff", () => {
    const text = syntheticNewFileDiff("new.ts", "alpha\nbeta\n");
    expect(text.split("\n")).toEqual([
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
    ]);
    // parses back through the same splitter
    expect(splitDiffFiles(text)[0].path).toBe("new.ts");
  });
});

describe("chunkDiffFiles", () => {
  it("keeps everything in one chunk under the budget", () => {
    const files = splitDiffFiles(SAMPLE_DIFF);
    const chunks = chunkDiffFiles(files, 96_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(2);
  });

  it("splits on file boundaries, never inside a file", () => {
    const files = splitDiffFiles(SAMPLE_DIFF);
    const chunks = chunkDiffFiles(files, files[0].chars + 1);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].files).toEqual([files[0]]);
    expect(chunks[1].files).toEqual([files[1]]);
  });

  it("keeps a single oversized file as its own chunk", () => {
    const files = splitDiffFiles(SAMPLE_DIFF);
    const chunks = chunkDiffFiles([files[0]], 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(1);
  });
});

describe("guidelines", () => {
  it("extracts a review guidelines section and stops at the next heading", () => {
    const md = "# Repo guide\n\n## Review guidelines\n- never log PII\n\n## Other\nstuff";
    expect(extractReviewGuidelines(md)).toBe("- never log PII");
  });

  it("matches heading variants and returns empty when absent", () => {
    expect(extractReviewGuidelines("### Review Guidelines \n- x")).toBe("- x");
    expect(extractReviewGuidelines("## Review instructions\n- x")).toBe("- x");
    expect(extractReviewGuidelines("# AGENTS\nnothing here")).toBe("");
  });

  it("collects REVIEW.md plus the closest AGENTS.md section, deduplicated", async () => {
    const files = new Map<string, string | undefined>([
      ["/repo/REVIEW.md", "root review file"],
      ["/repo/AGENTS.md", "## Review guidelines\n- root rule"],
      ["/repo/pkg/AGENTS.md", "## Review guidelines\n- pkg rule"],
      ["/repo/pkg/deep/AGENTS.md", "## Review guidelines\n- root rule"], // same text as root: dedup
    ]);
    const deps = { readFile: async (p: string) => files.get(p) };
    const out = await collectGuidelines("/repo", ["pkg/deep/a.ts", "pkg/b.ts", "other.ts"], deps);
    expect(out).toContain("# REVIEW.md\nroot review file");
    expect(out).toContain("pkg rule"); // closest AGENTS.md wins for pkg/deep/a.ts
    expect(out).toContain("root rule"); // from root for other.ts and the deduped deep copy
    expect(out.match(/root rule/g)?.length).toBe(1); // identical sections deduplicated
  });

  it("caps repo-controlled guidelines so they cannot swamp the diff", async () => {
    // A reviewed repo controls guideline length — without a cap a hostile
    // REVIEW.md rides unbounded inside every finder task.
    const deps = { readFile: async (p: string) => (p === "/repo/REVIEW.md" ? "x".repeat(50_000) : undefined) };
    const out = await collectGuidelines("/repo", [], deps);
    expect(out.length).toBeLessThanOrEqual(GUIDELINES_MAX_CHARS + 100);
    expect(out).toContain("guidelines truncated at");
  });

  it("skips guideline files that are oversized on disk, before any read", async () => {
    // The read itself must be bounded: stat first, skip what is too big to be
    // real guidelines (git can commit a huge REVIEW.md to stall the review).
    const root = mkdtempSync(path.join(tmpdir(), "review-guidelines-"));
    writeFileSync(path.join(root, "REVIEW.md"), "x".repeat(GUIDELINES_MAX_CHARS * 4 + 1));
    const calls: string[] = [];
    const out = await collectGuidelines(root, [], {
      readFile: async (p) => {
        calls.push(p);
        try {
          return readFileSync(p, "utf8");
        } catch {
          return undefined;
        }
      },
    });
    expect(out).not.toContain("should not be consulted"); // nothing usable from a refused REVIEW.md
    expect(out).toContain("REVIEW.md"); // …and the refusal is named, not silent
    expect(calls).toHaveLength(0); // skipped before any read
  });

  it("does not follow a committed directory symlink out of the repo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-guides-link-"));
    const elsewhere = mkdtempSync(path.join(tmpdir(), "review-guides-else-"));
    writeFileSync(path.join(elsewhere, "AGENTS.md"), "## Review guidelines\n- smuggled rule");
    symlinkSync(elsewhere, path.join(root, "pkg")); // committed pkg -> elsewhere
    const calls: string[] = [];
    const out = await collectGuidelines(root, ["pkg/a.ts"], {
      readFile: async (p) => {
        calls.push(p);
        try {
          return readFileSync(p, "utf8");
        } catch {
          return undefined;
        }
      },
    });
    expect(out).not.toContain("smuggled rule"); // the redirected AGENTS.md is never read
    expect(calls).not.toContain(path.join(root, "pkg", "AGENTS.md"));
    expect(out).toContain("pkg/AGENTS.md"); // the refusal itself is disclosed
  });

  it("names guard-refused guideline files instead of silently substituting ancestors", async () => {
    // An oversized nearer AGENTS.md must visibly fall through to the
    // ancestor's section — not quietly adopt it as if the nearer one were absent.
    const root = mkdtempSync(path.join(tmpdir(), "review-guides-refused-"));
    mkdirSync(path.join(root, "pkg"), { recursive: true });
    // 32k CJK chars ≈ 96KB: over the 4x-char-cap byte bound, refused on disk.
    writeFileSync(path.join(root, "pkg", "AGENTS.md"), "\u898f".repeat(GUIDELINES_MAX_CHARS * 2 + 1));
    writeFileSync(path.join(root, "AGENTS.md"), "## Review guidelines\n- fallback rule");
    const out = await collectGuidelines(root, ["pkg/a.ts"], { readFile: realReadFile });
    expect(out).toContain("(AGENTS.md)"); // ancestor's section still applies
    expect(out).toContain("- fallback rule");
    expect(out).toContain("pkg/AGENTS.md"); // …and the refusal is named
    expect(out).toContain("symlink escape");
  });

  it("refuses a directory named AGENTS.md and says so", async () => {
    // The guard must fail closed on non-plain files (a FIFO or directory is
    // not readable content), with the refusal disclosed like any other.
    const root = mkdtempSync(path.join(tmpdir(), "review-guides-dir-"));
    mkdirSync(path.join(root, "pkg", "AGENTS.md"), { recursive: true });
    writeFileSync(path.join(root, "AGENTS.md"), "## Review guidelines\n- fallback rule");
    const out = await collectGuidelines(root, ["pkg/a.ts"], { readFile: realReadFile });
    expect(out).toContain("- fallback rule"); // ancestor still applies
    expect(out).toContain("pkg/AGENTS.md"); // the non-plain-file refusal is named
  });

  it("bounds the refusal notice itself, not just the guideline sections", async () => {
    // Fifteen distinct refused AGENTS.md dirs: the count is capped at 10 with
    // short names, and the rendered list is sliced with long ones — either way
    // repo-controlled paths cannot push the notice past a small fixed margin.
    const secret = mkdtempSync(path.join(tmpdir(), "review-secret-"));
    const build = async (nameOf: (i: number) => string) => {
      const root = mkdtempSync(path.join(tmpdir(), "review-guides-cap-"));
      const files: string[] = [];
      for (let i = 0; i < 15; i++) {
        mkdirSync(path.join(root, nameOf(i)), { recursive: true });
        symlinkSync(secret, path.join(root, nameOf(i), "AGENTS.md")); // refused: outside the repo
        files.push(`${nameOf(i)}/a.ts`);
      }
      return collectGuidelines(root, files, { readFile: realReadFile });
    };
    const shortOut = await build((i) => `d${i}`);
    expect(shortOut).toContain("and 5 more"); // count cap fires, tail intact
    expect(shortOut.length).toBeLessThanOrEqual(GUIDELINES_MAX_CHARS + 500);
    const longOut = await build((i) => `d${i}${"x".repeat(90)}`);
    expect(longOut.trimEnd().endsWith("…)")).toBe(true); // the name list itself is sliced
    expect(longOut.length).toBeLessThanOrEqual(GUIDELINES_MAX_CHARS + 500);
  });

  it("reads non-ASCII guidelines up to the byte budget, then truncates by characters", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-guides-cjk-"));
    // 16k CJK characters are 48k UTF-8 bytes: inside the 4x byte budget, over
    // the character cap — a byte/char mix-up at the read would skip it entirely.
    writeFileSync(path.join(root, "REVIEW.md"), "\u898f".repeat(GUIDELINES_MAX_CHARS));
    const out = await collectGuidelines(root, [], {
      readFile: async (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return undefined;
        }
      },
    });
    expect(out).toContain("guidelines truncated at");
  });
});

describe("parseFindings", () => {
  const ok = (arr: unknown[]) => "prose\n```json\n" + JSON.stringify(arr) + "\n```";

  it("parses the last json block and coerces fields", () => {
    const text = ok([
      { file: "src/a.ts", line: 3, severity: "critical", title: "T", detail: "D", recommendation: "R" },
      { file: "src/b.ts", line: "7", severity: "bogus", title: "T2" },
    ]);
    const out = parseFindings(text, "correctness");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ file: "src/a.ts", line: 3, severity: "critical" });
    expect(out[1]).toMatchObject({ line: 7, severity: "suggestion" }); // invalid severity downgrades, not fails
    expect(out[1].recommendation).toBeUndefined();
  });

  it("drops entries without file or title", () => {
    const out = parseFindings(ok([{ line: 1, title: "no file" }, { file: "a" }, { file: "a", title: "ok" }]), "l");
    expect(out).toHaveLength(1);
  });

  it("returns empty without a json array", () => {
    expect(parseFindings("I found nothing to report.", "l")).toEqual([]);
    expect(parseFindings('```json\n{"not":"an array"}\n```', "l")).toEqual([]);
  });
});

describe("mergeFindings", () => {
  it("merges near-line duplicates: worst severity wins, lenses union", () => {
    const merged = mergeFindings([
      [finding({ line: 10, severity: "important" })],
      [finding({ line: 12, severity: "critical", lenses: ["security"] })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe("critical");
    expect(merged[0].lenses.sort()).toEqual(["correctness", "security"]);
  });

  it("merges by normalized title even without lines", () => {
    const merged = mergeFindings([
      [finding({ line: undefined, title: "Off-by-one in LOOP bound!" })],
      [finding({ line: undefined, title: "off-by-one loop bound in", lenses: ["robustness"] })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].lenses).toHaveLength(2);
  });

  it("keeps distinct findings apart and sorts by severity then location", () => {
    const merged = mergeFindings([
      [finding({ file: "src/b.ts", severity: "suggestion", title: "Naming" })],
      [finding({ file: "src/a.ts", severity: "important", line: 50, title: "Late bug" })],
      [finding({ file: "src/a.ts", severity: "critical", line: 1, title: "Early bug" })],
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.map((f) => f.severity)).toEqual(["critical", "important", "suggestion"]);
  });

  it("does not merge line-less findings in the same file unless titles match", () => {
    // Regression: undefined === undefined used to count as "near", silently
    // deleting one of two distinct findings when models omitted line numbers.
    const merged = mergeFindings([
      [finding({ line: undefined, title: "SQL injection in query builder", severity: "critical" })],
      [finding({ line: undefined, title: "Missing timeout on fetch", severity: "important", lenses: ["robustness"] })],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((f) => f.title).sort()).toEqual(["Missing timeout on fetch", "SQL injection in query builder"]);
  });
});

describe("verdicts", () => {
  // Built per test: applyVerdicts mutates candidates (downgrades severity).
  const makeCandidates = () => [
    finding(),
    finding({ file: "src/b.ts", title: "Second" }),
    finding({ file: "src/c.ts", title: "Third" }),
  ];

  it("parses verdicts and applies them positionally", () => {
    const candidates = makeCandidates();
    const verdicts: Verdict[] = [
      { id: 1, verdict: "confirmed", reason: "traced it" },
      { id: 2, verdict: "rejected", reason: "guarded elsewhere" },
      { id: 3, verdict: "downgraded", severity: "suggestion", reason: "overstated" },
    ];
    const text = "```json\n" + JSON.stringify(verdicts) + "\n```";
    const parsed = parseVerdicts(text);
    expect(parsed).toEqual(verdicts);
    const bundle = applyVerdicts(candidates, parsed!);
    expect(bundle.findings).toHaveLength(2);
    expect(bundle.findings[1].severity).toBe("suggestion");
    expect(bundle.rejected).toHaveLength(1);
    expect(bundle.rejected[0].reason).toBe("guarded elsewhere");
    expect(bundle.unverified).toBe(false);
  });

  it("keeps candidates without verdicts", () => {
    const bundle = applyVerdicts(makeCandidates(), [{ id: 1, verdict: "rejected", reason: "no" }]);
    expect(bundle.findings).toHaveLength(2);
  });

  it("ignores verdict ids outside the candidate range", () => {
    const bundle = applyVerdicts(makeCandidates(), [
      { id: 0, verdict: "rejected", reason: "0-based id" },
      { id: 4, verdict: "rejected", reason: "beyond the list" },
    ]);
    expect(bundle.findings).toHaveLength(3); // neither id maps to a candidate
  });

  it("fails open on unparseable verifier output", () => {
    expect(parseVerdicts("garbage")).toBeNull();
    const bundle = applyVerdicts(makeCandidates(), null);
    expect(bundle.findings).toHaveLength(3);
    expect(bundle.unverified).toBe(true);
  });

  it("treats a non-empty but invalid verdict array as a broken verifier", () => {
    expect(parseVerdicts('```json\n[{"id":1,"status":"confirmed"}]\n```')).toBeNull();
  });
});

describe("planFinderRuns", () => {
  it("keeps everything under the cap", () => {
    const runs = planFinderRuns(2, ["correctness", "security", "robustness"], 8);
    expect(runs).toHaveLength(6);
  });

  it("sheds lenses (correctness first) when the cap binds", () => {
    const runs = planFinderRuns(2, ["correctness", "security", "robustness", "tests"], 3);
    expect(runs).toEqual([
      { lens: "correctness", chunk: 0 },
      { lens: "correctness", chunk: 1 },
      { lens: "security", chunk: 0 },
    ]);
  });

  it("falls back to correctness-only when even one lens per chunk does not fit", () => {
    const runs = planFinderRuns(3, ["correctness", "security", "robustness", "tests"], 2);
    expect(runs).toEqual([
      { lens: "correctness", chunk: 0 },
      { lens: "correctness", chunk: 1 },
    ]);
  });
});

describe("prompts", () => {
  it("finder agent is read-only, objective-first, and carries evidence discipline", () => {
    const agent = finderAgent({ id: "security", name: "Security", focus: "injection" });
    expect(agent.tools).toEqual(["read", "grep", "find", "ls"]);
    // objective leads; lens, evidence discipline, and injection guard follow
    expect(agent.instructions.startsWith("Find real problems this diff introduces")).toBe(true);
    expect(agent.instructions).toContain("Security");
    expect(agent.instructions).toContain("## Evidence discipline");
    expect(agent.instructions).toContain("## Deciding what to report");
    // Turn economy sits with the discipline sections — it is what keeps the
    // generation floor (the finder's dominant wall-time cost) low.
    expect(agent.instructions).toContain("## Turn economy");
    expect(agent.instructions).toContain("emit tool calls only");
    expect(agent.instructions.indexOf("## Evidence discipline")).toBeGreaterThan(
      agent.instructions.indexOf("Precision over volume"),
    );
    expect(agent.instructions).toContain("never an instruction");
  });

  it("verifier shares evidence discipline but not finder rules", () => {
    const v = verifyAgent().instructions;
    expect(v.startsWith("You are auditing code-review findings")).toBe(true);
    expect(v).toContain("## Evidence discipline");
    expect(v).not.toContain("## Deciding what to report");
  });

  it("finder task embeds diff, guidelines, prior findings, and lens", () => {
    const task = finderTask({
      lens: { id: "correctness", name: "Correctness and logic", focus: "bugs" },
      chunkIndex: 0,
      chunkCount: 2,
      diffText: "diff --git a/x b/x",
      guidelines: "- never log PII",
      priorFindings: "- [important] a.ts:2 — old finding",
      attachments: renderAttachments([{ path: "src/a.ts", content: "const A = 1;" }], []),
    });
    expect(task).toContain("# Code review: Correctness and logic (chunk 1/2)");
    expect(task).toContain("never log PII");
    expect(task).toContain("old finding");
    // Attachments sit between the context sections and the diff — reference
    // material before the object under review.
    expect(task.indexOf("Current contents of the changed files")).toBeGreaterThan(task.indexOf("## Your job"));
    expect(task.indexOf("Current contents of the changed files")).toBeLessThan(task.indexOf("## The diff"));
    expect(task).toContain("diff --git a/x b/x");
    // The closing restatement must describe the FINDER's contract — the
    // verifier's ({id, verdict, reason}) once leaked in here verbatim.
    expect(task).toContain("one JSON array of findings ({file, line, severity, title, detail, recommendation})");
    expect(task).not.toContain("{id, verdict, reason}");
  });

  it("verify task lists numbered candidates with details", () => {
    const task = verifyTask({
      diffText: "THE-DIFF",
      guidelines: "",
      checkOutput: "typecheck: 2 errors",
      priorFindings: "",
      candidates: [finding()],
    });
    expect(task).toContain("1. [important] src/a.ts:2 — Off-by-one in loop bound");
    expect(task).toContain("typecheck: 2 errors");
    expect(task).toContain("THE-DIFF");
    // The verifier, conversely, is told to verdict its numbered candidates.
    expect(task).toContain("Verdict every candidate: one JSON array of {id, verdict, reason}");
    expect(verifyAgent().name).toBe("review-verify");
  });
});

describe("renderReport", () => {
  const base = {
    targetLabel: "uncommitted changes",
    reviewedFiles: ["src/a.ts"],
    uncoveredFiles: [],
    skippedFiles: [],
    lensCoverage: new Map([[0, ["correctness", "security"]]]),
    chunkCount: 1,
    plannedLensCount: 2,
    usage: undefined,
    durationMs: 1_500,
    priorNote: "",
  };

  it("renders findings grouped by severity with locations and lenses", () => {
    const report = renderReport({
      ...base,
      bundle: {
        findings: [finding({ severity: "critical" }), finding({ file: "src/b.ts", line: 1 })],
        rejected: [],
        unverified: false,
      },
    });
    expect(report).toContain("# Code review — uncommitted changes");
    expect(report).toContain("## 🔴 Critical");
    expect(report).toContain("## 🟠 Important");
    expect(report).toContain("`src/a.ts:2`");
    expect(report).toContain("found by correctness");
  });

  it("renders the zero-findings case and rejected candidates", () => {
    const report = renderReport({
      ...base,
      bundle: { findings: [], rejected: [{ finding: finding(), reason: "guarded" }], unverified: false },
    });
    expect(report).toContain("**No actionable findings.**");
    expect(report).toContain("**Rejected by verification**");
    expect(report).toContain("guarded");
  });

  it("banners unverified findings and discloses skipped files", () => {
    const report = renderReport({
      ...base,
      skippedFiles: ["package-lock.json"],
      bundle: { findings: [finding()], rejected: [], unverified: true },
    });
    expect(report).toContain("**unverified**");
    expect(report).toContain("Excluded from review: package-lock.json");
  });

  it("discloses uncovered chunks and files instead of listing them as reviewed", () => {
    const report = renderReport({
      ...base,
      reviewedFiles: ["src/a.ts"],
      uncoveredFiles: ["src/z.ts", "src/y.ts"],
      lensCoverage: new Map([[0, ["correctness"]]]),
      chunkCount: 2,
      bundle: { findings: [], rejected: [], unverified: false },
    });
    expect(report).toContain("chunk 1: correctness");
    expect(report).toContain("chunk 2: NOT COVERED (child cap or finder failure)");
    expect(report).toContain("Not reviewed (no finder covered their chunk): src/z.ts, src/y.ts");
    expect(report).not.toContain("Files: src/a.ts, src/z.ts");
  });

  it("discloses lens shedding even in a single-chunk review", () => {
    const report = renderReport({
      ...base,
      lensCoverage: new Map([[0, ["correctness"]]]), // 3 planned, 1 covered
      plannedLensCount: 3,
      chunkCount: 1,
      bundle: { findings: [], rejected: [], unverified: false },
    });
    expect(report).toContain("1 chunks — chunk 1: correctness");
  });
});

describe("task byte budget", () => {
  it("truncates on UTF-8 byte boundaries without splitting characters", () => {
    const cjk = "漢".repeat(100); // 3 bytes per char
    const { text, omittedBytes } = truncateUtf8Bytes(cjk, 30);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(30);
    expect(omittedBytes).toBe(300 - Buffer.byteLength(text, "utf8"));
    // No partial characters survive.
    expect(text).not.toMatch(/[\uFFFD]/);
  });

  it("leaves short text untouched and truncates line-aligned when possible", () => {
    expect(truncateUtf8Bytes("abc", 100)).toEqual({ text: "abc", omittedBytes: 0 });
    const lines = ["alpha", "beta", "gamma"].join("\n");
    const cut = truncateUtf8Bytes(lines, 11); // "alpha\nbeta\n" = 11 bytes
    expect(cut.text).toBe("alpha\nbeta");
    expect(cut.omittedBytes).toBe(6); // "\ngamma"
  });

  it("fitTask caps the whole task and appends a truncation note", () => {
    const build = (diff: string) => `prompt\n${diff}\nfooter`;
    const big = "x".repeat(50_000);
    const { task, truncated } = fitTask(build, big, 1_000);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(task, "utf8")).toBeLessThanOrEqual(1_000);
    expect(task).toContain("diff truncated");
    expect(task).toContain("footer");
    const small = fitTask(build, "tiny", 1_000);
    expect(small.truncated).toBe(false);
    expect(small.task).toBe(`prompt\ntiny\nfooter`);
  });
});

describe("trackedSpawn", () => {
  it("kills live children on killAll and forgets closed ones", async () => {
    const killed: number[] = [];
    const inner = (() => {
      const c = childWithMessage("ok", 0);
      (c as unknown as { kill: () => void }).kill = () => killed.push(1);
      return c;
    }) as unknown as SpawnFn;
    const { spawnFn, killAll } = trackedSpawn(inner);
    const c = spawnFn("pi", [], { stdio: ["ignore", "pipe", "pipe"] });
    // The child closes asynchronously; wait a microtask turn, then verify it was retired.
    await new Promise((r) => setTimeout(r, 5));
    expect(killAll()).toBe(0); // already closed -> not tracked anymore
    const c2 = spawnFn("pi", [], { stdio: ["ignore", "pipe", "pipe"] });
    expect(killAll()).toBe(1); // still live -> killed
    expect(killed).toHaveLength(1);
    void c;
    void c2;
  });
});

describe("withStallRetry", () => {
  const RUN = (text: string, usage?: ChildUsage): ChildRun => ({ text, ...(usage ? { usage } : {}) });
  const USAGE_A: ChildUsage = {
    input: 100,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 105,
    cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
  };
  const USAGE_B: ChildUsage = {
    ...USAGE_A,
    totalTokens: 210,
    cost: { ...USAGE_A.cost, total: 0.24 },
  };
  const stallError = (usage?: ChildUsage) =>
    Object.assign(new Error('Subagent "x" stalled: no output for 300s'), {
      stalled: true,
      ...(usage ? { usage } : {}),
    });

  it("retries once on a stall and carries the burned usage into the result", async () => {
    const notes: Array<[string, string]> = [];
    let calls = 0;
    const outcomes: Array<Promise<ChildRun>> = [
      Promise.reject(stallError(USAGE_A)),
      Promise.resolve(RUN("done", USAGE_B)),
    ];
    const result = await withStallRetry(
      { label: "finder correctness/0", notify: (m, l) => notes.push([m, l]) },
      () => outcomes[calls++]!,
    );
    expect(calls).toBe(2);
    expect(result.text).toBe("done");
    expect(result.usage?.totalTokens).toBe(USAGE_A.totalTokens + USAGE_B.totalTokens);
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toContain("finder correctness/0 stalled");
    expect(notes[0][1]).toBe("warning");
  });

  it("gives up after the second stall with both attempts' usage on the error", async () => {
    const error = stallError(USAGE_B);
    let calls = 0;
    const outcomes: Array<Promise<ChildRun>> = [Promise.reject(stallError(USAGE_A)), Promise.reject(error)];
    await expect(withStallRetry({ label: "v", notify: () => {} }, () => outcomes[calls++]!)).rejects.toBe(error);
    expect(calls).toBe(2);
    // the first attempt's spend rides the terminal error — same identity, merged usage
    expect((error as Error & { usage?: ChildUsage }).usage?.totalTokens).toBe(
      USAGE_A.totalTokens + USAGE_B.totalTokens,
    );
  });

  it("does not retry failures that are not stalls", async () => {
    let calls = 0;
    await expect(
      withStallRetry({ label: "v", notify: () => {} }, () => {
        calls++;
        return Promise.reject(new Error("exited with code 2"));
      }),
    ).rejects.toThrow(/exited with code 2/);
    expect(calls).toBe(1);
  });

  it("does not retry when the review was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withStallRetry({ label: "v", notify: () => {}, signal: controller.signal }, () => {
        calls++;
        return Promise.reject(stallError());
      }),
    ).rejects.toThrow(/stalled/);
    expect(calls).toBe(1);
  });
});

describe("review tool", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "review-tool-"));
  type ToolExecute = (
    id: string,
    params: { target?: string; cwd?: string },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
  const register = () => {
    const tools = new Map<string, { description?: string; execute: ToolExecute }>();
    const pi = {
      registerTool: (t: { name: string; description?: string; execute: ToolExecute }) => tools.set(t.name, t),
      registerCommand: () => {},
      on: () => {},
    } as unknown as Parameters<typeof registerReview>[0];
    // repoRoot resolves to the sandbox: review state and report both land
    // inside the temp cwd instead of escaping to a real /repo
    const git = async (args: string[]) =>
      args[0] === "rev-parse" && args[1] === "--show-toplevel"
        ? { code: 0, stdout: `${sandbox}\n`, stderr: "" }
        : args[0] === "diff" && args[args.length - 1] === "HEAD"
          ? { code: 0, stdout: SAMPLE_DIFF, stderr: "" }
          : args[0] === "ls-files"
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
    const spawn = fakeSpawn((task) =>
      task.includes("Correctness and logic")
        ? '```json\n[{"file":"src/a.ts","line":2,"severity":"critical","title":"Bug","detail":"D"}]\n```'
        : "[]",
    );
    // writeFile stays real (defaults): the tool's report artifact is asserted
    // on disk; only git and child spawning are hermetic.
    registerReview(pi, {
      git,
      spawnFn: spawn,
      readFile: async () => undefined,
      sessionModel: null,
    });
    return { tools, spawn };
  };

  it("executes end to end: compact summary back, full report to a unique sanitized path", async () => {
    const { tools } = register();
    const tool = tools.get("review")!;
    const result = (await tool.execute("call_../../evil", {}, undefined, undefined, {
      cwd: sandbox,
      model: null,
    } as never)) as { content: Array<{ type: string; text: string }>; details: { findingCount: number } };
    expect(result.details.findingCount).toBe(1);
    const text = result.content[0].text;
    expect(text).toContain("1 finding(s): 1 critical.");
    expect(text).toContain("[critical] src/a.ts:2 — Bug");
    // traversal-safe filename, written for real, and the summary points at it
    const safe = "call_../../evil".replace(/[^a-zA-Z0-9_-]/g, "_") + ".md";
    const reportPath = path.join(sandbox, ".pi", "review", safe);
    expect(text).toContain(reportPath);
    expect(existsSync(reportPath)).toBe(true);
    const onDisk = readFileSync(reportPath, "utf8");
    expect(onDisk).toContain("# Code review");
    expect(onDisk).toContain("Bug");
  });

  it("surfaces bad targets as tool errors instead of throwing", async () => {
    const { tools } = register();
    const result = (await tools.get("review")!.execute("call_x", { target: "--model" }, undefined, undefined, {
      cwd: sandbox,
      model: null,
    } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("--model requires a model name");
  });

  /** Registration pinned to a given repo root: same wiring as register(),
   * but git resolves there — for testing reviews of another directory. */
  const registerIn = (repoRoot: string, deps: Record<string, unknown> = {}) => {
    const tools = new Map<string, { execute: ToolExecute }>();
    const pi = {
      registerTool: (t: { name: string; execute: ToolExecute }) => tools.set(t.name, t),
      registerCommand: () => {},
      on: () => {},
    } as unknown as Parameters<typeof registerReview>[0];
    registerReview(pi, {
      git: async (args: string[]) =>
        args[0] === "rev-parse" && args[1] === "--show-toplevel"
          ? { code: 0, stdout: `${repoRoot}\n`, stderr: "" }
          : args[0] === "diff"
            ? { code: 0, stdout: SAMPLE_DIFF, stderr: "" }
            : { code: 0, stdout: "", stderr: "" },
      readFile: async () => undefined,
      sessionModel: null,
      ...deps,
    });
    return tools;
  };

  it("reviews another directory via cwd: children run there and the report lands there", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "review-tool-other-"));
    const cwds: Array<string | undefined> = [];
    const spawn = ((_command: string, _args: string[], options: unknown) => {
      cwds.push((options as { cwd?: string }).cwd);
      return childWithMessage("[]");
    }) as SpawnFn;
    const tools = registerIn(other, { spawnFn: spawn });
    const result = (await tools
      .get("review")!
      .execute("call_other", { cwd: other, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { content: Array<{ type: string; text: string }> };
    // git root of the reviewed directory — every child explores the reviewed repo
    expect(cwds.length).toBeGreaterThan(0);
    expect(new Set(cwds)).toEqual(new Set([other]));
    // the report is written into the reviewed project, and the summary points there
    const reportPath = path.join(other, ".pi", "review", "call_other.md");
    expect(result.content[0].text).toContain(reportPath);
    expect(existsSync(reportPath)).toBe(true);

    // a path-shaped target names the directory too — the two surfaces must
    // agree, never silently drop the path and review the session repo. A
    // blank cwd defers to it as well, since resolveReviewCwd treats "" as unset.
    const byTarget = (await tools.get("review")!.execute("call_tgt", { target: other }, undefined, undefined, {
      cwd: sandbox,
      model: null,
    } as never)) as { content: Array<{ type: string; text: string }> };
    expect(new Set(cwds)).toEqual(new Set([other])); // still only the reviewed repo
    expect(byTarget.content[0].text).toContain(path.join(other, ".pi", "review", "call_tgt.md"));

    const byBlankCwd = (await tools
      .get("review")!
      .execute("call_blank", { cwd: "   ", target: other }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { content: Array<{ type: string; text: string }> };
    expect(byBlankCwd.content[0].text).toContain(path.join(other, ".pi", "review", "call_blank.md"));
  });

  it("fails fast on a cwd that is not a directory, before spawning anything", async () => {
    const { tools, spawn } = register();
    const result = (await tools
      .get("review")!
      .execute("call_x", { cwd: "/nonexistent/review/dir" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no such directory");
    expect(spawn.tasks).toHaveLength(0); // no children burned on a doomed path
  });

  it("fails fast on a cwd that names a file", async () => {
    const { tools, spawn } = register();
    const filePath = path.join(sandbox, "plain-file.txt");
    writeFileSync(filePath, "not a directory");
    const result = (await tools.get("review")!.execute("call_x", { cwd: filePath }, undefined, undefined, {
      cwd: sandbox,
      model: null,
    } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a directory");
    expect(spawn.tasks).toHaveLength(0);
  });

  it("skips the check command in a foreign directory unless PI_REVIEW_CHECK_FOREIGN is set", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "review-tool-check-"));
    const shellCalls: string[] = [];
    const tools = registerIn(other, {
      spawnFn: fakeSpawn(() => "[]"),
      shell: async (cmd: string) => {
        shellCalls.push(cmd);
        return "check output";
      },
    });
    const prevCmd = process.env.PI_REVIEW_CHECK_CMD;
    const prevForeign = process.env.PI_REVIEW_CHECK_FOREIGN;
    process.env.PI_REVIEW_CHECK_CMD = "npm run check";
    delete process.env.PI_REVIEW_CHECK_FOREIGN;
    try {
      // default: a foreign repo's scripts are untrusted — the command must not run
      await tools.get("review")!.execute("call_skip", { cwd: other, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never);
      expect(shellCalls).toHaveLength(0);
      const report = readFileSync(path.join(other, ".pi", "review", "call_skip.md"), "utf8");
      expect(report).toContain("check command skipped");
      expect(report).toContain("PI_REVIEW_CHECK_FOREIGN=1");
      // explicit opt-in: the command runs, no skip note
      process.env.PI_REVIEW_CHECK_FOREIGN = "1";
      await tools.get("review")!.execute("call_run", { cwd: other, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never);
      expect(shellCalls).toEqual(["npm run check"]);
      expect(readFileSync(path.join(other, ".pi", "review", "call_run.md"), "utf8")).not.toContain(
        "check command skipped",
      );
    } finally {
      if (prevCmd === undefined) delete process.env.PI_REVIEW_CHECK_CMD;
      else process.env.PI_REVIEW_CHECK_CMD = prevCmd;
      if (prevForeign === undefined) delete process.env.PI_REVIEW_CHECK_FOREIGN;
      else process.env.PI_REVIEW_CHECK_FOREIGN = prevForeign;
    }
  });

  it("treats an alternate spelling of the session directory as not foreign", async () => {
    // A symlinked alias of the session dir is the same directory on disk —
    // sameDirectory must see through the spelling (macOS /var vs /private/var
    // is the real-world case). Built deterministically so the canonical-
    // identity logic runs on every platform, not just alias-spelled tmpdirs.
    const alias = path.join(tmpdir(), `review-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(sandbox, alias);
    const shellCalls: string[] = [];
    const tools = registerIn(alias, {
      spawnFn: fakeSpawn(() => "[]"),
      shell: async (cmd: string) => {
        shellCalls.push(cmd);
        return null;
      },
    });
    const prevCmd = process.env.PI_REVIEW_CHECK_CMD;
    const prevForeign = process.env.PI_REVIEW_CHECK_FOREIGN;
    process.env.PI_REVIEW_CHECK_CMD = "npm run check";
    delete process.env.PI_REVIEW_CHECK_FOREIGN;
    try {
      await tools.get("review")!.execute("call_alias", { cwd: alias, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never);
      expect(shellCalls).toEqual(["npm run check"]); // same repo: the check runs
      expect(readFileSync(path.join(alias, ".pi", "review", "call_alias.md"), "utf8")).not.toContain(
        "check command skipped",
      );
    } finally {
      rmSync(alias, { force: true }); // removes the link, never the target
      if (prevCmd === undefined) delete process.env.PI_REVIEW_CHECK_CMD;
      else process.env.PI_REVIEW_CHECK_CMD = prevCmd;
      if (prevForeign === undefined) delete process.env.PI_REVIEW_CHECK_FOREIGN;
      else process.env.PI_REVIEW_CHECK_FOREIGN = prevForeign;
    }
  });

  it("anchors the report to the owning repo, not the reviewed subdirectory", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "review-tool-sub-"));
    const sub = path.join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const tools = registerIn(repo, { spawnFn: fakeSpawn(() => "[]") });
    const result = (await tools.get("review")!.execute("call_sub", { cwd: sub, target: "tree" }, undefined, undefined, {
      cwd: sandbox,
      model: null,
    } as never)) as { content: Array<{ text: string }> };
    // The report and the review-state.json priors share <repo>/.pi — the
    // summary points there, not at packages/app/.pi.
    const reportPath = path.join(repo, ".pi", "review", "call_sub.md");
    expect(result.content[0].text).toContain(reportPath);
    expect(existsSync(reportPath)).toBe(true);
  });

  it("refuses to write the report through a symlinked .pi in the reviewed repo", async () => {
    const hostile = mkdtempSync(path.join(tmpdir(), "review-tool-link-"));
    symlinkSync(tmpdir(), path.join(hostile, ".pi")); // committed .pi -> elsewhere
    const spawn = fakeSpawn(() => "[]");
    const tools = registerIn(hostile, { spawnFn: spawn });
    const result = (await tools
      .get("review")!
      .execute("call_x", { cwd: hostile, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("symlink");
    expect(spawn.tasks).toHaveLength(0); // refused pre-flight, before children spawn
  });

  it("refuses pre-flight when .pi is committed as a regular file, before spawning anything", async () => {
    const hostile = mkdtempSync(path.join(tmpdir(), "review-tool-file-pi-"));
    writeFileSync(path.join(hostile, ".pi"), "not a directory");
    const spawn = fakeSpawn(() => "[]");
    const tools = registerIn(hostile, { spawnFn: spawn });
    const result = (await tools
      .get("review")!
      .execute("call_x", { cwd: hostile, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-directory");
    expect(spawn.tasks).toHaveLength(0);
  });

  it("returns the finished review even when the report write fails", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "review-tool-readonly-"));
    const tools = registerIn(other, {
      spawnFn: fakeSpawn(() => "[]"),
      writeFile: async () => {
        throw new Error("EACCES: read-only file system");
      },
    });
    const result = (await tools
      .get("review")!
      .execute("call_ro", { cwd: other, target: "tree" }, undefined, undefined, {
        cwd: sandbox,
        model: null,
      } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    // The write is best-effort: the paid-for review is returned, with a note —
    // and no dangling "Full report:" pointer to the file that was never written
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("could not be written");
    expect(result.content[0].text).toContain("read-only");
    expect(result.content[0].text).not.toContain("Full report:");
  });

  it("carries pipeline notes inline when the report write fails", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "review-tool-notes-"));
    const tools = registerIn(other, {
      spawnFn: fakeSpawn(() => "[]"),
      writeFile: async () => {
        throw new Error("EACCES: read-only file system");
      },
    });
    const prevCmd = process.env.PI_REVIEW_CHECK_CMD;
    const prevForeign = process.env.PI_REVIEW_CHECK_FOREIGN;
    process.env.PI_REVIEW_CHECK_CMD = "npm run check";
    delete process.env.PI_REVIEW_CHECK_FOREIGN; // foreign dir: skip is on by default
    try {
      const result = (await tools
        .get("review")!
        .execute("call_notes", { cwd: other, target: "tree" }, undefined, undefined, {
          cwd: sandbox,
          model: null,
        } as never)) as { isError?: boolean; content: Array<{ text: string }> };
      // The report file was the disclosure channel; with the write gone, the
      // check-command-skip note must ride in the message itself.
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("check command skipped");
      expect(result.content[0].text).toContain("could not be written");
    } finally {
      if (prevCmd === undefined) delete process.env.PI_REVIEW_CHECK_CMD;
      else process.env.PI_REVIEW_CHECK_CMD = prevCmd;
      if (prevForeign === undefined) delete process.env.PI_REVIEW_CHECK_FOREIGN;
      else process.env.PI_REVIEW_CHECK_FOREIGN = prevForeign;
    }
  });
});

describe("runReview", () => {
  it("parses the verify opt-out knob (on by default)", () => {
    expect(parseReviewConfig({}).verify).toBe(true);
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "1" }).verify).toBe(true);
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "true" }).verify).toBe(true);
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "0" }).verify).toBe(false);
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "false" }).verify).toBe(false);
    // Blank and garbage keep the on-by-default (sibling-knob convention:
    // unset/invalid falls to the default, only explicit opt-outs disable).
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "" }).verify).toBe(true);
    expect(parseReviewConfig({ PI_REVIEW_VERIFY: "garbage" }).verify).toBe(true);
  });

  it("skips verification when the knob is off and discloses it in the report", async () => {
    const spawn = fakeSpawn((task) => {
      if (task.includes("Correctness and logic")) {
        return '```json\n[{"file":"src/a.ts","line":2,"severity":"critical","title":"Bug","detail":"D"}]\n```';
      }
      return "[]";
    });
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "default" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    // finders ran, no verify child, finding survives unverified but disclosed
    expect(spawn.tasks.filter((t) => t.startsWith("# Verify"))).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    expect(result.report).toContain("Verification skipped (PI_REVIEW_VERIFY=0)");
  });

  const NOT_A_REPO = {
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  };

  it("reviews a non-git tree as its whole tree", async () => {
    const spawn = fakeSpawn(() => "[]");
    const listDir = listDirFor({
      "/repo": [
        ["a.ts", "f"],
        ["src", "d"],
        ["package-lock.json", "f"],
        [".env", "f"],
        ["link.ts", "l"],
      ],
      "/repo/src": [["b.ts", "f"]],
    });
    const readFile = async (p: string): Promise<string | undefined> =>
      p === "/repo/a.ts" ? "const a = 1;\n" : p === "/repo/src/b.ts" ? "const b = 2;\n" : undefined;
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "default" },
      deps: emptyDeps({
        git: async () => NOT_A_REPO,
        spawnFn: spawn,
        readFile,
        listDir,
      }) as never,
    });
    expect(result.report).toContain("# Code review — whole tree (no git repository)");
    expect(result.report).toContain("- Files: a.ts, src/b.ts"); // walked tree is the review scope
    expect(result.report).not.toContain("package-lock.json"); // exclusion list applies
    // credential-shaped files and symlinks are skipped and the omission disclosed
    expect(result.report).toContain("likely-credential file(s) skipped and not reviewed: .env");
    expect(result.report).toContain("1 symlink(s) skipped (not followed): link.ts");
    // the finder children saw the synthetic new-file diffs
    expect(spawn.tasks.some((t) => t.includes("diff --git a/a.ts b/a.ts"))).toBe(true);
    expect(spawn.tasks.some((t) => t.includes("diff --git a/src/b.ts b/src/b.ts"))).toBe(true);
    // no git listing is attempted for untracked files — there is no git
    expect(result.report).not.toContain("untracked");
  });

  it("reports an empty non-git tree cleanly", async () => {
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git: async () => NOT_A_REPO,
        listDir: listDirFor({ "/repo": [] }),
      }) as never,
    });
    expect(result.report).toContain("No changes to review (no reviewable files in the tree).");
  });

  it("rejects git-only targets in a non-git tree with a pointer to whole-tree mode", async () => {
    await expect(
      runReview({
        cwd: "/repo",
        config: CONFIG({ verify: false }),
        target: { kind: "staged" },
        deps: emptyDeps({ git: async () => NOT_A_REPO }) as never,
      }),
    ).rejects.toThrow('no git repository — "staged changes" needs git history');
    await expect(
      runReview({
        cwd: "/repo",
        config: CONFIG({ verify: false }),
        target: { kind: "range", base: "a", head: "b" },
        deps: emptyDeps({ git: async () => NOT_A_REPO }) as never,
      }),
    ).rejects.toThrow("no git repository");
  });

  it("still fails loudly when git breaks for a reason other than a missing repo", async () => {
    await expect(
      runReview({
        cwd: "/repo",
        config: CONFIG({ verify: false }),
        target: { kind: "default" },
        deps: emptyDeps({ git: async () => ({ code: 1, stdout: "", stderr: "spawn git ENOENT" }) }) as never,
      }),
    ).rejects.toThrow("git rev-parse failed: spawn git ENOENT");
  });

  it("names the cap that truncated a tree walk, and bounds the name lists in notes", async () => {
    // Files cap: 5_100 collectable files — the walk stops at 5_000 and says so.
    // readFile reports every file missing, so the section is empty and the
    // early-return report carries the pipeline notes (which is what we assert).
    const many = Array.from({ length: 5_100 }, (_, i) => [`f${i}.ts`, "f"] as [string, "f"]);
    const byFiles = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "default" },
      deps: emptyDeps({
        git: async () => NOT_A_REPO,
        listDir: listDirFor({ "/repo": many }),
      }) as never,
    });
    expect(byFiles.report).toContain("tree walk stopped at 5000 files — later files not reviewed");

    // Entries cap: 50_050 secret-shaped files — nothing is ever collected, so
    // only the WORK bound can fire; the note names entries, not files, and the
    // skipped-secret name list is capped at 50 with the remainder counted.
    const secrets = Array.from({ length: 50_050 }, (_, i) => [`.env.${i}`, "f"] as [string, "f"]);
    const byEntries = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false }),
      target: { kind: "default" },
      deps: emptyDeps({
        git: async () => NOT_A_REPO,
        listDir: listDirFor({ "/repo": secrets }),
      }) as never,
    });
    expect(byEntries.report).toContain("tree walk stopped at 50000 visited entries — later entries not reviewed");
    expect(byEntries.report).toContain("likely-credential file(s) skipped and not reviewed: .env.");
    expect(byEntries.report).toContain("…and 49950 more"); // 50_000 visited secrets, 50 named
  });

  it("runs finder and verifier children with cwd at the reviewed repo root, not the session cwd", async () => {
    const cwds: Array<string | undefined> = [];
    const spawn = ((_command: string, args: string[], options: unknown) => {
      cwds.push((options as { cwd?: string }).cwd);
      const dash = args.lastIndexOf("--");
      const task = dash >= 0 ? String(args[dash + 1]) : "";
      return childWithMessage(
        task.includes("Correctness and logic")
          ? '```json\n[{"file":"src/a.ts","line":2,"severity":"important","title":"Bug","detail":"D"}]\n```'
          : "[]",
      );
    }) as SpawnFn;
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    // Session cwd is a subdirectory; the repo root (where diff paths point)
    // is what children must explore.
    await runReview({
      cwd: "/repo/packages/app",
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    expect(cwds.length).toBeGreaterThanOrEqual(5); // four finders + the verifier
    expect(new Set(cwds)).toEqual(new Set(["/repo"]));
  });

  it("prepends wiring notes to the report's pipeline notes, even with no errors", async () => {
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git }) as never,
      notes: ["check command skipped (npm run check): foreign directory"],
    });
    expect(result.report).toContain("**Pipeline notes**");
    expect(result.report).toContain("- check command skipped");
    expect(result.notes).toEqual(["check command skipped (npm run check): foreign directory"]);
  });

  it("keeps wiring notes on the empty-review early return too", async () => {
    // A clean foreign tree is exactly where the check-command-skip disclosure
    // must still surface — the early return must not drop it.
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      { match: (a) => a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } }, // clean tree
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git }) as never,
      notes: ["check command skipped (npm run check): foreign directory"],
    });
    expect(result.report).toContain("No changes to review");
    expect(result.report).toContain("**Pipeline notes**");
    expect(result.report).toContain("check command skipped");
  });

  it("refuses to persist review state through a symlinked .pi in the reviewed repo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-persist-link-"));
    symlinkSync(tmpdir(), path.join(root, ".pi")); // committed .pi -> elsewhere
    const written: string[] = [];
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: root,
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, writeFile: async (p: string) => void written.push(p) }) as never,
    });
    expect(written).toHaveLength(0); // best-effort skip, not a redirected write
  });

  it("refuses to persist through a symlinked review-state.json even when .pi is real", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-persist-leaf-"));
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    // git preserves symlinks: the state file itself can be the committed hook
    symlinkSync(tmpdir(), path.join(root, ".pi", "review-state.json"));
    const written: string[] = [];
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: root,
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, writeFile: async (p: string) => void written.push(p) }) as never,
    });
    expect(written).toHaveLength(0);
  });

  it("does not read prior state through a symlinked review-state.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-prior-guard-"));
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    symlinkSync(tmpdir(), path.join(root, ".pi", "review-state.json")); // -> /dev/zero, ~/.ssh, ...
    const reads: string[] = [];
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    const result = await runReview({
      cwd: root,
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git,
        readFile: async (p: string) => {
          reads.push(p);
          return `{"findings": [], "target": "uncommitted changes"}`;
        },
      }) as never,
    });
    expect(reads).not.toContain(path.join(root, ".pi", "review-state.json")); // guarded before the read
    expect(result.report).not.toContain("Continuing from a previous review"); // no priors injected
  });

  it("does not read prior state through a symlinked .pi directory either", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-prior-dirlink-"));
    const elsewhere = mkdtempSync(path.join(tmpdir(), "review-prior-else-"));
    mkdirSync(path.join(elsewhere, ".pi"), { recursive: true });
    writeFileSync(
      path.join(elsewhere, ".pi", "review-state.json"),
      JSON.stringify({ target: "uncommitted changes", findings: [] }),
    );
    symlinkSync(path.join(elsewhere, ".pi"), path.join(root, ".pi")); // committed .pi -> elsewhere
    const reads: string[] = [];
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    await runReview({
      cwd: root,
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git,
        readFile: async (p: string) => {
          reads.push(p);
          return `{"findings": [], "target": "uncommitted changes"}`;
        },
      }) as never,
    });
    expect(reads).not.toContain(path.join(root, ".pi", "review-state.json"));
  });

  it("does not read untracked files through committed symlinks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-untracked-link-"));
    const secret = mkdtempSync(path.join(tmpdir(), "review-secret-"));
    writeFileSync(path.join(secret, "id_rsa"), "TOPSECRET-SYMLINK-LEAK");
    symlinkSync(path.join(secret, "id_rsa"), path.join(root, "leak")); // untracked leak -> secret
    writeFileSync(path.join(root, "ok.txt"), "legitimate new file\n"); // so a chunk exists to carry the note
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      { match: (a) => a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "leak\nok.txt\n", stderr: "" } },
    ]);
    const spawn = fakeSpawn(() => "[]");
    const result = await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    // The symlink target must not ride the synthetic diff into finder tasks —
    // and the refusal is NAMED with its cause (a guard refusal must not
    // masquerade as a size-budget skip, which would misdirect the finder).
    expect(result.report).not.toContain("TOPSECRET-SYMLINK-LEAK");
    const task = spawn.tasks.join("");
    expect(task).not.toContain("TOPSECRET-SYMLINK-LEAK");
    expect(task).toContain("legitimate new file"); // the readable file still rides
    expect(task).toContain("leak"); // the refused one is named…
    expect(task).toContain("symlink escape"); // …with its true cause…
    expect(task).not.toContain("size budget"); // …not the budget label
  });

  it("discloses all-refused untracked files in pipeline notes, not as reviewable content", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-untracked-only-link-"));
    const secret = mkdtempSync(path.join(tmpdir(), "review-secret-"));
    writeFileSync(path.join(secret, "id_rsa"), "TOPSECRET-SYMLINK-LEAK");
    symlinkSync(path.join(secret, "id_rsa"), path.join(root, "leak")); // the ONLY untracked entry
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      { match: (a) => a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "leak\n", stderr: "" } },
    ]);
    const spawn = fakeSpawn(() => "[]");
    const result = await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    // No diff to review — but the report must say WHY (read-guard refusal),
    // not the misleading "all files are excluded" list with nothing in it.
    expect(result.report).toContain("No changes to review");
    expect(result.report).not.toContain("All changed files are excluded");
    expect(result.report).toContain("read guard");
    expect(result.report).toContain("leak");
    expect(result.report).not.toContain("TOPSECRET-SYMLINK-LEAK");
    expect(result.notes.join("\n")).toContain("leak");
  });

  it("still attaches real on-disk changed files, not just guard refusals", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-attach-real-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.ts"), 'const greet = () => "hello window";\n');
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const old = 1;",
      "+const greet = 2;",
    ].join("\n");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: diff, stderr: "" },
      },
    ]);
    const spawn = fakeSpawn(() => "[]");
    await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    // The anchored read must not be over-eager: a legit file on disk still
    // contributes its window to the task.
    const task = spawn.tasks.join("");
    expect(task).toContain("### src/app.ts");
    expect(task).toContain("hello window");
  });

  it("does not attach a changed file's body through a committed symlink", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-attach-link-"));
    const secret = mkdtempSync(path.join(tmpdir(), "review-secret-"));
    writeFileSync(path.join(secret, "id_rsa"), "TOPSECRET-SYMLINK-LEAK");
    symlinkSync(path.join(secret, "id_rsa"), path.join(root, "leak")); // changed leak -> secret
    const diff = [
      "diff --git a/leak b/leak",
      "index 111..222 100644",
      "--- a/leak",
      "+++ b/leak",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: diff, stderr: "" },
      },
    ]);
    const spawn = fakeSpawn(() => "[]");
    const result = await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    expect(spawn.tasks.length).toBeGreaterThan(0); // finders ran with the diff
    const task = spawn.tasks.join("");
    expect(task).not.toContain("TOPSECRET-SYMLINK-LEAK");
    expect(result.report).not.toContain("TOPSECRET-SYMLINK-LEAK");
    // The refusal carries its own cause — not the "over budget — read them if
    // needed" invitation, which would point the child straight at the path
    // the guard exists to keep out of the prompt.
    expect(task).toContain("Files not attached — unreadable");
    expect(task).toContain("leak");
  });

  it("keeps hunk-centered windows for large-but-windowable changed files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-attach-window-"));
    // ~300KB source with a 1-line change: over nothing that matters, under
    // ATTACH_MAX_BYTES — the window, not the whole file, must ride the task.
    const lines = ["const start = 1;", "WINDOW-MARKER-NEARBY", ...Array.from({ length: 40_000 }, (_, i) => `f${i}`)];
    writeFileSync(path.join(root, "big.ts"), lines.join("\n"));
    const diff = [
      "diff --git a/big.ts b/big.ts",
      "index 111..222 100644",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,1 +1,1 @@",
      "-const start = 0;",
      "+const start = 1;",
    ].join("\n");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: diff, stderr: "" },
      },
    ]);
    const spawn = fakeSpawn(() => "[]");
    await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    const task = spawn.tasks.join("");
    expect(task).toContain("### big.ts");
    expect(task).toContain("WINDOW-MARKER-NEARBY"); // context near the hunk survives
    expect(task).not.toContain("f39999"); // the far tail is elided, not the whole file attached
  });

  it("names changed files the attachment guard refuses in the skipped note", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-attach-huge-"));
    // Over the whole-file read bound (ATTACH_MAX_BYTES): refused before any
    // read, named in the skipped note. Sub-bound files keep their windows.
    writeFileSync(path.join(root, "big.ts"), "Z".repeat(4_000_001));
    const diff = [
      "diff --git a/big.ts b/big.ts",
      "index 111..222 100644",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: `${root}\n`, stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: diff, stderr: "" },
      },
    ]);
    const spawn = fakeSpawn(() => "[]");
    await runReview({
      cwd: root,
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: realReadFile }) as never,
    });
    const task = spawn.tasks.join("");
    expect(task).toContain("Files not attached"); // the refusal is disclosed…
    expect(task).toContain("big.ts");
    expect(task).toContain("read them if needed"); // …as a readable file over budget, not "unreadable"
    expect(task).not.toContain("ZZZZZZ"); // …and the oversized body never rides along
  });

  it("bails out on an abort signal instead of failing open", async () => {
    const spawn = fakeSpawn(() => "```json\n[]\n```");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    const controller = new AbortController();
    controller.abort(); // Esc before the finders even start
    await expect(
      runReview({
        cwd: "/repo",
        config: CONFIG(),
        target: { kind: "default" },
        deps: emptyDeps({ git, spawnFn: spawn }) as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow("review aborted");
    // children never spawned: cancellation must not burn tokens
    expect(spawn.tasks).toHaveLength(0);
  });

  it("stops queued finders when aborted mid-run", async () => {
    // Two oversized files force two chunks x four lenses = 8 runs; the pool
    // starts four and queues four. Aborting on the first spawn must stop the
    // queued closures from ever spawning.
    const big = `+${"x".repeat(9_000)}`;
    const multi = `diff --git a/src/big1.ts b/src/big1.ts\n@@ -0,0 +1 @@\n${big}\ndiff --git a/src/big2.ts b/src/big2.ts\n@@ -0,0 +1 @@\n${big}\n`;
    const controller = new AbortController();
    const notes: Array<{ message: string; level: string }> = [];
    const spawn = fakeSpawn(() => {
      controller.abort();
      return "[]";
    });
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      { match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD", result: { code: 0, stdout: multi, stderr: "" } },
    ]);
    await expect(
      runReview({
        cwd: "/repo",
        config: CONFIG({ chunkChars: 8_000 }),
        target: { kind: "default" },
        deps: emptyDeps({
          git,
          spawnFn: spawn,
          notify: (message: string, level: "info" | "warning" | "error") => notes.push({ message, level }),
        }) as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow("review aborted");
    // first batch of four spawned; the queued four never did
    expect(spawn.tasks.length).toBeLessThan(8);
    // the user's own cancel is not a finder failure — no 'failed' warnings fire
    expect(notes.filter((n) => /finder \S+ failed \(/.test(n.message))).toEqual([]);
  });

  it("runs find → verify → report over the default target and persists state", async () => {
    const spawn = fakeSpawn((task) => {
      if (task.includes("Correctness and logic")) {
        return '```json\n[{"file":"src/a.ts","line":2,"severity":"important","title":"Off-by-one","detail":"Loop exits early.","recommendation":"Use <="}]\n```';
      }
      if (task.includes("Security")) {
        return '```json\n[{"file":"src/a.ts","line":3,"severity":"critical","title":"off-by-one off by one","detail":"Same bug, worse."}]\n```';
      }
      if (task.startsWith("# Verify")) {
        return '```json\n[{"id":1,"verdict":"confirmed","reason":"traced"},{"id":2,"verdict":"downgraded","severity":"important","reason":"same issue"}]\n```';
      }
      return "[]";
    });
    const written: Array<[string, string]> = [];
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      { match: (a) => a.includes("@{upstream}"), result: { code: 1, stdout: "", stderr: "no upstream" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ persist: true }),
      target: { kind: "default" },
      deps: emptyDeps({
        git,
        spawnFn: spawn,
        readFile: async (p: string) => (p === "/repo/.pi/review-state.json" ? undefined : undefined),
        writeFile: async (p: string, d: string) => void written.push([p, d]),
      }) as never,
    });
    // one finder per lens + 1 verify (this fixture opts into verification)
    expect(spawn.tasks).toHaveLength(FINDER_LENSES.length + 1);
    expect(spawn.tasks.filter((t) => t.startsWith("# Verify"))).toHaveLength(1);
    // security + correctness merge into one finding (the id-2 downgrade verdict is
    // out of range for 0-based ids, so critical stands — worst-severity-wins)
    expect(result.findingCount).toBe(1);
    // structured findings are the same data the report renders — eval relies on this
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "critical", title: "Off-by-one", lenses: ["correctness", "security"] }),
    ]);
    expect(result.report).toContain("Off-by-one");
    expect(result.report).toContain("found by correctness, security");
    expect(result.report).toContain("changes ahead of upstream plus working tree");
    // state persisted with the final findings
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe("/repo/.pi/review-state.json");
    const state = JSON.parse(written[0][1]);
    expect(state.findings).toHaveLength(1);
  });

  it("caps structured findings at maxFindings, not just the report", async () => {
    const spawn = fakeSpawn((task) => {
      if (task.includes("Correctness and logic")) {
        // far-apart lines: proximity merge (±3 lines) would collapse adjacent ones
        const findings = [1, 40, 80].map((n) => ({
          file: "src/a.ts",
          line: n,
          severity: "critical",
          title: `Bug ${n}`,
          detail: "D",
        }));
        return `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``;
      }
      return "[]";
    });
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ maxFindings: 2 }),
      target: { kind: "default" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    expect(result.findings.map((f) => f.title)).toEqual(["Bug 1", "Bug 40"]);
    expect(result.findingCount).toBe(2);
  });

  it("includes upstream-ahead and untracked sections for the default target", async () => {
    const spawn = fakeSpawn(() => "[]");
    const reads = new Map<string, string | undefined>([["/repo/new.ts", "hello\n"]]);
    const git = gitFor([
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel",
        result: { code: 0, stdout: "/repo\n", stderr: "" },
      },
      { match: (a) => a.includes("@{upstream}"), result: { code: 0, stdout: "origin/main\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a.includes("origin/main...HEAD"),
        result: { code: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n+ahead change", stderr: "" },
      },
      { match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD", result: { code: 0, stdout: "", stderr: "" } },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "new.ts\n", stderr: "" } },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "default" },
      deps: emptyDeps({ git, spawnFn: spawn, readFile: async (p: string) => reads.get(p) }) as never,
    });
    // the finder task must contain both the ahead diff and the synthesized untracked file
    const finderTaskText = spawn.tasks.find((t) => t.includes("Correctness"))!;
    expect(finderTaskText).toContain("+ahead change");
    expect(finderTaskText).toContain("+++ b/new.ts");
    expect(result.findingCount).toBe(0);
    expect(result.report).toContain("**No actionable findings.**");
  });

  it("fails open when the verifier dies (verify opted in)", async () => {
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const failing = fakeSpawn(
      (task) =>
        task.includes("Correctness and logic")
          ? '```json\n[{"file":"src/a.ts","line":2,"severity":"critical","title":"Bug","detail":"D"}]\n```'
          : "[]",
      { failVerify: true },
    );
    const openResult = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: failing }) as never,
    });
    expect(openResult.report).toContain("**unverified**");
    expect(openResult.report).toContain("verification failed");
    expect(openResult.findingCount).toBe(1);
  });

  it("detects a stalled finder early, retries it, and keeps full coverage", async () => {
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    // The correctness finder's first child is a dead request; its second succeeds.
    const spawn = spawnWithStalls(
      (task, attempt) => attempt === 1 && task.includes("Correctness and logic"),
      () => "[]",
    );
    const notes: string[] = [];
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, idleTimeoutMs: 20 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn, notify: (m: string) => notes.push(m) }) as never,
    });
    // the stalled finder ran twice: one dead attempt + one recovery
    expect(spawn.tasks.filter((t) => t.includes("Correctness and logic"))).toHaveLength(2);
    expect(result.coverage.errors).toEqual([]);
    expect(result.coverage.lensCoverage[0]).toContain("correctness");
    expect(result.report).not.toContain("NOT COVERED");
    expect(notes.some((n) => n.includes("stalled"))).toBe(true);
  });

  it("discloses a twice-stalled finder as a coverage gap instead of hanging", async () => {
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    // Every attempt of the correctness finder is a dead request: one retry, then honesty.
    const spawn = spawnWithStalls(
      (task) => task.includes("Correctness and logic"),
      () => "[]",
    );
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: false, idleTimeoutMs: 20 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    expect(spawn.tasks.filter((t) => t.includes("Correctness and logic"))).toHaveLength(2);
    expect(result.coverage.errors[0]).toMatch(/finder correctness\/0: .* stalled/);
    expect(result.coverage.lensCoverage[0]).not.toContain("correctness");
    expect(result.report).toContain("stalled");
  });

  it("retries a stalled verifier once, then fails open", async () => {
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const spawn = spawnWithStalls(
      (task) => task.startsWith("# Verify"),
      (task) =>
        task.includes("Correctness and logic")
          ? '```json\n[{"file":"src/a.ts","line":2,"severity":"critical","title":"Bug","detail":"D"}]\n```'
          : "[]",
    );
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG({ verify: true, idleTimeoutMs: 20 }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    expect(spawn.tasks.filter((t) => t.startsWith("# Verify"))).toHaveLength(2);
    expect(result.report).toContain("**unverified**");
    expect(result.report).toMatch(/verification failed: .* stalled/);
    expect(result.findingCount).toBe(1);
  });

  it("passes prior findings to finders and the verifier", async () => {
    const prior = JSON.stringify({
      findings: [finding({ title: "Carried finding", severity: "suggestion" })],
      target: "uncommitted changes",
      savedAt: 1,
    });
    const spawn = fakeSpawn((task) => {
      if (task.includes("Correctness and logic")) {
        return '```json\n[{"file":"src/a.ts","line":2,"severity":"important","title":"Carried finding","detail":"still here"}]\n```';
      }
      return "[]";
    });
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git,
        spawnFn: spawn,
        readFile: async (p: string) => (p === "/repo/.pi/review-state.json" ? prior : undefined),
      }) as never,
    });
    for (const task of spawn.tasks) {
      expect(task).toContain("Carried finding");
    }
    expect(spawn.tasks.find((t) => t.startsWith("# Verify"))).toBeDefined();
  });

  it("ignores prior findings saved for a different target", async () => {
    const prior = JSON.stringify({
      findings: [finding({ title: "Stale finding" })],
      target: "changes since main",
      savedAt: 1,
    });
    const spawn = fakeSpawn(() => "[]");
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ persist: true }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({
        git,
        spawnFn: spawn,
        readFile: async (p: string) => (p === "/repo/.pi/review-state.json" ? prior : undefined),
      }) as never,
    });
    for (const task of spawn.tasks) {
      expect(task).not.toContain("Stale finding");
    }
  });

  it("derives coverage from finder outcomes, not the plan", async () => {
    // Security finder dies (exit 1); its lens must not appear as coverage.
    const spawn = (() => {
      const tasks: string[] = [];
      const fn = ((_c: string, args: string[], _o: unknown) => {
        const task = String(args[args.lastIndexOf("--") + 1]);
        tasks.push(task);
        const fail = task.includes("Security");
        return childWithMessage(fail ? "finder crashed" : "[]", fail ? 1 : 0);
      }) as SpawnFn & { tasks: string[] };
      fn.tasks = tasks;
      return fn;
    })();
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawn }) as never,
    });
    expect(result.report).toContain("chunk 1: correctness, robustness");
    expect(result.report).toContain("finder security/0");
    expect(result.report).not.toContain("chunk 1: correctness, security");
  });

  it("runs the provided-diff seam end to end without touching git", async () => {
    const gitCalls: string[][] = [];
    const spawn = fakeSpawn((task) =>
      task.includes("Correctness and logic")
        ? '```json\n[{"file":"src/a.ts","line":2,"severity":"critical","title":"Bug","detail":"D"}]\n```'
        : "[]",
    );
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "default" },
      deps: emptyDeps({
        git: async (args: string[]) => {
          gitCalls.push(args);
          return { code: 1, stdout: "", stderr: "must not be called" };
        },
        spawnFn: spawn,
      }) as never,
      provided: {
        sections: [{ label: "fixture PR", text: SAMPLE_DIFF }],
        repoRoot: "/tmp/empty",
        targetLabel: "fixture PR",
      },
    });
    expect(gitCalls).toEqual([]); // the seam never touches git
    expect(result.findingCount).toBe(1);
    expect(result.report).toContain("fixture PR");
  });

  it("reports excluded files when nothing reviewable remains", async () => {
    const lockDiff = "diff --git a/package-lock.json b/package-lock.json\n+lockdata";
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: lockDiff, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const result = await runReview({
      cwd: "/repo",
      config: CONFIG(),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git }) as never,
    });
    expect(result.report).toContain("excluded from review");
    expect(result.report).toContain("package-lock.json");
  });

  it("feeds the check command output to the verifier", async () => {
    const seen: string[] = [];
    const spawnWithFinding = fakeSpawn((task) => {
      if (task.includes("Correctness and logic")) {
        return '```json\n[{"file":"src/a.ts","line":2,"severity":"suggestion","title":"S","detail":"D"}]\n```';
      }
      if (task.startsWith("# Verify")) {
        seen.push(task);
        return "```json\n[]\n```";
      }
      return "[]";
    });
    const git = gitFor([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } },
      {
        match: (a) => a[0] === "diff" && a[a.length - 1] === "HEAD",
        result: { code: 0, stdout: SAMPLE_DIFF, stderr: "" },
      },
      { match: (a) => a[0] === "ls-files", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    await runReview({
      cwd: "/repo",
      config: CONFIG({ checkCmd: "npm run check" }),
      target: { kind: "uncommitted" },
      deps: emptyDeps({ git, spawnFn: spawnWithFinding, shell: async () => "typecheck: 2 errors" }) as never,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("typecheck: 2 errors");
  });
});
