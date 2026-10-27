/** The pipeline: bounded git/shell runners, diff-section resolution, finder
 * planning, the find→verify→report orchestration (runReview), prior-finding
 * persistence, and the agent-facing summary. */

import { execFile } from "node:child_process";
import { lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
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
import { collectGuidelines, readRepoFile } from "./config";
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

/** Process execution result from a git command. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected external dependencies and environment bindings for the review pipeline. */
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
  /** Directory listing for the non-git tree walk; injected so tests walk
   * fakes instead of disk. Optional — treeSection falls back to the default. */
  listDir?: (dir: string) => Promise<TreeEntry[]>;
}

/** A flattened directory entry: enough shape for the walk's decisions
 * (recurse, skip, collect) without dragging node's Dirent into the dep. */
export interface TreeEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Default listing: opendir(3) streaming iteration, not readdir — a huge
 * directory is detected at the cap instead of being fully materialized
 * first. Over the cap the walk treats it as an unreadable directory (a
 * named skip for nested paths, a loud root failure); the custom code is
 * what walkTree absorbs — see ABSORBABLE_LIST_ERRORS. */
export const MAX_DIR_ENTRIES = 10_000;
export const MANY_ENTRIES = "EMANYENTRIES";
export const defaultListDir = async (dir: string): Promise<TreeEntry[]> => {
  const out: TreeEntry[] = [];
  const dh = await opendir(dir);
  try {
    for await (const e of dh) {
      if (out.length >= MAX_DIR_ENTRIES) {
        const err = new Error(
          `${dir}: over ${MAX_DIR_ENTRIES} entries — directory too large to walk`,
        ) as NodeJS.ErrnoException;
        err.code = MANY_ENTRIES;
        throw err;
      }
      out.push({ name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() });
    }
  } finally {
    await dh.close().catch(() => {}); // already closed after full iteration
  }
  return out;
};

const GIT_MAX_BYTES = 8 * 1024 * 1024;
const CHECK_MAX_CHARS = 64 * 1024;

/** Default git runner: execFile with a hard timeout and capped buffers. Paths
 * pass through unquoted (core.quotePath=false) so non-ASCII filenames parse,
 * and LC_ALL=C pins git's stderr to English — the pipeline branches on git's
 * "not a git repository" message, which gettext would otherwise translate. */
export function defaultGit(cwd: string): (args: string[]) => Promise<GitResult> {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["-c", "core.quotePath=false", ...args],
        { cwd, timeout: 30_000, maxBuffer: GIT_MAX_BYTES, env: { ...process.env, LC_ALL: "C" } },
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

/** Final outcome of a complete code review run, including formatted report, structured findings, and metadata. */
export interface ReviewResult {
  report: string;
  /** Every pipeline note (wiring disclosures plus per-finder errors), exposed
   * so callers that cannot reach the written report — e.g. the report write
   * itself failed — still surface the disclosures. */
  notes: string[];
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

/** Shared body behind untracked and whole-tree sections: eligible paths →
 * guarded reads → synthetic new-file diffs, within the byte budget.
 * Guard refusals ride the section note when there is a section to carry
 * them (the finder sees what it is missing); when every file was refused
 * there is no diff to review, and the refusals come back as `notes`
 * instead — runReview surfaces them in the report's pipeline notes rather
 * than letting a note-only section masquerade as reviewable content
 * (splitDiffFiles would parse zero files out of it). */
async function syntheticFileSection(
  repoRoot: string,
  paths: string[],
  deps: ReviewDeps,
  maxBytes: number,
  /** Section label in the assembled diff. */
  label: string,
  /** Noun for refusal notes — "untracked" vs "tree", so the report says
   * which population a refused file belongs to. */
  what: string,
): Promise<{ section: DiffSection | null; notes: string[] }> {
  const eligible = paths.filter((p) => !isExcludedPath(p));
  const blocks: string[] = [];
  const refused: string[] = [];
  let budget = maxBytes;
  let budgetExhausted = false;
  for (const p of eligible) {
    // Same anchored, symlink-refusing read as guidelines/state: an untracked
    // `leak -> ~/.ssh/…` must not ride the diff into finder tasks. The byte
    // bound is 4x the char budget so legit multibyte content still fits.
    const r = await readRepoFile(repoRoot, path.join(repoRoot, p), maxBytes * 4, deps.readFile);
    if (r.kind === "refused") {
      refused.push(p); // named, not folded into the size-budget count — different cause
      continue;
    }
    if (r.kind === "missing") continue;
    const content = r.content;
    if (content.length > budget) {
      budgetExhausted = true;
      break; // the rest is disclosed by count
    }
    budget -= content.length;
    blocks.push(syntheticNewFileDiff(p, content));
  }
  if (!blocks.length) {
    if (refused.length === 0) return { section: null, notes: [] };
    return {
      section: null,
      notes: [
        `${what} file(s) skipped by the read guard (oversized, not a plain file, or a symlink escape) and not reviewed: ${refused.join(", ")}`,
      ],
    };
  }
  const skippedByBudget = eligible.length - blocks.length - refused.length;
  // Refusals are named (a refused file must not masquerade as a size-budget
  // skip — the finder may want to know WHY a file is unreadable); budget
  // skips are counted, matching the pre-guard behavior.
  const notes: string[] = [];
  if (refused.length > 0)
    notes.push(`${refused.length} skipped — oversized, not a plain file, or a symlink escape: ${refused.join(", ")}`);
  if (skippedByBudget > 0 && budgetExhausted) notes.push(`${skippedByBudget} skipped: size budget`);
  const note = notes.length > 0 ? `\n(${notes.join("; ")})` : "";
  return { section: { label, text: blocks.join("\n") + note }, notes: [] };
}

/** Untracked files (git listing) as synthetic new-file diffs. */
async function untrackedSection(
  repoRoot: string,
  deps: ReviewDeps,
  maxBytes: number,
): Promise<{ section: DiffSection | null; notes: string[] }> {
  const listing = await deps.git(["ls-files", "--others", "--exclude-standard"]);
  if (listing.code !== 0) return { section: null, notes: [] };
  const paths = listing.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return syntheticFileSection(repoRoot, paths, deps, maxBytes, "untracked (new) files", "untracked");
}

/** Credential-shaped filenames never read in whole-tree mode: a git'd
 * tree inherits this protection from .gitignore (`git ls-files` honors it),
 * but a plain tree has no such signal, so the walk applies a denylist and
 * names what it skipped — the contents never reach a finder task. */
const SECRET_FILE = [
  /(^|\/)\.env(\.[\w-]+)*$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[\w-]+)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.(npmrc|netrc|git-credentials|pgpass|my\.cnf|htpasswd)$/i,
  /(^|\/)(credentials|secrets?)\.json$/i,
];

/** Hard cap on files collected from a non-git tree: the walk stops and the
 * overage is disclosed, so a stray home directory cannot balloon a review.
 * MAX_TREE_ENTRIES bounds total WORK — a tree of directories holding only
 * excluded files would never advance the file cap, so the file cap alone
 * does not bound the walk. */
export const MAX_TREE_FILES = 5_000;
export const MAX_TREE_ENTRIES = 50_000;

/** Listing failures that are per-directory facts, safe to absorb as a named
 * skip. Anything else (EMFILE/EIO/ENOMEM, a broken injected dep) is systemic:
 * absorbing it would let a partial tree masquerade as the whole review. */
const ABSORBABLE_LIST_ERRORS = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", MANY_ENTRIES]);

/** Bounded recursive walk of a non-git tree: eligible plain files as
 * relative POSIX paths, deterministic (sorted, depth-first) order. Skips
 * dot-directories (`.git`, `.venv`, …), paths matching the exclusion list
 * (node_modules, build output, lockfiles, binaries — same list the diff
 * stage applies), credential-shaped files (SECRET_FILE, named in the notes),
 * and every symlink (named, not followed — following would duplicate content
 * and admit cycles; naming keeps every omission disclosed). A listing
 * failure that is a per-directory fact is skipped and named; a failed ROOT
 * listing throws ("could not list the tree" must not masquerade as "tree is
 * empty"), and so does any non-absorbable failure one level down. The abort
 * signal is honored mid-walk: a cancelled review must not finish the walk.
 * `truncated` says WHICH cap stopped the walk so the disclosure names it. */
export async function walkTree(
  root: string,
  listDir: (dir: string) => Promise<TreeEntry[]>,
  opts: { maxFiles?: number; maxEntries?: number; signal?: AbortSignal } = {},
): Promise<{
  paths: string[];
  truncated: null | "files" | "entries";
  skippedDirs: string[];
  skippedSymlinks: string[];
  skippedSecrets: string[];
}> {
  const maxFiles = opts.maxFiles ?? MAX_TREE_FILES;
  const maxEntries = opts.maxEntries ?? MAX_TREE_ENTRIES;
  const signal = opts.signal;
  const paths: string[] = [];
  const skippedDirs: string[] = [];
  const skippedSymlinks: string[] = [];
  const skippedSecrets: string[] = [];
  let truncated: null | "files" | "entries" = null;
  let visited = 0;
  const visit = async (rel: string): Promise<void> => {
    if (signal?.aborted) throw new Error("review aborted");
    if (truncated) return;
    let entries: TreeEntry[];
    try {
      entries = await listDir(rel ? path.join(root, rel) : root);
    } catch (err) {
      const dir = rel ? path.join(root, rel) : root;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (rel && ABSORBABLE_LIST_ERRORS.has(String(code))) {
        // EACCES, a vanished race, or the entry cap — name it, keep walking.
        skippedDirs.push(rel);
        return;
      }
      throw new Error(`cannot list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visited > maxEntries) {
        truncated = "entries";
        return;
      }
      if (signal?.aborted) throw new Error("review aborted");
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (e.name.startsWith(".") || isExcludedPath(`${childRel}/`)) continue;
        await visit(childRel);
      } else {
        if (isExcludedPath(childRel)) continue;
        if (e.isSymbolicLink) {
          skippedSymlinks.push(childRel);
          continue;
        }
        if (SECRET_FILE.some((re) => re.test(childRel))) {
          skippedSecrets.push(childRel);
          continue;
        }
        if (paths.length >= maxFiles) {
          truncated = "files";
          return;
        }
        paths.push(childRel);
      }
    }
  };
  await visit("");
  return { paths, truncated, skippedDirs, skippedSymlinks, skippedSecrets };
}

/** Bounded listing: a pathological tree can skip thousands of entries by any
 * one cause, and a disclosure note must not become the biggest thing in the
 * report — first 50 named, the rest counted. */
function cappedJoin(items: string[]): string {
  const shown = items.slice(0, 50);
  const more = items.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` …and ${more} more` : ""}`;
}

/** A non-git tree's whole contents as the diff under review: every walked
 * file is "new", exactly like untracked files in a repo. */
async function treeSection(
  repoRoot: string,
  deps: ReviewDeps,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ section: DiffSection | null; notes: string[] }> {
  const walk = await walkTree(repoRoot, deps.listDir ?? defaultListDir, { signal });
  const { skippedDirs, skippedSymlinks, skippedSecrets } = walk;
  const out = await syntheticFileSection(
    repoRoot,
    walk.paths,
    deps,
    maxBytes,
    "whole tree (no git repository)",
    "tree",
  );
  const notes = [...out.notes];
  // The note names the cap that fired — "stopped at N files" would misreport
  // an entries-cap stop (which can hit with zero files collected).
  if (walk.truncated === "files") notes.push(`tree walk stopped at ${MAX_TREE_FILES} files — later files not reviewed`);
  else if (walk.truncated === "entries")
    notes.push(`tree walk stopped at ${MAX_TREE_ENTRIES} visited entries — later entries not reviewed`);
  if (skippedDirs.length > 0) notes.push(`unreadable directories skipped: ${cappedJoin(skippedDirs)}`);
  if (skippedSymlinks.length > 0)
    notes.push(`${skippedSymlinks.length} symlink(s) skipped (not followed): ${cappedJoin(skippedSymlinks)}`);
  if (skippedSecrets.length > 0)
    notes.push(`likely-credential file(s) skipped and not reviewed: ${cappedJoin(skippedSecrets)}`);
  return { section: out.section, notes };
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

// Findings inform the author's judgment; they are not a fix-all queue. Keep
// the same stopping guidance in human reports and compact agent summaries.
const TRIAGE_GUIDANCE =
  "Triage: fix valid critical/important issues introduced by this change; suggestions are nonblocking and may be declined with a brief reason. Normally use at most one follow-up review, only for substantive fixes — not to clear suggestions or reach zero findings. Surface unresolved blockers.";

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
  lines.push("", `_Reviewed ${opts.reviewedFiles.length} file(s) in ${secs}s${usageNote}._`);
  if (bundle.findings.length > 0) lines.push("", TRIAGE_GUIDANCE);
  return lines.join("\n");
}

interface StateFile {
  findings: Finding[];
  target: string;
  savedAt: number;
}

const STATE_PATH = ".pi/review-state.json";
/** Upper bound on a readable review-state.json. Ours are a few tens of KB
 * (findings carry detail); anything larger is not state we wrote. */
const STATE_MAX_BYTES = 1_000_000;

/** Byte bound for reading a whole changed file to attach a hunk-centered
 * window. Deliberately far above the attachChars cap: the window logic needs
 * the full file, and only pathological sources (>4MB) are refused (and then
 * named in the skipped note) — the read itself is bounded and cheap. */
const ATTACH_MAX_BYTES = 4_000_000;

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

/** Markdown block for pipeline notes — wiring disclosures (e.g. a check
 * command skipped in a foreign directory) and per-finder errors. Rendered on
 * every path that produces a report, including the early returns: a clean
 * foreign tree is exactly where the skip note must still surface. */
function pipelineNotesBlock(notes: string[]): string {
  return notes.length ? `\n\n**Pipeline notes**:\n${notes.map((e) => `- ${e}`).join("\n")}` : "";
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

/** True when none of the paths is an existing symlink. Review artifacts land
 * under `<reviewed dir>/.pi/…`, and git preserves symlinks — a reviewed repo
 * could commit `.pi -> ~/.ssh` and redirect writes outside the repo. Missing
 * paths pass (mkdir creates them); the check closes the committed-symlink
 * hole, not a local attacker racing the write. */
export async function symlinkFree(...paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      if ((await lstat(p)).isSymbolicLink()) return false;
    } catch {
      // Missing (or inaccessible) here just means mkdir will create it.
    }
  }
  return true;
}

/** True when every path is absent or a real directory — stricter than
 * symlinkFree for report destinations: a reviewed repo can commit `.pi` as a
 * regular file too, and recursive mkdir would then fail (ENOTDIR) or worse.
 * Symlinks fail isDirectory(), so they are refused here as well. */
export async function dirsOrMissing(...paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      if (!(await lstat(p)).isDirectory()) return false;
    } catch (err) {
      // Anything other than "does not exist" (e.g. EACCES on a parent) means
      // we cannot vouch for the destination — refuse rather than write blind.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
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
  /** Disclosure lines prepended to the report's "Pipeline notes" — wiring
   * (the command/tool layer) reports deliberate behavior changes here, e.g.
   * a check command skipped for a foreign review directory. */
  notes?: string[];
}): Promise<ReviewResult> {
  const { config, deps, signal } = opts;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // Pipeline notes start as the caller's wiring disclosures and gain
  // pipeline-internal ones (e.g. untracked files the read guard refused);
  // they render on every report path, including the early returns.
  const pipelineNotes = opts.notes ? [...opts.notes] : [];

  // Stage 0a: diff sections.
  let sections: DiffSection[];
  let repoRoot: string;
  let label: string;
  let nonRepo = false;
  if (opts.provided) {
    sections = opts.provided.sections;
    repoRoot = opts.provided.repoRoot;
    label = opts.provided.targetLabel;
  } else {
    const rootResult = await deps.git(["rev-parse", "--show-toplevel"]);
    // A directory with no .git is still reviewable — as its whole tree. Only
    // git's explicit "not a git repository" takes that path; a missing git
    // binary or a permissions failure is a real error, not a plain tree.
    if (rootResult.code !== 0 && !rootResult.stderr.toLowerCase().includes("not a git repository")) {
      throw new Error(`git rev-parse failed: ${rootResult.stderr.trim() || "unknown git failure"}`);
    }
    const isNonRepo = rootResult.code !== 0;
    // readRepoFile realpaths both sides, so a symlink-spelled cwd anchors fine.
    repoRoot = isNonRepo ? opts.cwd : rootResult.stdout.trim();
    label = isNonRepo ? "whole tree (no git repository)" : targetLabel(opts.target);
    if (isNonRepo) {
      nonRepo = true;
      // staged/ref/range targets have no meaning without git history — say
      // so instead of failing later with a confusing diff error.
      if (opts.target.kind !== "default" && opts.target.kind !== "uncommitted") {
        throw new Error(
          `no git repository — "${targetLabel(opts.target)}" needs git history; review the whole tree instead (no target, or "tree")`,
        );
      }
      const tree = await treeSection(repoRoot, deps, config.untrackedMaxBytes, signal);
      sections = [];
      if (tree.section) sections.push(tree.section);
      pipelineNotes.push(...tree.notes);
    } else {
      const resolved = await resolveDiffSections(opts.target, deps);
      if (resolved.error) throw new Error(resolved.error);
      sections = resolved.sections;
      const extraNotes: string[] = [];
      if (opts.target.kind !== "staged") {
        const untracked = await untrackedSection(repoRoot, deps, config.untrackedMaxBytes);
        if (untracked.section) sections.push(untracked.section);
        extraNotes.push(...untracked.notes);
      }
      if (extraNotes.length > 0) pipelineNotes.push(...extraNotes);
    }
  }
  if (sections.length === 0) {
    const emptyNote = nonRepo
      ? " (no reviewable files in the tree)"
      : opts.target.kind === "default"
        ? " (nothing ahead of upstream, uncommitted, or untracked)"
        : " for this target";
    return {
      report: `# Code review\n\nNo changes to review${emptyNote}.` + pipelineNotesBlock(pipelineNotes),
      findings: [],
      coverage: { errors: [], uncoveredFiles: [], lensCoverage: {} },
      findingCount: 0,
      notes: [...pipelineNotes],
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
      report:
        `# Code review\n\nAll changed files are excluded from review (lockfiles, logs, generated, or binary):\n${list}` +
        pipelineNotesBlock(pipelineNotes),
      findings: [],
      coverage: { errors: [], uncoveredFiles: [], lensCoverage: {} },
      findingCount: 0,
      notes: [...pipelineNotes],
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
    // The read is anchored to the repo and bounded for the same reason as the
    // write below: the reviewed repo controls this path, and a committed
    // symlink or huge file must not hang or swamp the review.
    const raw = await readRepoFile(repoRoot, path.join(repoRoot, STATE_PATH), STATE_MAX_BYTES, deps.readFile);
    if (raw.kind === "ok") {
      try {
        const state = JSON.parse(raw.content) as StateFile;
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
    // subdirectory. The read is the same anchored, symlink-refusing one as
    // guidelines/state — a committed `leak -> ~/.ssh/…` shows up as a normal
    // file entry with hunks, and must not ride the diff into finder tasks
    // (byte bound 4x the char cap keeps legit multibyte content eligible).
    // Files whose windows overflow the per-file cap are named
    // in the skipped note — a finder that knows what it is missing reads it.
    // Files the guard refuses (symlink escape, not a plain file, over the
    // byte bound) land in the same skipped note as oversized windows — the
    // finder must know what it is missing either way. The bound is generous
    // (ATTACH_MAX_BYTES, not the char cap): window extraction needs the
    // whole file, and refusing a 300KB source over a 3-line change would
    // drop exactly the hunk context the attachment exists to provide.
    const read: Array<{ path: string; label: string; size: number; content: string }> = [];
    const oversized: string[] = [];
    const refusedFiles: string[] = [];
    for (const f of chunks[i].files) {
      const r = await readRepoFile(repoRoot, path.join(repoRoot, f.path), ATTACH_MAX_BYTES, deps.readFile);
      if (r.kind === "refused") {
        // Size refusals are ordinary readable files — they belong with the
        // budget skips ("read them if needed") so the finder still knows it
        // can open them. Escape/non-plain-file refusals go to the no-invitation
        // list: advertising those paths as openable is exactly backwards.
        (r.reason === "too-large" ? oversized : refusedFiles).push(f.path);
        continue;
      }
      if (r.kind === "missing") continue;
      const content = r.content;
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
    if (read.length === 0 && oversized.length === 0 && refusedFiles.length === 0) continue;
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
      section = renderAttachments(kept, [...sel.skipped, ...oversized], refusedFiles);
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
          // Finders explore the reviewed repo: children run at its root (not
          // the session cwd) so diff paths — repo-root-relative — resolve.
          { timeoutMs: config.timeoutMs, idleTimeoutMs: config.idleTimeoutMs, signal, cwd: repoRoot },
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
          { timeoutMs: config.timeoutMs, idleTimeoutMs: config.idleTimeoutMs, signal, cwd: repoRoot },
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
  const pipelineErrors = [...pipelineNotes, ...errors];
  const notesBlock = pipelineNotesBlock(pipelineErrors);
  if (config.persist) {
    try {
      // Never persist through a symlinked path — git preserves symlinks, so a
      // reviewed repo could commit `.pi -> ~/.ssh` or a symlinked
      // review-state.json itself and redirect the write outside the repo.
      if (await symlinkFree(path.join(repoRoot, ".pi"), path.join(repoRoot, STATE_PATH))) {
        await deps.writeFile(
          path.join(repoRoot, STATE_PATH),
          JSON.stringify({ findings: capped, target: label, savedAt: Math.floor(now() / 1000) } satisfies StateFile),
        );
      }
    } catch {
      // Persistence is best-effort; the review stands without it.
    }
  }
  return {
    report: report + notesBlock,
    findings: capped,
    coverage: {
      errors,
      uncoveredFiles,
      lensCoverage: Object.fromEntries([...lensCoverage.entries()].map(([c, ls]) => [c, [...ls]])),
    },
    usage,
    findingCount: capped.length,
    notes: pipelineErrors,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Construct the production ReviewDeps implementation with optional overrides for testing. */
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
    listDir: defaultListDir,
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
  if (result.findings.length > 0) lines.push(TRIAGE_GUIDANCE);
  return lines.join("\n");
}
