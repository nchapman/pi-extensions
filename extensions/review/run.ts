/** The pipeline: bounded git/shell runners, diff-section resolution, finder
 * planning, the find→verify→report orchestration (runReview), prior-finding
 * persistence, and the agent-facing summary. */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultSpawn,
  type ChildRun,
  type ChildUsage,
  isStalledError,
  resolveChildModel,
  runChild,
  runWithLimit,
  type SpawnFn,
  sumUsages,
} from "../subagents";
import { collectGuidelines } from "./config";
import type { ReviewConfig, TargetSpec } from "./config";
import {
  chunkDiffFiles,
  fitTask,
  hunkRanges,
  isExcludedPath,
  renderAttachments,
  selectAttachments,
  sliceAttachment,
  splitDiffFiles,
  syntheticNewFileDiff,
  TASK_MAX_BYTES,
} from "./diff";
import type { DiffFile, DiffSection } from "./diff";
import { applyVerdicts, mergeFindings, parseFindings, parseVerdicts } from "./findings";
import type { Finding, Severity, VerifiedBundle } from "./findings";
import { FINDER_LENSES, finderAgent, finderTask, verifyAgent, verifyTask } from "./lenses";

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ReviewDeps {
  /** Run git in the repo (args only, cwd fixed by the caller); bounded. */
  git: (args: string[]) => Promise<GitResult>;
  /** Run a shell command (check cmd); bounded; null when unset or spawn-failed. */
  shell: (command: string) => Promise<string | null>;
  readFile: (p: string) => Promise<string | undefined>;
  writeFile: (p: string, data: string) => Promise<void>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  spawnFn: SpawnFn;
  /** Session model for child inheritance. */
  sessionModel?: { provider?: string; id?: string } | null;
  now?: () => number;
}

const GIT_MAX_BYTES = 8 * 1024 * 1024;
const CHECK_MAX_CHARS = 64 * 1024;

/** Default git runner: execFile with a hard timeout and capped buffers. Paths
 * pass through unquoted (core.quotePath=false) so non-ASCII filenames parse. */
export function defaultGit(cwd: string): (args: string[]) => Promise<GitResult> {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["-c", "core.quotePath=false", ...args],
        { cwd, timeout: 30_000, maxBuffer: GIT_MAX_BYTES },
        (err, stdout, stderr) => {
          const cap = (b?: Buffer | string) => {
            const s = typeof b === "string" ? b : (b?.toString("utf8") ?? "");
            return s.length > GIT_MAX_BYTES ? s.slice(0, GIT_MAX_BYTES) : s;
          };
          const code =
            err && typeof (err as NodeJS.ErrnoException).code === "number" ? (err.code as number) : err ? 1 : 0;
          resolve({ code, stdout: cap(stdout), stderr: cap(stderr) || (err ? String(err.message) : "") });
        },
      );
    });
}

/** Default shell runner for the optional check command. */
export function defaultShell(cwd: string): (command: string) => Promise<string | null> {
  return (command) =>
    new Promise((resolve) => {
      execFile(
        "sh",
        ["-c", command],
        { cwd, timeout: 10 * 60_000, maxBuffer: CHECK_MAX_CHARS },
        (err, stdout, stderr) => {
          // Both streams, capped together: check output is evidence, not gospel.
          const text = `${stdout ?? ""}${stderr ?? ""}`.slice(0, CHECK_MAX_CHARS);
          if (err && !text.trim()) resolve(null);
          else resolve(text || "(no output)");
        },
      );
    });
}

export interface ReviewResult {
  report: string;
  /** The final (capped) findings behind the report — data, not just display. */
  findings: Finding[];
  /** Per-finder failures and lens coverage gaps, disclosed in the report and
   * exposed here so evals can record *why* a lens went quiet (timeouts reaping
   * slow finders look identical to "found nothing" in findings alone). */
  coverage: { errors: string[]; uncoveredFiles: string[]; lensCoverage: Record<number, string[]> };
  usage?: ChildUsage;
  findingCount: number;
}

/** Pre-assembled review input — the eval harness drives the exact production
 * pipeline over fixture diffs (no git, no working tree) by passing this. */
export interface ProvidedReview {
  sections: DiffSection[];
  /** Stand-in repo root for guideline collection (an empty dir in eval). */
  repoRoot: string;
  targetLabel: string;
}

/** Resolve the target into diff sections (may run several git commands). */
async function resolveDiffSections(
  target: TargetSpec,
  deps: ReviewDeps,
): Promise<{ sections: DiffSection[]; error?: string }> {
  // Diffs return null on failure; attach the stderr tail so a maxBuffer kill,
  // a missing git binary, or an unborn HEAD is distinguishable from "not a repo".
  let lastStderr = "";
  const diff = async (...args: string[]) => {
    const r = await deps.git(["diff", "--no-color", "-U3", ...args]);
    if (r.code !== 0) lastStderr = r.stderr;
    return r.code === 0 ? r.stdout : null;
  };
  const uncommitted = async () => {
    const r = await deps.git(["diff", "--no-color", "-U3", "HEAD"]);
    if (r.code !== 0) lastStderr = r.stderr;
    return r.code === 0 ? r.stdout : null;
  };
  const fail = (context: string) => `${context}${lastStderr.trim() ? `: ${lastStderr.trim().slice(0, 300)}` : ""}`;
  const sections: DiffSection[] = [];
  if (target.kind === "staged") {
    const staged = await diff("--cached");
    if (staged === null) return { sections, error: fail("git diff --cached failed (not a git repository?)") };
    if (staged.trim()) sections.push({ label: "staged changes", text: staged });
    return { sections };
  }
  if (target.kind === "uncommitted") {
    const work = await uncommitted();
    if (work === null) return { sections, error: fail("git diff HEAD failed (not a git repository?)") };
    if (work.trim()) sections.push({ label: "uncommitted changes (staged and unstaged)", text: work });
    return { sections };
  }
  if (target.kind === "range") {
    const ahead = await diff(`${target.base}...${target.head}`);
    if (ahead === null) return { sections, error: fail(`git diff ${target.base}...${target.head} failed (bad refs?)`) };
    if (ahead.trim()) sections.push({ label: `commits ${target.base}..${target.head}`, text: ahead });
    const work = await uncommitted();
    if (work?.trim()) sections.push({ label: "uncommitted changes (staged and unstaged)", text: work });
    return { sections };
  }
  if (target.kind === "ref") {
    const ahead = await diff(`${target.ref}...HEAD`);
    if (ahead === null) {
      return { sections, error: fail(`git diff ${target.ref}...HEAD failed (unknown ref "${target.ref}"?)`) };
    }
    if (ahead.trim()) sections.push({ label: `commits ahead of ${target.ref}`, text: ahead });
    const work = await uncommitted();
    if (work?.trim()) sections.push({ label: "uncommitted changes (staged and unstaged)", text: work });
    return { sections };
  }
  // default: ahead of upstream when one exists, plus local work
  const upstream = await deps.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream.code === 0 && upstream.stdout.trim()) {
    const up = upstream.stdout.trim();
    const ahead = await diff(`${up}...HEAD`);
    if (ahead?.trim()) sections.push({ label: `commits ahead of ${up}`, text: ahead });
  }
  const work = await uncommitted();
  if (work === null) return { sections, error: fail("git diff failed (not a git repository?)") };
  if (work.trim()) sections.push({ label: "uncommitted changes (staged and unstaged)", text: work });
  return { sections };
}

/** Untracked files as synthetic new-file diffs, within the byte budget. */
async function untrackedSection(repoRoot: string, deps: ReviewDeps, maxBytes: number): Promise<DiffSection | null> {
  const listing = await deps.git(["ls-files", "--others", "--exclude-standard"]);
  if (listing.code !== 0) return null;
  const paths = listing.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const eligible = paths.filter((p) => !isExcludedPath(p));
  const blocks: string[] = [];
  let budget = maxBytes;
  for (const p of eligible) {
    const content = await deps.readFile(path.join(repoRoot, p));
    if (content === undefined) continue;
    if (content.length > budget) break; // budget exhausted; the rest is disclosed by count
    budget -= content.length;
    blocks.push(syntheticNewFileDiff(p, content));
  }
  if (!blocks.length) return null;
  const skipped = eligible.length - blocks.length;
  const note = skipped > 0 ? `\n(${skipped} untracked file(s) skipped: size budget)` : "";
  return { label: "untracked (new) files", text: blocks.join("\n") + note };
}

/** Assign (lens × chunk) pairs under the child cap: chunks shed lenses, correctness first. */
export function planFinderRuns(
  chunks: number,
  lensIds: string[],
  maxChildren: number,
): Array<{ lens: string; chunk: number }> {
  const wanted: Array<{ lens: string; chunk: number }> = [];
  for (let c = 0; c < chunks; c++) for (const lens of lensIds) wanted.push({ lens, chunk: c });
  if (wanted.length <= maxChildren) return wanted;
  // Keep every chunk covered by as many lenses as fit, in lens-priority order.
  const kept: Array<{ lens: string; chunk: number }> = [];
  for (const lens of lensIds) {
    for (let c = 0; c < chunks && kept.length < maxChildren; c++) kept.push({ lens, chunk: c });
    if (kept.length >= maxChildren) break;
  }
  // Even one lens per chunk does not fit: cover chunks in order, correctness only.
  if (new Set(kept.map((k) => k.chunk)).size < chunks) {
    kept.length = 0;
    for (let c = 0; c < chunks && kept.length < maxChildren; c++) kept.push({ lens: lensIds[0], chunk: c });
  }
  return kept;
}

/** Render the final markdown report. */
export function renderReport(opts: {
  targetLabel: string;
  /** Verification opted out via PI_REVIEW_VERIFY=0 — disclosed, not silent. */
  verifySkipped?: boolean;
  reviewedFiles: string[];
  /** Files in chunks no finder covered (child cap or failures) — disclosed, never listed as reviewed. */
  uncoveredFiles: string[];
  skippedFiles: string[];
  lensCoverage: Map<number, string[]>;
  chunkCount: number;
  /** Lenses planned per chunk — coverage below this is partial. */
  plannedLensCount: number;
  bundle: VerifiedBundle;
  usage?: ChildUsage;
  durationMs: number;
  priorNote: string;
}): string {
  const { bundle } = opts;
  const lines: string[] = [];
  const sev = (s: Severity) => ({ critical: "🔴 Critical", important: "🟠 Important", suggestion: "🟡 Suggestion" })[s];
  lines.push(`# Code review — ${opts.targetLabel}`);
  if (bundle.findings.length === 0) {
    const rejectedNote = bundle.rejected.length
      ? ` ${bundle.rejected.length} candidate(s) were rejected by verification.`
      : "";
    lines.push("", `**No actionable findings.**${rejectedNote}`);
  } else {
    if (bundle.unverified) lines.push("", "> ⚠️ Verification stage failed — findings below are **unverified**.");
    else if (opts.verifySkipped)
      lines.push("", "> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.");
    let lastSev = "";
    for (const f of bundle.findings) {
      if (f.severity !== lastSev) {
        lines.push("", `## ${sev(f.severity)}`);
        lastSev = f.severity;
      }
      lines.push(
        "",
        `### ${f.title}`,
        `**\`${f.file}${f.line ? `:${f.line}` : ""}\`** — found by ${f.lenses.join(", ")}`,
        f.detail,
      );
      if (f.recommendation) lines.push("", `**Fix**: ${f.recommendation}`);
    }
  }
  lines.push("", "---", "", "**Scope reviewed**:");
  lines.push(`- Files: ${opts.reviewedFiles.join(", ") || "(none)"}`);
  // Coverage is always disclosed when partial: any uncovered or lens-shed
  // chunk (child cap, failures), or any multi-chunk review.
  const coveredChunks = [...opts.lensCoverage.keys()].sort((a, b) => a - b);
  const lensShed = coveredChunks.some((c) => (opts.lensCoverage.get(c)?.length ?? 0) < opts.plannedLensCount);
  const partial =
    opts.chunkCount > 1 || lensShed || coveredChunks.length < opts.chunkCount || opts.uncoveredFiles.length > 0;
  if (partial) {
    const perChunk = Array.from({ length: opts.chunkCount }, (_, c) => {
      const lenses = opts.lensCoverage.get(c);
      return `chunk ${c + 1}: ${lenses?.length ? lenses.join(", ") : "NOT COVERED (child cap or finder failure)"}`;
    });
    lines.push(`- ${opts.chunkCount} chunks — ${perChunk.join("; ")}`);
  }
  if (opts.uncoveredFiles.length) {
    lines.push(`- ⚠️ Not reviewed (no finder covered their chunk): ${opts.uncoveredFiles.join(", ")}`);
  }
  if (opts.skippedFiles.length) lines.push(`- ⚠️ Excluded from review: ${opts.skippedFiles.join(", ")}`);
  if (bundle.rejected.length) {
    lines.push(
      "",
      "**Rejected by verification**:",
      ...bundle.rejected.map(
        (r) => `- ${r.finding.file}${r.finding.line ? `:${r.finding.line}` : ""} ${r.finding.title} — ${r.reason}`,
      ),
    );
  }
  if (opts.priorNote) lines.push("", opts.priorNote);
  const secs = Math.round(opts.durationMs / 1000);
  const usageNote = opts.usage
    ? `, ${(opts.usage.totalTokens / 1000).toFixed(1)}k tokens ($${opts.usage.cost.total.toFixed(3)})`
    : "";
  lines.push(
    "",
    `_Reviewed ${opts.reviewedFiles.length} file(s) in ${secs}s${usageNote}. Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._`,
  );
  return lines.join("\n");
}

interface StateFile {
  findings: Finding[];
  target: string;
  savedAt: number;
}

const STATE_PATH = ".pi/review-state.json";

/** Track spawned children so a session shutdown can kill the whole pipeline —
 * an orphaned child burns tokens with nobody consuming the result. */
export function trackedSpawn(inner: SpawnFn): { spawnFn: SpawnFn; killAll: () => number } {
  const live = new Set<{ kill: () => void }>();
  return {
    spawnFn: (command, args, options) => {
      const child = inner(command, args, options);
      live.add(child);
      child.on("close", () => live.delete(child));
      return child;
    },
    killAll: () => {
      let killed = 0;
      for (const child of live) {
        child.kill();
        killed++;
      }
      live.clear();
      return killed;
    },
  };
}

/** Run a child, retrying exactly once when it stalls. A silent child is the
 * one transient failure worth a re-attempt — the request died mid-run, and a
 * fresh child simply re-does the work; every other error surfaces as-is.
 * Usage burned by stalled attempts is carried into the result (or onto the
 * terminal error, when the retry fails too) so the spend stays accounted.
 * Pure wrapper over an injected run for direct testing. */
export async function withStallRetry(
  opts: { label: string; notify: ReviewDeps["notify"]; signal?: AbortSignal },
  run: () => Promise<ChildRun>,
): Promise<ChildRun> {
  let carried: ChildUsage | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await run();
      const usage = sumUsages([carried, result.usage]);
      return carried ? { ...result, usage } : result;
    } catch (err) {
      // A cancelled review must not spawn retries; other errors are not stalls.
      if (attempt >= 2 || !isStalledError(err) || opts.signal?.aborted) {
        // Earlier stalled attempts still spent tokens; their usage rides the
        // terminal error so callers crediting r.reason.usage see every child.
        const merged = sumUsages([carried, (err as { usage?: ChildUsage }).usage]);
        if (carried && merged) Object.assign(err as object, { usage: merged });
        throw err;
      }
      carried = sumUsages([carried, (err as { usage?: ChildUsage }).usage]);
      opts.notify(
        `${opts.label} stalled (no output from the model, likely a dead request) — retrying, attempt 2 of 2`,
        "warning",
      );
    }
  }
}

function renderPrior(findings: Finding[], budget: number): string {
  if (budget <= 0 || findings.length === 0) return "";
  const line = (f: Finding) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.title}`;
  let out = findings.map(line).join("\n");
  if (out.length > budget) {
    out = out.slice(0, budget);
    const nl = out.lastIndexOf("\n");
    out = `${out.slice(0, nl)}\n- (older findings elided)`;
  }
  return out;
}

function targetLabel(target: TargetSpec): string {
  switch (target.kind) {
    case "ref":
      return `changes since ${target.ref}`;
    case "range":
      return `${target.base}..${target.head}`;
    case "staged":
      return "staged changes";
    case "uncommitted":
      return "uncommitted changes";
    default:
      return "changes ahead of upstream plus working tree";
  }
}

/** Run the full pipeline. Pure orchestration over injected deps. */
export async function runReview(opts: {
  cwd: string;
  config: ReviewConfig;
  target: TargetSpec;
  deps: ReviewDeps;
  /** Skip git entirely and review these pre-assembled sections (eval harness). */
  provided?: ProvidedReview;
  /** Cancellation (Esc during a tool call): kills in-flight children and bails
   * out — abort never rides the fail-open path, which would complete a
   * cancelled review instead of stopping it. */
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const { config, deps, signal } = opts;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // Stage 0a: diff sections.
  let sections: DiffSection[];
  let repoRoot: string;
  let label: string;
  if (opts.provided) {
    sections = opts.provided.sections;
    repoRoot = opts.provided.repoRoot;
    label = opts.provided.targetLabel;
  } else {
    const rootResult = await deps.git(["rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) {
      throw new Error(`Not a git repository: ${rootResult.stderr.trim() || "git rev-parse failed"}`);
    }
    repoRoot = rootResult.stdout.trim();
    label = targetLabel(opts.target);
    const resolved = await resolveDiffSections(opts.target, deps);
    if (resolved.error) throw new Error(resolved.error);
    sections = resolved.sections;
    if (opts.target.kind !== "staged") {
      const untracked = await untrackedSection(repoRoot, deps, config.untrackedMaxBytes);
      if (untracked) sections.push(untracked);
    }
  }
  if (sections.length === 0) {
    const emptyNote =
      opts.target.kind === "default" ? " (nothing ahead of upstream, uncommitted, or untracked)" : " for this target";
    return {
      report: `# Code review\n\nNo changes to review${emptyNote}.`,
      findings: [],
      coverage: { errors: [], uncoveredFiles: [], lensCoverage: {} },
      findingCount: 0,
    };
  }

  // Stage 0b: parse and exclude.
  const files: DiffFile[] = [];
  const skipped: string[] = [];
  for (const section of sections) {
    for (const file of splitDiffFiles(section.text)) {
      if (isExcludedPath(file.path)) skipped.push(file.path);
      else files.push(file);
    }
  }
  if (files.length === 0) {
    const list = skipped.map((s) => `- ${s}`).join("\n");
    return {
      report: `# Code review\n\nAll changed files are excluded from review (lockfiles, logs, generated, or binary):\n${list}`,
      findings: [],
      coverage: { errors: [], uncoveredFiles: [], lensCoverage: {} },
      findingCount: 0,
    };
  }
  // Stage 0c: guidelines + prior findings + optional check output — before
  // chunking, so the per-chunk budget accounts for the context they consume.
  const guidelines = await collectGuidelines(
    repoRoot,
    files.map((f) => f.path),
    deps,
  );
  let priorFindings = "";
  let priorNote = "";
  let carried: Finding[] = [];
  if (config.persist) {
    const raw = await deps.readFile(path.join(repoRoot, STATE_PATH));
    if (raw) {
      try {
        const state = JSON.parse(raw) as StateFile;
        // Only carry priors for the same target — findings from `/review main`
        // describe a different change set than `/review tree`.
        if (Array.isArray(state.findings) && state.target === label) carried = state.findings;
      } catch {
        // Unreadable state is not worth failing a review over.
      }
    }
    priorFindings = renderPrior(carried, config.priorChars);
    if (priorFindings) priorNote = `Continuing from a previous review (${carried.length} finding(s) carried over).`;
  }
  let checkOutput = "";
  if (config.checkCmd) {
    deps.notify(`Running check command: ${config.checkCmd}`, "info");
    checkOutput = (await deps.shell(config.checkCmd)) ?? "(check command produced no output)";
  }

  // Stage 0d: chunk on file boundaries with the effective budget.
  const contextChars = guidelines.length + priorFindings.length + 2_000;
  const chunks = chunkDiffFiles(files, Math.max(8_000, config.chunkChars - contextChars));
  const chunkText = (i: number) => chunks[i].files.map((f) => f.text).join("\n");

  // Stage 0e: attach each chunk's changed files — hunk-centered windows of
  // current contents (whole file when small), so every changed region rides
  // in the task regardless of file size. The finder's first tool calls are
  // re-reads of exactly these regions; paying for them up front gives every
  // lens the same head start instead of four independent discoveries. Never
  // shrinks the diff: attachments use only the headroom the task byte cap
  // leaves, so fitTask never truncates the diff to make room. A missing file
  // is a deletion (or eval's empty tree) — absence is in the diff, nothing to
  // attach; a no-hunk file diff (rename/mode-only) has nothing to anchor a
  // window on.
  const attachments: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    attachments.push("");
    if (config.attachChars <= 0) continue;
    const skeleton = finderTask({
      lens: FINDER_LENSES[0],
      chunkIndex: i,
      chunkCount: chunks.length,
      diffText: "",
      guidelines,
      priorFindings,
    });
    const headroom =
      TASK_MAX_BYTES -
      Buffer.byteLength(skeleton, "utf8") -
      Buffer.byteLength(chunkText(i), "utf8") -
      2_048; /* truncation-note margin */
    const budget = Math.min(config.attachChars, headroom);
    if (budget <= 0) continue;
    // Sizes are BYTES, matching headroom and TASK_MAX_BYTES — a chars-based
    // count would silently overrun the task cap on multibyte content (em-dashes
    // in comments are 3 bytes counted as 1) and truncate the diff we promised
    // never to shrink. Paths resolve against repoRoot, not cwd: git diff
    // prints repo-root-relative paths, and the session cwd may be a
    // subdirectory. Files whose windows overflow the per-file cap are named
    // in the skipped note — a finder that knows what it is missing reads it.
    const read: Array<{ path: string; label: string; size: number; content: string }> = [];
    const oversized: string[] = [];
    for (const f of chunks[i].files) {
      const content = await deps.readFile(path.join(repoRoot, f.path));
      if (content === undefined) continue;
      const piece = sliceAttachment(content, hunkRanges(f.text));
      if (piece) {
        read.push({
          path: f.path,
          label: piece.label,
          size: Buffer.byteLength(piece.content, "utf8"),
          content: piece.content,
        });
      } else if (hunkRanges(f.text).length > 0) {
        oversized.push(f.path);
      }
    }
    if (read.length === 0 && oversized.length === 0) continue;
    // Charge the rendered section, not just file bodies — per-file headers and
    // the preamble are real bytes, and dozens of files can overflow any fixed
    // margin. Compose, measure, drop the largest attachment, repeat: the
    // composed task fits the cap or nothing is attached — the diff never
    // truncates to make room.
    let candidates = read;
    let section = "";
    for (;;) {
      const sel = selectAttachments(
        candidates.map(({ path: p, size }) => ({ path: p, size })),
        budget,
      );
      const kept = candidates.filter((f) => sel.attached.includes(f.path));
      section = renderAttachments(kept, [...sel.skipped, ...oversized]);
      const taskBytes = Buffer.byteLength(
        finderTask({
          lens: FINDER_LENSES[0],
          chunkIndex: i,
          chunkCount: chunks.length,
          diffText: chunkText(i),
          guidelines,
          priorFindings,
          attachments: section,
        }),
        "utf8",
      );
      if (taskBytes <= TASK_MAX_BYTES || kept.length === 0) break;
      const largest = kept.reduce((a, b) => (b.size > a.size ? b : a));
      candidates = candidates.filter((f) => f !== largest);
    }
    attachments[i] = section;
  }

  // Stage 1: finders.
  // One configuration — every lens, every review. Tiers are gone: the eval
  // showed the four-lens set is the quality floor worth paying for, and finders
  // run in parallel so the marginal lens costs tokens, not wall time.
  const lensIds = FINDER_LENSES.map((l) => l.id);
  const lenses = new Map(FINDER_LENSES.map((l) => [l.id, l]));
  const runs = planFinderRuns(chunks.length, lensIds, config.maxChildren);
  // Pre-flight abort check: an already-cancelled review spawns nothing.
  if (signal?.aborted) throw new Error("review aborted");
  deps.notify(
    `Reviewing ${files.length} file(s) in ${chunks.length} chunk(s) with ${runs.length} finder run(s)…`,
    "info",
  );
  // Per-finder progress: the wave is parallel and otherwise silent for its
  // whole duration — with verification on by default the tail is longer
  // still, so each finder landing is the user's signal the review is moving.
  let finderDone = 0;
  const findResults = await runWithLimit(
    runs.map((run) => () => {
      const lens = lenses.get(run.lens)!;
      const agent = finderAgent(lens);
      if (signal?.aborted) throw new Error("review aborted");
      const { task } = fitTask(
        (diff) =>
          finderTask({
            lens,
            chunkIndex: run.chunk,
            chunkCount: chunks.length,
            diffText: diff,
            guidelines,
            priorFindings,
            attachments: attachments[run.chunk] || undefined,
          }),
        chunkText(run.chunk),
      );
      const label = `finder ${run.lens}/${run.chunk}`;
      return withStallRetry({ label, notify: deps.notify, signal }, () =>
        runChild(
          agent,
          task,
          resolveChildModel(config.model ?? agent.model, deps.sessionModel),
          { timeoutMs: config.timeoutMs, idleTimeoutMs: config.idleTimeoutMs, signal },
          deps.spawnFn,
        ),
      ).then(
        (r) => {
          const outcome = "adopted" in r ? "backgrounded" : `${parseFindings(r.text, run.lens).length} finding(s)`;
          deps.notify(`${label} done (${++finderDone}/${runs.length}): ${outcome}`, "info");
          return r;
        },
        (err: unknown) => {
          // A cancelled review rejects its in-flight children — that is the
          // user's own Esc, not a finder failure; the abort surfaces through
          // runReview's own path. withStallRetry uses the same check.
          if (!signal?.aborted) deps.notify(`${label} failed (${++finderDone}/${runs.length})`, "warning");
          throw err;
        },
      );
    }),
    Math.min(config.concurrency, runs.length) || 1,
  );
  const usageParts: Array<ChildUsage | undefined> = [];
  const findingLists: Finding[][] = [];
  const errors: string[] = [];
  // Coverage comes from outcomes, not the plan: a crashed finder never covered
  // its chunk, whatever the plan said.
  const lensCoverage = new Map<number, string[]>();
  if (signal?.aborted) throw new Error("review aborted");
  findResults.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(
        `finder ${runs[i].lens}/${runs[i].chunk}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
      const u = (r.reason as { usage?: ChildUsage })?.usage;
      if (u) usageParts.push(u);
    } else if (!("adopted" in r.value)) {
      findingLists.push(parseFindings(r.value.text, runs[i].lens));
      usageParts.push(r.value.usage);
      const covered = lensCoverage.get(runs[i].chunk) ?? [];
      covered.push(runs[i].lens);
      lensCoverage.set(runs[i].chunk, covered);
    }
  });
  const candidates = mergeFindings(findingLists);

  // Stage 2: verify.
  let bundle: VerifiedBundle = { findings: candidates, rejected: [], unverified: false };
  if (candidates.length > 0 && config.verify) {
    deps.notify(`Verifying ${candidates.length} candidate finding(s)…`, "info");
    const vAgent = verifyAgent();
    const { task: vTask } = fitTask(
      (diff) =>
        verifyTask({
          diffText: diff,
          guidelines,
          checkOutput,
          priorFindings,
          candidates,
        }),
      files.map((f) => f.text).join("\n"),
    );
    try {
      const run = await withStallRetry({ label: "verifier", notify: deps.notify, signal }, () =>
        runChild(
          vAgent,
          vTask,
          resolveChildModel(config.verifyModel ?? config.model ?? vAgent.model, deps.sessionModel),
          { timeoutMs: config.timeoutMs, idleTimeoutMs: config.idleTimeoutMs, signal },
          deps.spawnFn,
        ),
      );
      if ("adopted" in run) throw new Error("verifier backgrounded unexpectedly");
      const verdicts = parseVerdicts(run.text);
      bundle = applyVerdicts(candidates, verdicts);
      usageParts.push(run.usage);
    } catch (err) {
      const e = err as Error & { usage?: ChildUsage };
      if (signal?.aborted) throw new Error("review aborted");
      errors.push(`verification failed: ${e.message}`);
      if (e.usage) usageParts.push(e.usage);
      bundle = { findings: candidates, rejected: [], unverified: true };
    }
  }

  // Stage 3: cap, render, persist. Uncovered chunks are disclosed, not hidden:
  // the files list separates what was actually reviewed from what the cap skipped.
  const capped = bundle.findings.slice(0, config.maxFindings);
  const usage = sumUsages(usageParts);
  const coveredChunks = new Set(lensCoverage.keys());
  const uncoveredFiles = chunks.map((chunk, i) => (coveredChunks.has(i) ? [] : chunk.files.map((f) => f.path))).flat();
  const reviewedFiles = chunks.map((chunk, i) => (coveredChunks.has(i) ? chunk.files.map((f) => f.path) : [])).flat();
  const report = renderReport({
    targetLabel: label,
    verifySkipped: !config.verify,
    reviewedFiles,
    uncoveredFiles,
    skippedFiles: skipped,
    lensCoverage,
    chunkCount: chunks.length,
    plannedLensCount: lensIds.length,
    bundle: { ...bundle, findings: capped },
    usage,
    durationMs: now() - startedAt,
    priorNote,
  });
  const pipelineNotes = errors.length ? `\n\n**Pipeline notes**:\n${errors.map((e) => `- ${e}`).join("\n")}` : "";
  if (config.persist) {
    try {
      await deps.writeFile(
        path.join(repoRoot, STATE_PATH),
        JSON.stringify({ findings: capped, target: label, savedAt: Math.floor(now() / 1000) } satisfies StateFile),
      );
    } catch {
      // Persistence is best-effort; the review stands without it.
    }
  }
  return {
    report: report + pipelineNotes,
    findings: capped,
    coverage: {
      errors,
      uncoveredFiles,
      lensCoverage: Object.fromEntries([...lensCoverage.entries()].map(([c, ls]) => [c, [...ls]])),
    },
    usage,
    findingCount: capped.length,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function reviewDeps(cwd: string, overrides?: Partial<ReviewDeps>): ReviewDeps {
  return {
    git: defaultGit(cwd),
    shell: defaultShell(cwd),
    readFile: async (p) => {
      try {
        return await readFile(p, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: async (p, data) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data, "utf8");
    },
    notify: () => {},
    spawnFn: defaultSpawn,
    sessionModel: null,
    ...overrides,
  };
}

/** Compact agent-facing summary of a review: one line per finding plus coverage
 * gaps and a pointer to the full report. The parent agent gets the gist for a
 * few hundred tokens and reads the report file only when it needs detail —
 * the context-cost discipline the eval header commits to. */
export function summarizeForTool(result: ReviewResult, reportPath?: string): string {
  const lines: string[] = [];
  const bySev = { critical: 0, important: 0, suggestion: 0 };
  for (const f of result.findings) bySev[f.severity]++;
  const counts = [
    bySev.critical ? `${bySev.critical} critical` : "",
    bySev.important ? `${bySev.important} important` : "",
    bySev.suggestion ? `${bySev.suggestion} suggestion` : "",
  ]
    .filter(Boolean)
    .join(", ");
  lines.push(
    result.findings.length === 0 ? "No actionable findings." : `${result.findings.length} finding(s): ${counts}.`,
  );
  for (const f of result.findings) {
    lines.push(`[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.title}`);
  }
  const gaps = result.coverage.uncoveredFiles;
  if (gaps.length > 0 || result.coverage.errors.length > 0) {
    lines.push(`Coverage gaps: ${gaps.length} file(s) unreviewed, ${result.coverage.errors.length} finder error(s).`);
  }
  if (reportPath) lines.push(`Full report: ${reportPath}`);
  return lines.join("\n");
}
