/**
 * /review eval runner — the code-review-bench offline benchmark through the
 * production pipeline. See scripts/eval-common.ts for the dataset and
 * matching design.
 *
 * Usage: npm run eval:review
 *   EVAL_PRS=10       PRs to review (default 10; 50 for the full benchmark)
 *   EVAL_SEED=42      deterministic sample seed
 *   EVAL_EFFORT=balanced  pipeline effort (lite/balanced/deep)
 *   EVAL_JUDGE=1      LLM judge for finding↔issue matching (0 = heuristic only)
 *   EVAL_JUDGE_MODEL  judge model override — default: the finders' model;
 *                     overriding avoids same-model self-agreement bias
 *   EVAL_FROM=KEY     start from a fixture key (skips earlier PRs; must match)
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
import { fitTask, parseReviewConfig, runReview, type ReviewConfig, type ReviewDeps } from "../extensions/review";
import {
  computeMetrics,
  heuristicMatches,
  judgeAgent,
  judgeTask,
  loadBench,
  parseJudge,
  renderSummary,
  sampleFixtures,
  sectionForFixture,
  type PrResult,
} from "./eval-common";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "eval", "data");
const RESULTS_DIR = path.join(HERE, "eval", "results");

const env = process.env;
const PRS = Math.max(1, Number(env.EVAL_PRS ?? 10) || 10);
const SEED = Number(env.EVAL_SEED ?? 42) || 42;
const EFFORT = env.EVAL_EFFORT ?? "balanced";
const JUDGE = String(env.EVAL_JUDGE ?? "1") !== "0";
const FROM = env.EVAL_FROM ?? "";
const JUDGE_MODEL = env.EVAL_JUDGE_MODEL?.trim() || undefined;

/** The model the eval children effectively run on: explicit override, else
 * pi's global default (what a `pi -p` child with no --model resolves to).
 * Recorded into results so scores are attributable to a model, not just a date. */
function effectiveModel(): string {
  if (env.PI_REVIEW_MODEL) return env.PI_REVIEW_MODEL;
  try {
    const settings = JSON.parse(readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"));
    const model = settings.defaultModel;
    if (typeof model === "string") {
      return typeof settings.defaultProvider === "string" ? `${settings.defaultProvider}/${model}` : model;
    }
  } catch {
    // settings are optional; report the fallback name
  }
  return "(pi global default)";
}

describe("eval: review pipeline on code-review-bench", () => {
  it("reviews the sampled PRs and scores against golden issues", { timeout: 24 * 60 * 60_000 }, async () => {
    const config: ReviewConfig = parseReviewConfig({ ...env, PI_REVIEW_EFFORT: EFFORT, PI_REVIEW_STATE: "0" });
    const fixtures = sampleFixtures(loadBench(DATA_DIR), PRS, SEED);
    const start = FROM ? fixtures.findIndex((f) => f.key === FROM) : 0;
    if (FROM && start < 0) throw new Error(`EVAL_FROM: no fixture "${FROM}" in the seed-${SEED} sample of ${PRS}`);
    const selected = fixtures.slice(start);
    const judgeModel = JUDGE_MODEL ?? config.model; // default: the finders' model
    const model = effectiveModel();
    console.log(
      `eval: ${selected.length} PRs, effort=${config.effort}, judge=${JUDGE ? "on" : "off"}, seed=${SEED}, model=${model}, judge model=${judgeModel ?? "(pi global default)"}`,
    );

    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonlPath = path.join(RESULTS_DIR, `run-${stamp}.jsonl`);

    // The eval runs in an empty tree: finders see the diff only (a disclosed
    // lower bound — production reviews confirm findings against the working tree).
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "review-eval-"));
    const results: PrResult[] = [];

    for (const fixture of selected) {
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

      // Matching: LLM judge with heuristic fallback.
      let caught: Map<number, number> = new Map();
      let matcher: PrResult["matcher"] = "heuristic";
      if (JUDGE && findings.length > 0) {
        try {
          // Same byte cap as finder/verify tasks: a noisy PR must degrade to
          // the heuristic, not die with E2BIG on an oversized argv.
          const task = fitTask(() => judgeTask(findings, fixture.issues), "").task;
          const run = await runChild(judgeAgent(), task, judgeModel, { timeoutMs: 5 * 60_000 });
          if (!("adopted" in run)) {
            totalTokens = (totalTokens ?? 0) + (run.usage?.totalTokens ?? 0);
            cost = (cost ?? 0) + (run.usage?.cost.total ?? 0);
            const parsed = parseJudge(run.text);
            if (parsed) {
              caught = new Map();
              for (const m of parsed) {
                const issue = fixture.issues[m.issue - 1];
                if (issue && m.finding <= findings.length && !caught.has(issue.issue_index)) {
                  caught.set(issue.issue_index, m.finding - 1);
                }
              }
              if (caught.size > 0 || parsed.length === 0) {
                matcher = "judge";
              } else {
                // every match out of range — treat as judge garbage, fall back
              }
            }
          }
        } catch (err) {
          console.log(`  [${fixture.key}] judge failed (${err instanceof Error ? err.message : err}) — heuristic`);
        }
      }
      if (matcher === "heuristic") caught = heuristicMatches(findings, fixture.issues);

      const result: PrResult = {
        prUrl: fixture.prUrl,
        issues: fixture.issues,
        findings,
        caught,
        matcher,
        totalTokens,
        cost,
        durationMs: Date.now() - startedAt,
      };
      results.push(result);
      // Flush per PR: a killed run keeps everything already spent.
      appendFileSync(
        jsonlPath,
        JSON.stringify({
          ...result,
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
    }

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
            effort: config.effort,
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
  });
});
