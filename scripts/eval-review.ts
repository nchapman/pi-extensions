/**
 * /review eval runner — the code-review-bench offline benchmark through the
 * production pipeline. See scripts/eval-common.ts for the dataset and
 * matching design.
 *
 * Usage: npm run eval:review
 *   EVAL_PRS=10       PRs to review (default 10; 50 for the full benchmark)
 *   EVAL_SEED=42      deterministic sample seed
 *   EVAL_JUDGE=1      LLM judge for finding↔issue matching (0 = heuristic only)
 *   EVAL_JUDGE_MODEL  judge model override — default: the finders' model;
 *                     overriding avoids same-model self-agreement bias
 *   EVAL_FROM=KEY     start from a fixture key (skips earlier PRs; must match)
 *   EVAL_ONLY=k1,k2   review exactly these fixtures (miss-retest tool; keys are
 *                     owner--repo--number, order follows the dataset)
 *   EVAL_CONCURRENCY=1  PRs reviewed concurrently (default 1; 2-3 for speed)
 *   EVAL_REJUDGE=path re-judge an existing run JSONL with the current judge
 *                     (no finder re-spend; writes <path>-rejudged.jsonl) —
 *                     judge changes iterate against frozen findings
 *
 * Spawns real pi children (finders, verifier, judge) — never part of npm test.
 * Results flush incrementally to scripts/eval/results/run-<ts>.jsonl (one line
 * per PR, gitignored) so a timeout or Ctrl-C keeps what was spent; the summary
 * and full JSON are written when the run completes. Judge usage and wall time
 * are included in per-PR cost/time (it is part of running the eval).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultSpawn, runChild } from "../extensions/subagents";
import {
  DEFAULT_REVIEW_MODEL,
  fitTask,
  parseReviewConfig,
  runReview,
  type Finding,
  type ReviewConfig,
  type ReviewDeps,
} from "../extensions/review";
import {
  computeMetrics,
  heuristicMatches,
  judgeAgent,
  judgeTask,
  leftovers,
  loadBench,
  parseJudge,
  renderSummary,
  sampleFixtures,
  sectionForFixture,
  type GoldenIssue,
  type JudgeAudit,
  type PrResult,
} from "./eval-common";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "eval", "data");
const RESULTS_DIR = path.join(HERE, "eval", "results");

const env = process.env;
const PRS = Math.max(1, Number(env.EVAL_PRS ?? 10) || 10);
const SEED = Number(env.EVAL_SEED ?? 42) || 42;
const JUDGE = String(env.EVAL_JUDGE ?? "1") !== "0";
const FROM = env.EVAL_FROM ?? "";
const ONLY = env.EVAL_ONLY?.trim()
  ? env.EVAL_ONLY.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const JUDGE_MODEL = env.EVAL_JUDGE_MODEL?.trim() || undefined;
const REJUDGE = env.EVAL_REJUDGE?.trim() || "";
/** PRs reviewed concurrently (1 = today's serial default; 2 halves wall time
 * at flat token cost — bounded to 3 so a stuck provider can't fan out wildly). */
const CONCURRENCY = Math.max(1, Math.min(3, Number(env.EVAL_CONCURRENCY ?? 1) || 1));

/** Judge a PR's findings against its golden issues: LLM pass, then a leftovers
 * pass (unmatched issues × unmatched findings) to recover pairs the first pass
 * missed, heuristic fallback when the judge is unusable. Returns the audit
 * trail so under-matching is visible in the results, not silent. */
async function judgeFindings(
  findings: Finding[],
  issues: GoldenIssue[],
  judgeModel: string | undefined,
  label: string,
): Promise<{
  caught: Map<number, number>;
  matcher: "judge" | "heuristic";
  tokens?: number;
  cost?: number;
  audit?: JudgeAudit;
}> {
  if (!JUDGE || findings.length === 0) {
    return { caught: heuristicMatches(findings, issues), matcher: "heuristic" };
  }
  // Same byte cap as finder/verify tasks: a noisy PR must degrade to the
  // heuristic, not die with E2BIG on an oversized argv.
  const ask = async (fs: Finding[], is: GoldenIssue[]) => {
    const task = fitTask(() => judgeTask(fs, is), "").task;
    return runChild(judgeAgent(), task, judgeModel, { timeoutMs: 5 * 60_000 });
  };
  try {
    let tokens = 0;
    let cost = 0;
    // One retry: judge calls are short and the common failure is a transient
    // provider error mid-run — a second attempt is ~25s and saves the PR's
    // recall from falling to the heuristic.
    const askWithRetry = async (fs: Finding[], is: GoldenIssue[]) => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const run = await ask(fs, is);
          if (!("adopted" in run)) return run;
          lastErr = new Error("judge child was adopted, not run");
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };
    const run = await askWithRetry(findings, issues);
    tokens += run.usage?.totalTokens ?? 0;
    cost += run.usage?.cost.total ?? 0;
    const parsed = parseJudge(run.text);
    const audit: JudgeAudit = { text: run.text.slice(0, 4000), matches: parsed ?? [] };
    if (!parsed) throw new Error("judge output unparseable");
    const caught = new Map<number, number>();
    for (const m of parsed) {
      const issue = issues[m.issue - 1];
      if (issue && m.finding <= findings.length && !caught.has(issue.issue_index)) {
        caught.set(issue.issue_index, m.finding - 1);
      }
    }
    if (caught.size === 0 && parsed.length > 0) throw new Error("every judge match out of range");

    // Leftovers pass: re-judge only unmatched issues against unused findings.
    // Reduced lists, renumbered — recovered matches lift back via the index maps.
    const rest = leftovers(caught, findings, issues);
    if (rest.issues.length > 0 && rest.findings.length > 0) {
      try {
        const run2 = await ask(rest.findings, rest.issues);
        if (!("adopted" in run2)) {
          tokens += run2.usage?.totalTokens ?? 0;
          cost += run2.usage?.cost.total ?? 0;
          audit.leftoverText = run2.text.slice(0, 4000);
          for (const m of parseJudge(run2.text) ?? []) {
            const issueIndex = rest.issueOf[m.issue - 1];
            const findingIndex = rest.findingOf[m.finding - 1];
            if (issueIndex !== undefined && findingIndex !== undefined && !caught.has(issueIndex)) {
              caught.set(issueIndex, findingIndex);
            }
          }
        }
      } catch {
        // pass 1 stands on its own; leftovers are best-effort
      }
    }
    return { caught, matcher: "judge", tokens, cost, audit };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`  [${label}] judge failed (${reason}) — heuristic`);
    // Audit the failure too: a heuristic row must explain itself in the JSONL,
    // not silently look like the judge approved a zero.
    return {
      caught: heuristicMatches(findings, issues),
      matcher: "heuristic",
      audit: { text: `judge failed: ${reason}`, matches: [] },
    };
  }
}

/** The model the eval children effectively run on. Same resolution order as
 * parseReviewConfig (env knob, else the in-code default) so recorded
 * attribution matches what the children actually spawned with. */
function effectiveModel(): string {
  return env.PI_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}

describe("eval: review pipeline on code-review-bench", () => {
  it.skipIf(!!REJUDGE)(
    "reviews the sampled PRs and scores against golden issues",
    { timeout: 24 * 60 * 60_000 },
    async () => {
      const config: ReviewConfig = parseReviewConfig({ ...env, PI_REVIEW_STATE: "0" });
      const all = loadBench(DATA_DIR);
      // EVAL_ONLY bypasses sampling entirely (retests don't care about seeds).
      let fixtures = ONLY.length ? all.filter((f) => ONLY.includes(f.key)) : sampleFixtures(all, PRS, SEED);
      if (ONLY.length) {
        const found = new Set(fixtures.map((f) => f.key));
        const missing = ONLY.filter((k) => !found.has(k));
        if (missing.length) throw new Error(`EVAL_ONLY: unknown fixture key(s): ${missing.join(", ")}`);
      }
      const start = FROM ? fixtures.findIndex((f) => f.key === FROM) : 0;
      if (FROM && start < 0) throw new Error(`EVAL_FROM: no fixture "${FROM}" in the seed-${SEED} sample of ${PRS}`);
      const selected = fixtures.slice(start);
      const judgeModel = JUDGE_MODEL ?? config.model; // default: the finders' model
      const model = effectiveModel();
      console.log(
        `eval: ${selected.length} PRs, judge=${JUDGE ? "on" : "off"}, seed=${SEED}, model=${model}, judge model=${judgeModel ?? "(pi global default)"}`,
      );

      mkdirSync(RESULTS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const jsonlPath = path.join(RESULTS_DIR, `run-${stamp}.jsonl`);

      // The eval runs in an empty tree: finders see the diff only (a disclosed
      // lower bound — production reviews confirm findings against the working tree).
      const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "review-eval-"));
      const results: PrResult[] = [];

      const reviewFixture = async (fixture: (typeof selected)[number]): Promise<PrResult> => {
        const startedAt = Date.now();
        const deps: ReviewDeps = {
          git: async () => ({ code: 1, stdout: "", stderr: "eval: no git" }),
          shell: async () => null,
          readFile: async () => undefined,
          writeFile: async () => {},
          notify: (message) => console.log(`  [${fixture.key}] ${message}`),
          spawnFn: defaultSpawn,
          sessionModel: null,
        };
        const review = await runReview({
          cwd: emptyRoot,
          config,
          target: { kind: "default" },
          deps,
          provided: {
            sections: sectionForFixture(fixture),
            repoRoot: emptyRoot,
            targetLabel: fixture.prUrl,
          },
        });
        const findings = review.findings;
        let totalTokens = review.usage?.totalTokens;
        let cost = review.usage?.cost.total;
        console.log(
          `  [${fixture.key}] ${findings.length} finding(s) vs ${fixture.issues.length} golden, ${review.usage?.totalTokens ?? "?"} tokens`,
        );

        const judged = await judgeFindings(findings, fixture.issues, judgeModel, fixture.key);
        totalTokens = (totalTokens ?? 0) + (judged.tokens ?? 0);
        cost = (cost ?? 0) + (judged.cost ?? 0);

        const result: PrResult = {
          prUrl: fixture.prUrl,
          issues: fixture.issues,
          findings,
          caught: judged.caught,
          matcher: judged.matcher,
          totalTokens,
          cost,
          durationMs: Date.now() - startedAt,
          judge: judged.audit,
        };
        // Coverage rides outside PrResult (it is review-pipeline diagnostics,
        // not matching data) but must persist: a quiet lens has to explain
        // itself in the results file, not just in the discarded report.
        const coverage = review.coverage;
        results.push(result);
        // Flush per PR: a killed run keeps everything already spent.
        appendFileSync(
          jsonlPath,
          JSON.stringify({
            ...result,
            coverage,
            caught: [...result.caught.entries()],
            findings: result.findings.map((f) => ({
              file: f.file,
              line: f.line,
              severity: f.severity,
              title: f.title,
              detail: f.detail,
              recommendation: f.recommendation ?? null,
              lenses: f.lenses,
            })),
          }) + "\n",
        );
        return result;
      };

      // PR-level pool: independent PRs run concurrently up to EVAL_CONCURRENCY
      // (default 1). Wall time drops ~linearly while tokens stay flat; logs and
      // JSONL flushes stay per-PR (appendFileSync is atomic per line, and each
      // PR's console lines carry its key).
      let next = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
        while (next < selected.length) {
          const fixture = selected[next++];
          await reviewFixture(fixture);
        }
      });
      await Promise.all(workers);
      // Preserve sample order in reports regardless of completion order.
      results.sort(
        (a, b) => selected.findIndex((f) => f.prUrl === a.prUrl) - selected.findIndex((f) => f.prUrl === b.prUrl),
      );

      const metrics = computeMetrics(results);
      // Fail-open is right for the pipeline, but an eval where every child died
      // (bad model name, dead credentials) is an infrastructure failure, not a
      // score — refuse to record it as one.
      if (results.every((r) => r.findings.length === 0 && r.totalTokens === undefined)) {
        throw new Error(
          "every PR produced zero findings and zero usage — children failed to run (check PI_REVIEW_MODEL / credentials)",
        );
      }
      console.log("\n=== /review eval — code-review-bench offline ===");
      console.log(renderSummary(metrics));
      console.log("\n(context: the dataset's online split carries published P/R for 15 hosted");
      console.log(" tools — Copilot, CodeRabbit, Greptile, Cursor, Qodo, Graphite, ... — on its own PR set)");
      for (const r of results) {
        const missed = r.issues.filter((i) => !r.caught.has(i.issue_index));
        console.log(`\n${r.prUrl} — ${r.caught.size}/${r.issues.length} caught (${r.matcher})`);
        for (const m of missed) console.log(`  missed [${m.severity}] ${m.comment.slice(0, 110)}`);
      }

      const outPath = path.join(RESULTS_DIR, `run-${stamp}.json`);
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            meta: {
              prs: results.length,
              seed: SEED,
              judge: JUDGE,
              model,
              judgeModel: judgeModel ?? "(pi global default)",
              date: new Date().toISOString(),
            },
            metrics,
            results: results.map((r) => ({
              ...r,
              caught: [...r.caught.entries()],
              findings: r.findings.map((f) => ({
                file: f.file,
                line: f.line,
                severity: f.severity,
                title: f.title,
                detail: f.detail,
                recommendation: f.recommendation ?? null,
                lenses: f.lenses,
              })),
            })),
          },
          null,
          1,
        ),
      );
      console.log(`\nresults: ${outPath} (+ per-PR ${jsonlPath})`);
      expect(results.length).toBeGreaterThan(0);
    },
  );

  // Judge iteration mode: findings are frozen (read from a previous run's
  // JSONL), only matching re-runs. This is how judge changes are dialed in
  // without re-spending finder tokens — and the before/after comparison is
  // the evidence that a judge change is a measurement fix, not score drift.
  it.skipIf(!REJUDGE)(
    "re-judges an existing run's findings with the current judge",
    { timeout: 24 * 60 * 60_000 },
    async () => {
      type Row = Omit<PrResult, "caught"> & { caught: [number, number][] } & { judge?: JudgeAudit };
      const rows = readFileSync(REJUDGE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row);
      const outPath = `${REJUDGE.replace(/\.jsonl$/, "")}-rejudged.jsonl`;
      const judgeModel = JUDGE_MODEL ?? effectiveModel();
      console.log(`re-judge: ${rows.length} PRs from ${REJUDGE}, judge model=${judgeModel}`);

      let beforeCaught = 0;
      let afterCaught = 0;
      let issueTotal = 0;
      for (const row of rows) {
        const findings = row.findings.map((f) => ({
          ...f,
          recommendation: f.recommendation ?? undefined,
        })) as Finding[];
        const before = new Map(row.caught);
        const judged = await judgeFindings(findings, row.issues, judgeModel, row.prUrl);
        beforeCaught += before.size;
        afterCaught += judged.caught.size;
        issueTotal += row.issues.length;
        const key = row.prUrl.replace(/\/$/, "").split("/").slice(-2).join("/");
        console.log(`  ${key}: ${before.size} → ${judged.caught.size}/${row.issues.length} (${judged.matcher})`);
        appendFileSync(
          outPath,
          JSON.stringify({
            ...row,
            caught: [...judged.caught.entries()],
            matcher: judged.matcher,
            judge: judged.audit,
          }) + "\n",
        );
      }
      console.log(`\nrecall: ${beforeCaught} → ${afterCaught} of ${issueTotal}`);
      expect(afterCaught).toBeGreaterThanOrEqual(0);
    },
  );
});
