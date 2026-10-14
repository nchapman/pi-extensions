/**
 * Review extension — a local, multi-stage code-review pipeline as a /review command.
 *
 * Architecture (transplanted from how the hosted reviewers actually work —
 * GitHub Copilot's diff-anchored "ask, narrow, read, decide" tool discipline,
 * and the find→verify→report pipelines of Copilot/CodeRabbit/Greptile/Anthropic
 * Code Review/Qodo):
 * - Stage 0 (deterministic, no LLM): resolve the review target (default:
 *   commits ahead of upstream plus uncommitted and untracked work), compute
 *   the diff, synthesize diffs for untracked files, drop excluded paths
 *   (lockfiles, logs, vendored/generated/minified), chunk on file boundaries,
 *   and collect repo instructions — REVIEW.md at the root plus the
 *   "Review guidelines" section of the closest AGENTS.md for each changed
 *   file (Codex's convention). Each chunk's changed files are then attached
 *   (hunk-centered windows of current contents — whole file when small —
 *   smallest-first under PI_REVIEW_ATTACH_CHARS): finders start from the
 *   changed regions in the task instead of paying tool round trips to
 *   re-discover the very files under review — attachments never shrink the
 *   diff (they use only task-cap headroom). An optional
 *   read-only check command (PI_REVIEW_CHECK_CMD) runs once and feeds its
 *   output to verification.
 * - Stage 1 (find): one read-only subagent per (lens × chunk) explores the
 *   working tree with review-shaped workflow instructions and returns
 *   findings as JSON. Lenses focus attention; chunks bound context; the
 *   child cap bounds spend — when the cap binds, chunks shed lenses
 *   (correctness first) and the report discloses the coverage.
 * - Stage 2 (verify): one adversarial subagent re-traces every merged
 *   candidate against the diff and repo; only evidence-backed findings
 *   survive. Rejection requires a mechanism refutation (premise wrong, guard
 *   prevents it, trigger unreachable, convention-compliant, not a defect) —
 *   scope doubt ("predates this change") may only downgrade, never reject:
 *   the A/B on code-review-bench showed mechanism rejections were 10/10
 *   correct noise kills while the one scope-based rejection was the only
 *   true positive lost. This stage is why finders can be aggressive
 *   (Greptile v3: self-challenging raises precision, it doesn't just cost
 *   tokens).
 * - Stage 3 (report): deterministic dedupe (worst severity wins — a merged
 *   verdict is never less alarming than its inputs), severity ordering, a
 *   single markdown report delivered to the caller as a follow-up message.
 *
 * Design cuts:
 * - Command, not a tool: reviews are user-initiated and the parent agent's
 *   context pays only for the final report — no ambient tool declaration.
 * - No repository index: at local scale grep is instant and always fresh;
 *   Copilot's migration to plain grep/glob/view showed the quality lives in
 *   the workflow instructions, not precomputed retrieval. If a monorepo ever
 *   needs semantic recall, recall's EmbedClient/VectorStore stack slots in as
 *   another evidence source without architectural change.
 * - Verify fails open: a broken verifier reports findings labeled
 *   "unverified" rather than silently dropping or trusting them.
 * - Honesty over coverage: chunks the child cap or a finder failure left
 *   uncovered are named in the report as not reviewed — never listed under
 *   reviewed files. Coverage derives from finder outcomes, not the plan.
 * - Task text is byte-capped (TASK_MAX_BYTES, under Linux MAX_ARG_STRLEN):
 *   the task is one execve argument, so an uncapped diff would fail to spawn.
 * - Children are tracked and killed on session shutdown — nothing outlives
 *   the session (the superbash invariant).
 * - Dead requests are detected, not awaited: a child silent on stdout for
 *   PI_REVIEW_IDLE_TIMEOUT_MS (default 5m) is a dead LLM request, not a slow
 *   one — it is killed at once (the hard timeout is the backstop, not the
 *   detector) and retried once; a twice-stalled child surfaces in coverage
 *   like any other finder failure.
 * - Prior findings persist to <repo>/.pi/review-state.json (PR-Agent's
 *   pattern): a re-review repeats still-valid findings verbatim and does not
 *   re-raise resolved ones unless the code reintroduces them; priors carry
 *   only for the same review target, and the state file itself is excluded
 *   from review so it never becomes reviewable diff.
 * - Everything bounded: per-child timeout, child cap, chunk char budget,
 *   per-file untracked budget, findings cap, prior-findings char budget.
 */

/**
 * Module map (pure layers below the wiring; this file owns registration,
 * the /review command, and the review tool):
 * - config.ts   PI_REVIEW_* knobs, /review target parsing, repo guidelines
 * - diff.ts     diff splitting, exclusion, chunking, byte cap, attachments
 * - findings.ts the Finding model: parse, merge, verify verdicts (fail open)
 * - lenses.ts   finder lenses and finder/verifier prompts
 * - run.ts      bounded runners, orchestration (runReview), report, summary
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultSpawn } from "../subagents";
import { parseReviewArgs, parseReviewConfig, resolveInvocation } from "./config";
import { reviewDeps, runReview, summarizeForTool, trackedSpawn } from "./run";
import type { ReviewDeps } from "./run";

export * from "./config";
export * from "./diff";
export * from "./findings";
export * from "./lenses";
export * from "./run";

export function registerReview(pi: ExtensionAPI, deps?: Partial<ReviewDeps>): void {
  // Children are tracked so shutdown kills the whole pipeline — an orphaned
  // finder burns tokens with nobody consuming the result (the superbash invariant).
  const tracked = trackedSpawn(deps?.spawnFn ?? defaultSpawn);
  pi.on("session_shutdown", () => {
    tracked.killAll();
  });
  pi.registerCommand("review", {
    description: "Multi-stage code review of local changes (finders → verification → report)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const config = parseReviewConfig(process.env);
      const parsed = parseReviewArgs(args);
      if (parsed.error) {
        ctx.ui.notify(`/review: ${parsed.error}`, "error");
        return;
      }
      const { model, verifyModel } = resolveInvocation(parsed, config);
      const full = reviewDeps(ctx.cwd, {
        notify: (message, level) => ctx.ui.notify(message, level),
        sessionModel: ctx.model,
        ...deps,
        spawnFn: tracked.spawnFn,
      });
      ctx.ui.notify(
        `Starting code review${model ? ` (${model}${verifyModel && verifyModel !== model ? `, verify: ${verifyModel}` : ""})` : ""}…`,
        "info",
      );
      try {
        const result = await runReview({
          cwd: ctx.cwd,
          config: { ...config, model, verifyModel },
          target: parsed.target,
          deps: full,
        });
        pi.sendUserMessage(result.report, { deliverAs: "followUp" });
        ctx.ui.notify(`Review complete: ${result.findingCount} finding(s)`, "info");
      } catch (err) {
        ctx.ui.notify(`Review failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // The agent-facing surface: same pipeline, compact output. The parent agent
  // can review its own diff before committing — the discipline the global
  // AGENTS.md asks for — without the multi-KB report landing in its context.
  pi.registerTool({
    name: "review",
    label: "Review",
    description:
      "Run the multi-lens code-review pipeline (correctness, security, robustness, tests finders over a diff, adversarial verification of the merged candidates, then a deterministic merge) on local changes. Use it to review your own work before committing or when asked to review changes. target defaults to commits ahead of upstream plus uncommitted and untracked work; 'staged', 'tree' (uncommitted only), a ref like 'main', or a range like 'HEAD~3..HEAD' override. Returns one line per finding (severity, location, title); the full report with details and recommendations is written to .pi/review/<callId>.md (path included in the result) — read it for any finding you act on.",
    promptSnippet:
      "review — run the multi-lens review pipeline on a diff (default: ahead of upstream + working tree; or 'staged', 'tree', a ref, 'a..b'); returns compact findings, full report on disk",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description:
            "What to review: 'staged', 'tree' (uncommitted only), a ref like 'main' (commits ahead of it), or a range like 'HEAD~3..HEAD'. Default: ahead of upstream plus working tree",
        }),
      ),
    }),
    async execute(id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const parsed = parseReviewArgs(params.target ?? "");
      if (parsed.error) {
        return {
          content: [{ type: "text" as const, text: `review: ${parsed.error}` }],
          details: { findingCount: 0 },
          isError: true,
        };
      }
      const config = parseReviewConfig(process.env);
      const { model, verifyModel } = resolveInvocation(parsed, config);
      const full = reviewDeps(cwd, {
        notify: () => {}, // progress chatter is for humans; the tool result carries what matters
        sessionModel: ctx.model,
        ...deps,
        spawnFn: tracked.spawnFn,
      });
      try {
        const result = await runReview({
          cwd,
          config: { ...config, model, verifyModel },
          target: parsed.target,
          deps: full,
          signal,
        });
        // Full report to disk (recoverable, readable on demand); gist to context.
        // Unique per call: concurrent reviews or successive iterations must not
        // overwrite each other — .pi/review/<callId>.md accumulates, diffable.
        const reportDir = path.join(cwd, ".pi", "review");
        await mkdir(reportDir, { recursive: true });
        // The call id is pi-generated, but it feeds a file path — sanitize at
        // the boundary so a future id scheme can't traverse out of .pi/review.
        const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
        const reportPath = path.join(reportDir, `${safeId}.md`);
        await full.writeFile(reportPath, result.report);
        return {
          content: [{ type: "text" as const, text: summarizeForTool(result, reportPath) }],
          details: { findingCount: result.findingCount },
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Review failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          details: { findingCount: 0 },
          isError: true,
        };
      }
    },
  });
}

export default registerReview;
