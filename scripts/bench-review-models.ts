/**
 * Finder latency benchmark: run the REAL correctness-lens finder child per
 * model and report wall time + usage. This is the number reviews pay — one
 * child, multi-turn, on a fixed diff — not a synthetic TTFT probe.
 *
 * Usage: npm run bench:review-models — with env (vitest owns argv, so the
 * commit comes from BENCH_COMMIT, not a positional):
 *   BENCH_COMMIT=<sha>   diff to review (default 19488b1 — a real mid-size commit)
 *   BENCH_MODELS="a,b"   comma-separated provider/id list (default: the five
 *                        opencode-go flash candidates)
 *   BENCH_THINKING="off" single arm instead of default-vs-off A/B
 *
 * Runs children sequentially (parallelism would measure the box, not the
 * endpoint) under a 6m hard / 2m idle timeout so a dead endpoint fails fast
 * instead of stalling the bench, and prints a markdown table.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { DEFAULT_REVIEW_MODEL, FINDER_LENSES, finderAgent, finderTask, fitTask } from "../extensions/review";
import { runChild } from "../extensions/subagents";

const execFileAsync = promisify(execFile);

const DEFAULT_MODELS = [
  "opencode-go/mimo-v2.6-flash",
  DEFAULT_REVIEW_MODEL,
  "opencode-go/muse-spark-1.3-contributor",
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.8-flash",
];

async function gitDiff(commit: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", commit, "--format=", "--no-color", "-U3"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

describe("review finder latency benchmark", () => {
  it("times one real finder child per model and thinking level", { timeout: 60 * 60_000 }, async () => {
    const commit = process.env.BENCH_COMMIT ?? "19488b1";
    const models = (process.env.BENCH_MODELS?.trim() ? process.env.BENCH_MODELS.split(",") : DEFAULT_MODELS).map((m) =>
      m.trim(),
    );
    const arms = (process.env.BENCH_THINKING?.trim() ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const thinkingArms = arms.length ? arms : ["default", "off"];
    const diff = await gitDiff(commit);
    if (!diff) throw new Error(`no diff for ${commit}`);

    const lens = FINDER_LENSES[0]; // correctness — the priority lens
    const agent = finderAgent(lens);
    const { task } = fitTask(
      (d) => finderTask({ lens, chunkIndex: 0, chunkCount: 1, diffText: d, guidelines: "", priorFindings: "" }),
      diff,
    );

    console.log(`\n# Finder latency bench — ${commit} (${(diff.length / 1024).toFixed(1)}KB diff), correctness lens\n`);
    const rows: string[] = ["| model | thinking | wall | tokens in/out | notes |", "|---|---|---|---|---|"];
    for (const model of models) {
      for (const arm of thinkingArms) {
        // DEFAULT_REVIEW_MODEL may already carry a :thinking suffix — strip it
        // before composing an arm so "off" never produces model:off:off and
        // "default" always means the un-suffixed endpoint default.
        const base = model.replace(/:[a-z]+$/, "");
        const childModel = arm === "default" ? base : `${base}:${arm}`;
        const t0 = Date.now();
        try {
          const result = await runChild(agent, task, childModel, { timeoutMs: 6 * 60_000, idleTimeoutMs: 2 * 60_000 });
          const wall = ((Date.now() - t0) / 1000).toFixed(1);
          const u = result.usage;
          rows.push(
            `| ${model.split("/")[1] ?? model} | ${arm} | ${wall}s | ${
              u ? `${u.input}/${u.output}` : "?"
            }${u?.reasoning ? ` (reasoning ${u.reasoning})` : ""} | ok, ${(result.text.length / 1024).toFixed(
              1,
            )}KB out |`,
          );
          // BENCH_DUMP=1: full final text for suspiciously short results —
          // a valid empty-findings JSON and a formatting failure both round to 0.0KB.
          if (process.env.BENCH_DUMP && result.text.length < 2048) {
            console.log(`\n[dump ${model} ${arm}] ${JSON.stringify(result.text)}\n`);
          }
        } catch (err) {
          const wall = ((Date.now() - t0) / 1000).toFixed(1);
          const msg = err instanceof Error ? err.message.split("\n")[0].slice(0, 60) : String(err);
          rows.push(`| ${model.split("/")[1] ?? model} | ${arm} | ${wall}s | — | FAILED: ${msg} |`);
        }
        console.log(rows[rows.length - 1]);
      }
    }
    console.log(`\n${rows.join("\n")}\n`);
  });
});
