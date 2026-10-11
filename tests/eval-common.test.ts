import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyVerdicts, parseVerdicts } from "../extensions/review";
import type { Finding, Verdict } from "../extensions/review";
import {
  aggregateVerify,
  computeMetrics,
  heuristicMatches,
  judgeTask,
  leftovers,
  matchScore,
  parseJudge,
  prKeyFromUrl,
  loadBench,
  rebuildVerifyDiff,
  renderSummary,
  renderVerifyCompare,
  sampleFixtures,
  verifyRowStats,
  type GoldenIssue,
  type PrResult,
  type VerifyReplayRow,
} from "../scripts/eval-common";

const issue = (over: Partial<GoldenIssue> = {}): GoldenIssue => ({
  pr_url: "https://github.com/o/r/pull/1",
  source_repo: "o/r",
  pr_title: "Add pagination",
  issue_index: 1,
  comment: "forEach with async callbacks runs concurrently without being awaited",
  severity: "Critical",
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "src/api.py",
  line: 12,
  severity: "critical",
  title: "Unawaited async operations in forEach",
  detail: "Async callbacks inside forEach are fire-and-forget.",
  lenses: ["correctness"],
  ...over,
});

describe("prKeyFromUrl", () => {
  it("parses PR URLs into cache keys and rejects junk", () => {
    expect(prKeyFromUrl("https://github.com/calcom/cal.com/pull/8087")).toMatchObject({
      owner: "calcom",
      repo: "cal.com",
      number: 8087,
      key: "calcom--cal.com--8087",
    });
    expect(prKeyFromUrl("https://gitlab.com/x/y/merge_requests/1")).toBeNull();
    expect(prKeyFromUrl("not a url")).toBeNull();
  });
});

describe("loadBench + sampleFixtures", () => {
  it("loads the committed benchmark fixture and samples deterministically", () => {
    const fixtures = loadBench(path.join(__dirname, "..", "scripts", "eval", "data"));
    expect(fixtures.length).toBe(50);
    expect(fixtures.reduce((n, f) => n + f.issues.length, 0)).toBe(136);
    // severity domain is matched exact-case by computeMetrics' Critical/High
    // split — a refresh that changes casing must fail here, not silently bucket
    const severities = new Set(fixtures.flatMap((f) => f.issues.map((i) => i.severity)));
    expect([...severities].sort()).toEqual(["Critical", "High", "Low", "Medium"]);
    // issues sorted by index; diff non-empty; key matches url
    const f0 = fixtures[0];
    expect(f0.issues.map((i) => i.issue_index)).toEqual([...f0.issues.map((i) => i.issue_index)].sort((a, b) => a - b));
    expect(f0.diff.startsWith("diff --git")).toBe(true);
    const key = prKeyFromUrl(f0.prUrl)!.key;
    expect(f0.key).toBe(key);
    // same seed → same sample; different seed → (almost surely) different
    const a = sampleFixtures(fixtures, 5, 42).map((f) => f.key);
    const b = sampleFixtures(fixtures, 5, 42).map((f) => f.key);
    const c = sampleFixtures(fixtures, 5, 7).map((f) => f.key);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(sampleFixtures(fixtures, 0)).toEqual([]);
  });

  it("tolerates a diff with no matching issues", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-common-"));
    mkdirSync(path.join(dir, "diffs"));
    writeFileSync(path.join(dir, "diffs", "o--r--9.diff"), "diff --git a/x b/x\n+x");
    writeFileSync(
      path.join(dir, "crb-offline-issues.json"),
      JSON.stringify([issue({ pr_url: "https://github.com/o/r/pull/1" })]),
    );
    const fixtures = loadBench(dir);
    expect(fixtures).toHaveLength(0); // pull/9 has no issues; pull/1 has no diff
  });
});

describe("matching", () => {
  it("scores issue-side token coverage, robust to long findings", () => {
    // near-verbatim title but padded detail — containment stays high where Jaccard diluted
    const longFinding = finding({
      detail:
        "Async callbacks inside forEach are fire-and-forget, so the surrounding request pipeline continues before any of them settle, which can interleave commits and skew downstream analytics dashboards.",
    });
    expect(matchScore(longFinding, issue())).toBeGreaterThan(0.3);
    expect(matchScore(finding({ title: "Naming", detail: "rename variable" }), issue())).toBeLessThan(0.05);
  });

  it("heuristic matcher catches near-verbatim overlap and misses paraphrase-only cases", () => {
    const issues = [
      issue({ issue_index: 1 }),
      issue({ issue_index: 2, comment: "Inconsistent naming of exported function", severity: "Low" }),
    ];
    const caught = heuristicMatches([finding()], issues);
    expect(caught.has(1)).toBe(true);
    expect(caught.has(2)).toBe(false);
    expect(caught.get(1)).toBe(0);
    expect(heuristicMatches([], issues).size).toBe(0);
    // a single shared token is not a match even at high coverage of a tiny issue
    const tiny = [issue({ issue_index: 3, comment: "database pool", pr_title: "x" })];
    expect(heuristicMatches([finding({ title: "database locked under load", detail: "x y z" })], tiny).size).toBe(0);
  });

  it("judge task labels each list distinctly; parser accepts empty matches and rejects garbage", () => {
    const task = judgeTask([finding()], [issue()]);
    expect(task).toContain("## Golden issues");
    expect(task).toContain("ISSUE 1 [Critical]");
    expect(task).toContain("FINDING 1 [critical] src/api.py:12");
    expect(parseJudge('```json\n{"matches": [{"issue": 1, "finding": 1}]}\n```')).toEqual([{ issue: 1, finding: 1 }]);
    expect(parseJudge('```json\n{"matches": []}\n```')).toEqual([]);
    expect(parseJudge("no json here")).toBeNull();
    expect(parseJudge('```json\n{"matches": [{"issue": "x", "finding": 1}]}\n```')).toEqual([]);
  });
});

describe("computeMetrics + renderSummary", () => {
  const result = (over: Partial<PrResult> = {}): PrResult => ({
    prUrl: "https://github.com/o/r/pull/1",
    issues: [
      issue({ issue_index: 1, severity: "Critical" }),
      issue({ issue_index: 2, severity: "Low", comment: "other" }),
    ],
    findings: [finding(), finding({ title: "Unrelated", severity: "suggestion", lenses: ["security"] })],
    caught: new Map([[1, 0]]),
    matcher: "judge",
    totalTokens: 10_000,
    cost: 0.1,
    durationMs: 1_000,
    ...over,
  });

  it("leftovers pairs unmatched issues with unused findings and maps positions back", () => {
    const issues = [issue({ issue_index: 0 }), issue({ issue_index: 1 }), issue({ issue_index: 2, comment: "other" })];
    const findings = [finding(), finding({ title: "Second" }), finding({ title: "Third" })];
    const rest = leftovers(new Map([[0, 1]]), findings, issues);
    // issue 0 caught by finding 1 → leftovers are issues 1,2 and findings 0,2
    expect(rest.issues.map((i) => i.issue_index)).toEqual([1, 2]);
    expect(rest.findings.map((f) => f.title)).toEqual(["Unawaited async operations in forEach", "Third"]);
    expect(rest.issueOf).toEqual([1, 2]);
    expect(rest.findingOf).toEqual([0, 2]);
    // a judge match of leftover ISSUE 2 → leftover FINDING 1 lifts to originals 2→0
    expect(rest.issueOf[2 - 1]).toBe(2);
    expect(rest.findingOf[1 - 1]).toBe(0);
    expect(leftovers(new Map(), [], [])).toMatchObject({ issues: [], findings: [], issueOf: [], findingOf: [] });
  });

  it("computes recall, severity split, noise proxy, and lens attribution", () => {
    const m = computeMetrics([result(), result()]);
    expect(m.prs).toBe(2);
    expect(m.issuesTotal).toBe(4);
    expect(m.issuesCaught).toBe(2);
    expect(m.recall).toBe(0.5);
    expect(m.recallCriticalHigh).toBe(1);
    expect(m.recallMediumLow).toBe(0);
    expect(m.findingsPerPr).toBe(2);
    expect(m.unmatchedPerPr).toBe(1); // the "Unrelated" finding matched nothing
    expect(m.perLens.correctness).toEqual({ caught: 2, findings: 2 });
    expect(m.perLens.security).toEqual({ caught: 0, findings: 2 });
    expect(m.totalTokens).toBe(20_000);
    expect(m.cost).toBe(0.2);
  });

  it("renders a scannable summary", () => {
    const text = renderSummary(computeMetrics([result()]));
    expect(text).toContain("recall 50.0%");
    expect(text).toContain("Critical/High:     100.0%");
    expect(text).toContain("noise proxy");
    expect(text).toContain("correctness (1 caught");
  });

  it("handles empty results without dividing by zero", () => {
    const m = computeMetrics([]);
    expect(m.recall).toBe(0);
    expect(() => renderSummary(m)).not.toThrow();
  });
});

describe("verify replay helpers", () => {
  const fileDiff = (p: string, body: string) =>
    [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, "@@ -1 +1 @@", body].join("\n");

  it("rebuildVerifyDiff mirrors the pipeline's verify input: exclusion applied, file blocks joined", () => {
    const raw = [
      "junk before the first header is dropped",
      fileDiff("src/a.ts", "-x\n+y"),
      fileDiff("package-lock.json", "-1\n+2"),
      fileDiff("src/b.ts", "-y\n+z"),
    ].join("\n");
    expect(rebuildVerifyDiff(raw)).toBe(`${fileDiff("src/a.ts", "-x\n+y")}\n${fileDiff("src/b.ts", "-y\n+z")}`);
    expect(rebuildVerifyDiff("")).toBe("");
  });

  it("verifyRowStats tallies verdicts by applyVerdicts semantics and attributes recall damage", () => {
    const a = finding({ title: "A" });
    const b = finding({ title: "B" });
    const c = finding({ title: "C" });
    const verdicts = parseVerdicts(
      "```json\n[" +
        '{"id":1,"verdict":"confirmed","reason":"traced"},' +
        '{"id":2,"verdict":"downgraded","severity":"suggestion","reason":"overstated"},' +
        '{"id":3,"verdict":"rejected","reason":"guarded elsewhere"}]\n```',
    ) as Verdict[];
    const bundle = applyVerdicts([a, b, c], verdicts);
    // candidate 3 (index 2) was golden-matched in the frozen run
    const stats = verifyRowStats([a, b, c], verdicts, bundle.rejected, new Set([2]));
    expect(stats).toEqual({
      candidates: 3,
      confirmed: 1,
      downgraded: 1,
      rejected: 1,
      rejectedMatched: 1,
      noVerdict: 0,
      unverified: false,
    });
  });

  it("verifyRowStats: duplicated ids last-wins, out-of-range ids count as no verdict, null means fail-open", () => {
    const a = finding({ title: "A" });
    const b = finding({ title: "B" });
    const dup = parseVerdicts(
      "```json\n[" +
        '{"id":1,"verdict":"confirmed","reason":"x"},' +
        '{"id":1,"verdict":"rejected","reason":"second verdict wins"},' +
        '{"id":9,"verdict":"rejected","reason":"hallucinated id"}]\n```',
    ) as Verdict[];
    const bundle = applyVerdicts([a, b], dup);
    expect(verifyRowStats([a, b], dup, bundle.rejected, new Set())).toMatchObject({
      confirmed: 0,
      downgraded: 0,
      rejected: 1, // candidate 1 only — the id:9 verdict was out of range
      noVerdict: 1, // candidate 2
      unverified: false,
    });
    // unparseable verifier output: fail-open, everything stands
    expect(verifyRowStats([a, b], null, [], new Set())).toMatchObject({
      candidates: 2,
      unverified: true,
      noVerdict: 2,
    });
    // zero candidates: verify never ran — not a failure
    expect(verifyRowStats([], null, [], new Set())).toEqual({
      candidates: 0,
      confirmed: 0,
      downgraded: 0,
      rejected: 0,
      rejectedMatched: 0,
      noVerdict: 0,
      unverified: false,
    });
  });

  it("aggregates replay rows and renders the paired before/after table", () => {
    const rows: VerifyReplayRow[] = [
      {
        prUrl: "u1",
        candidates: 3,
        confirmed: 2,
        downgraded: 1,
        rejected: 0,
        rejectedMatched: 0,
        noVerdict: 0,
        unverified: false,
        tokens: 100_000,
        cost: 0.02,
        durationMs: 120_000,
      },
      {
        prUrl: "u2",
        candidates: 2,
        confirmed: 0,
        downgraded: 0,
        rejected: 2,
        rejectedMatched: 1,
        noVerdict: 0,
        unverified: false,
        tokens: 80_000,
        cost: 0.01,
        durationMs: 100_000,
      },
    ];
    const agg = aggregateVerify(rows);
    expect(agg).toMatchObject({
      prs: 2,
      failOpen: 0,
      candidates: 5,
      confirmed: 2,
      downgraded: 1,
      rejected: 2,
      rejectedMatched: 1,
      verifyTokens: 180_000,
      verifyCost: 0.03,
      verifyDurationMs: 220_000,
    });
    const before = computeMetrics([
      {
        prUrl: "u1",
        issues: [issue()],
        findings: [finding()],
        caught: new Map([[1, 0]]),
        matcher: "judge",
        durationMs: 200_000,
        totalTokens: 400_000,
      },
    ]);
    const after = computeMetrics([
      {
        prUrl: "u1",
        issues: [issue()],
        findings: [],
        caught: new Map(),
        matcher: "judge",
        durationMs: 320_000,
        totalTokens: 500_000,
      },
    ]);
    const text = renderVerifyCompare(before, after, agg);
    expect(text).toContain("Recall:            100.0% → 0.0% (1/1 → 0/1)");
    expect(text).toContain("1 had matched a golden issue");
    expect(text).toContain("+110s/PR, +90k tokens/PR, +$0.015/PR");
    expect(text).not.toContain("fail-open");
  });

  it("discloses fail-open rows in the compare table", () => {
    const agg = aggregateVerify([
      {
        prUrl: "u",
        candidates: 1,
        confirmed: 0,
        downgraded: 0,
        rejected: 0,
        rejectedMatched: 0,
        noVerdict: 1,
        unverified: true,
        durationMs: 5_000,
      },
    ]);
    expect(agg.failOpen).toBe(1);
    const metrics = computeMetrics([]);
    expect(renderVerifyCompare(metrics, metrics, agg)).toContain("1 fail-open row(s)");
  });
});
