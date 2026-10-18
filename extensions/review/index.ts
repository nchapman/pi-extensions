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
 * - Exposed as both the `/review` command and the `review` tool: human users get
 *   progress chatter and full reports in chat, while agents self-reviewing before
 *   commit get compact summaries in context with full reports written to `.pi/review/`.
 * - Any directory is reviewable, not just the session cwd: `--cwd <dir>` (or a
 *   path-shaped token like ~/Code/foo) on /review and the tool's cwd param pick
 *   the repo; finder/verifier children spawn with their working directory at the
 *   reviewed repo root, and the report and priors land in that repo's .pi/. An
 *   agent working across many projects reviews any of them without cd-ing.
 *   Foreign-directory reviews stay fail-closed where the reviewed repo is
 *   untrusted input: the check command is skipped (PI_REVIEW_CHECK_FOREIGN=1
 *   opts in), repo-controlled reads (guidelines, priors, untracked files,
 *   attachments) are anchored, bounded, and symlink-refusing, and nothing is
 *   written through a symlinked .pi. Residual risk, stated plainly: the
 *   finder/verifier children read files by absolute path and their tasks
 *   quote repo-controlled text (the diff, REVIEW.md, AGENTS.md), so a
 *   hostile repo can still prompt-inject a child into reading private files
 *   and reporting them as findings — the guards bound the filesystem route,
 *   they do not sandbox the model. Reviewing a foreign repo means trusting
 *   it with that, same as opening it in an editor.
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

import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultSpawn } from "../subagents";
import { parseReviewArgs, parseReviewConfig, foreignCheckAllowed, resolveInvocation, resolveReviewCwd } from "./config";
import type { ReviewConfig } from "./config";
import { defaultGit, dirsOrMissing, reviewDeps, runReview, summarizeForTool, trackedSpawn } from "./run";
import type { ReviewDeps } from "./run";

export * from "./config";
export * from "./diff";
export * from "./findings";
export * from "./lenses";
export * from "./run";

/** Fail fast on a bad review directory: a nonexistent path would otherwise
 * surface as git's misleading "not a git repository" from deep in the
 * pipeline. Returns null when the path is a reviewable directory. Stat
 * failures beyond ENOENT/ENOTDIR keep their message — "no such directory"
 * would misreport EACCES or ELOOP as a typo'd path. */
async function directoryError(dir: string): Promise<string | null> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `no such directory: ${dir}`;
    if (code === "ENOTDIR") return `not a directory: ${dir}`;
    return `cannot access ${dir}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return s.isDirectory() ? null : `not a directory: ${dir}`;
}

/** Same directory on disk, not the same string: a session cwd of /tmp and
 * a --cwd of /private/tmp (macOS alias) must not count as "foreign" — that
 * would silently strip the trusted check command from a same-repo review.
 * realpath both; an unresolvable path falls back to resolve() so a missing
 * directory still compares predictably (it fails validation right after). */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  const canon = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  return (await canon(a)) === (await canon(b));
}

/** Shared invocation prep: resolve the review directory (expanding ~, and
 * treating a path-shaped target like ~/Code/foo as the directory), validate
 * it, and gate the check command for foreign directories — PI_REVIEW_CHECK_CMD
 * is repo-owned (e.g. `npm run check`), so running it in a directory other
 * than the session cwd means executing that repo's scripts; skip unless
 * PI_REVIEW_CHECK_FOREIGN=1, and say so in the disclosure note. "Foreign"
 * means a different directory on disk, not a different spelling of the same
 * one (macOS /tmp vs /private/tmp) — canonical identities are compared.
 * The report directory anchors to the git repo that owns the reviewed
 * directory, so a subdirectory review does not fork .pi into <repo>/sub/.pi
 * and the report stays next to the repo's review-state.json priors. */
async function prepareReviewDirectory(
  sessionCwd: string,
  requestedCwd: string | undefined,
  config: ReviewConfig,
  git?: ReviewDeps["git"],
): Promise<{
  reviewCwd: string;
  reportDir: string;
  foreign: boolean;
  config: ReviewConfig;
  note?: string;
  error?: string;
}> {
  const reviewCwd = resolveReviewCwd(sessionCwd, requestedCwd);
  const error = await directoryError(reviewCwd);
  if (error) return { reviewCwd, reportDir: path.join(reviewCwd, ".pi", "review"), foreign: false, config, error };
  // The repo root owns the report and priors; outside a repo the reviewed
  // directory stands alone. Resolved before the check gate so every return
  // path anchors identically — a skipped check must not fork the report
  // into <repo>/sub/.pi while priors live at <repo>/.pi.
  const top = await (git ?? defaultGit(reviewCwd))(["rev-parse", "--show-toplevel"]);
  const owner = top.code === 0 ? top.stdout.trim() || reviewCwd : reviewCwd;
  const reportDir = path.join(owner, ".pi", "review");
  const foreign = !(await sameDirectory(reviewCwd, sessionCwd));
  if (config.checkCmd && foreign && !foreignCheckAllowed(process.env)) {
    return {
      reviewCwd,
      reportDir,
      foreign,
      config: { ...config, checkCmd: "" },
      note: `check command skipped (${config.checkCmd}): it would run inside the reviewed directory, whose scripts are untrusted — set PI_REVIEW_CHECK_FOREIGN=1 to allow`,
    };
  }
  return { reviewCwd, reportDir, foreign, config };
}

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
      // The review directory: the session cwd unless the invocation names
      // another one. Resolved and validated here so both surfaces share it.
      const prepared = await prepareReviewDirectory(ctx.cwd, parsed.cwd, config, deps?.git);
      if (prepared.error) {
        ctx.ui.notify(`/review: ${prepared.error}`, "error");
        return;
      }
      const { reviewCwd } = prepared;
      const { model, verifyModel } = resolveInvocation(parsed, config);
      const full = reviewDeps(reviewCwd, {
        notify: (message, level) => ctx.ui.notify(message, level),
        sessionModel: ctx.model,
        ...deps,
        spawnFn: tracked.spawnFn,
      });
      ctx.ui.notify(
        `Starting code review${prepared.foreign ? ` of ${reviewCwd}` : ""}${model ? ` (${model}${verifyModel && verifyModel !== model ? `, verify: ${verifyModel}` : ""})` : ""}…`,
        "info",
      );
      try {
        const result = await runReview({
          cwd: reviewCwd,
          config: { ...prepared.config, model, verifyModel },
          target: parsed.target,
          deps: full,
          ...(prepared.note ? { notes: [prepared.note] } : {}),
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
      "Run the multi-lens code-review pipeline (correctness, security, robustness, tests finders over a diff, adversarial verification of the merged candidates, then a deterministic merge) on local changes. Use it to review your own work before committing or when asked to review changes. target defaults to commits ahead of upstream plus uncommitted and untracked work; 'staged', 'tree' (uncommitted only), a ref like 'main', or a range like 'HEAD~3..HEAD' override. A directory that is not a git repository is reviewed as its whole tree (no target or 'tree'). cwd is the directory of the repo to review — absolute, ~/-relative, or relative to the session cwd; default is the session cwd, so pass cwd to review another project (e.g. ~/Code/<project>) without cd-ing to it. Returns one line per finding (severity, location, title); the full report with details and recommendations is written to <repo>/.pi/review/<callId>.md (path included in the result) — read it for any finding you act on.",
    promptSnippet:
      "review — run the multi-lens review pipeline on a diff (default: ahead of upstream + working tree; or 'staged', 'tree', a ref, 'a..b'); cwd targets another project's directory; returns compact findings, full report on disk",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description:
            "What to review: 'staged', 'tree' (uncommitted only), a ref like 'main' (commits ahead of it), or a range like 'HEAD~3..HEAD'. Default: ahead of upstream plus working tree. A path-shaped target (~/…, /abs, ./…) instead names the directory of the repo to review — prefer the cwd param for that",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Directory of the repo to review: an absolute path, ~/…, or a path relative to the session cwd. Default: the session cwd. Use it to review a different project than the one you are working in.",
        }),
      ),
    }),
    async execute(id, params, signal, _onUpdate, ctx) {
      const sessionCwd = ctx.cwd ?? process.cwd();
      // Parse first: a path-shaped target (~, /, ./ …) names the review
      // directory, and the explicit cwd param wins when both are given.
      const config = parseReviewConfig(process.env);
      const parsed = parseReviewArgs(params.target ?? "");
      if (parsed.error) {
        return {
          content: [{ type: "text" as const, text: `review: ${parsed.error}` }],
          details: { findingCount: 0 },
          isError: true,
        };
      }
      const prepared = await prepareReviewDirectory(
        sessionCwd,
        params.cwd?.trim() || parsed.cwd, // blank cwd defers to a path-shaped target, never silently drops it
        config,
        deps?.git,
      );
      if (prepared.error) {
        return {
          content: [{ type: "text" as const, text: `review: ${prepared.error}` }],
          details: { findingCount: 0 },
          isError: true,
        };
      }
      const { reviewCwd } = prepared;
      // Pre-flight the report destination: refuse before children spawn — not
      // after the tokens are spent — when `.pi`/`.pi/review` is a symlink or
      // committed as a regular file (a reviewed repo can commit either to
      // redirect or break the write; git preserves symlinks).
      const reportDir = prepared.reportDir;
      const piDir = path.dirname(reportDir);
      if (!(await dirsOrMissing(piDir, reportDir))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `review: refusing to write the report through a symlinked or non-directory ${reportDir}`,
            },
          ],
          details: { findingCount: 0 },
          isError: true,
        };
      }
      const { model, verifyModel } = resolveInvocation(parsed, config);
      const full = reviewDeps(reviewCwd, {
        notify: () => {}, // progress chatter is for humans; the tool result carries what matters
        sessionModel: ctx.model,
        ...deps,
        spawnFn: tracked.spawnFn,
      });
      try {
        const result = await runReview({
          cwd: reviewCwd,
          config: { ...prepared.config, model, verifyModel },
          target: parsed.target,
          deps: full,
          signal,
          ...(prepared.note ? { notes: [prepared.note] } : {}),
        });
        // Full report to disk (recoverable, readable on demand); gist to context.
        // Unique per call: concurrent reviews or successive iterations must not
        // overwrite each other — .pi/review/<callId>.md accumulates, diffable.
        // The report lives with the reviewed repo, not the session cwd, so it
        // stays next to that repo's .pi/review-state.json priors.
        // The write is best-effort like the state persist: the destination sits
        // in a repo we do not control (read-only checkout, hostile permissions),
        // and a failed write must not discard a finished, paid-for review.
        // The call id is pi-generated, but it feeds a file path — sanitize at
        // the boundary so a future id scheme can't traverse out of .pi/review.
        const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
        const reportPath = path.join(reportDir, `${safeId}.md`);
        try {
          await mkdir(reportDir, { recursive: true });
          await full.writeFile(reportPath, result.report);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          // The report file was the disclosure channel for pipeline notes
          // (check-command skip, finder errors) — carry them inline instead,
          // and do not advertise a "Full report:" path that was never written.
          const noteLines = result.notes.map((n) => `- ${n}`).join("\n");
          const notesBlock = noteLines ? `\n\nPipeline notes:\n${noteLines}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `${summarizeForTool(result)}${notesBlock}\n\nnote: the report could not be written to ${reportPath} (${why}) — summary only.`,
              },
            ],
            details: { findingCount: result.findingCount },
          };
        }
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
