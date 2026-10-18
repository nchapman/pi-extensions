/** Review configuration and invocation parsing: PI_REVIEW_* knobs with
 * fail-open defaults, /review target parsing (including the review-directory
 * argument), and repo guideline collection (REVIEW.md plus the closest
 * AGENTS.md "Review guidelines" section). Pure helpers throughout — paths
 * expand ~ and resolve against the session cwd; existence is checked by the
 * caller. */

import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default finder model. Thinking-off is load-bearing: deepseek at :off
 * measured 100% recall (31/31 on code-review-bench) at ~1/4 the wall time of
 * default thinking (>6 min per finder child — the production hard cap is
 * 20m, so thinking-on means reviews measured in many minutes). pi's
 * `provider/id:thinking` suffix means PI_REVIEW_MODEL and --model still
 * override model and level together. muse-spark-1.3 was tried as a
 * successor — 67.7% recall at :off, ~61% ceiling with default thinking, at
 * 2× tokens and 4× wall — a finder-capability gap, not a thinking-budget one,
 * so deepseek stays (see README for the numbers). Re-run npm run eval:review
 * whenever this changes. */
export const DEFAULT_REVIEW_MODEL = "opencode-go/deepseek-v4.1-flash:off";

export interface ReviewConfig {
  /** Characters of diff per finder chunk (file-boundary aligned). */
  chunkChars: number;
  /** Cap on total finder children per review. */
  maxChildren: number;
  /** Finder children in flight at once — the wave width. Default matches
   * maxChildren so two-chunk reviews run as one wave. */
  concurrency: number;
  /** Per-child timeout. */
  timeoutMs: number;
  /** Kill a child that has waited on its LLM this long without an event —
   * a dead request otherwise hangs until `timeoutMs` (the backstop, not the
   * detector). Tool executions are exempt (see RunChildOptions.idleTimeoutMs).
   * 0 disables the watchdog. */
  idleTimeoutMs: number;
  /** Char budget for attaching changed files' current contents to finder
   * tasks — collapses the re-read round trips that dominate child wall time
   * (0 disables; always bounded by task headroom so the diff never truncates). */
  attachChars: number;
  /** Model override for all stages. */
  model?: string;
  /** Model override for the verify stage only (wins over `model`). */
  verifyModel?: string;
  /** Read-only command whose output feeds verification ("" disables). */
  checkCmd: string;
  /** Verification stage on/off (on by default; PI_REVIEW_VERIFY=0 opts out). */
  verify: boolean;
  /** Maximum findings in the final report. */
  maxFindings: number;
  /** Char budget for prior-findings context (0 disables). */
  priorChars: number;
  /** Whether to persist the findings snapshot for re-reviews. */
  persist: boolean;
  /** Byte cap for untracked file content synthesized into the diff. */
  untrackedMaxBytes: number;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  // Blank strings mean "unset" (sibling parse* helpers agree), not 0.
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Parse PI_REVIEW_* knobs; invalid values fall back to documented defaults. */
export function parseReviewConfig(env: NodeJS.ProcessEnv): ReviewConfig {
  // 5m of silence while waiting on the LLM means the request died, not that
  // it is slow — kill and retry instead of waiting 20m. Any numeric zero
  // disables (the sibling-knob convention); blank keeps the default.
  const idleRaw = env.PI_REVIEW_IDLE_TIMEOUT_MS?.trim();
  const idleTimeoutMs = !idleRaw
    ? 5 * 60_000
    : Number(idleRaw) === 0
      ? 0
      : clampInt(env.PI_REVIEW_IDLE_TIMEOUT_MS, 5 * 60_000, 10_000, 6 * 60 * 60_000);
  return {
    chunkChars: clampInt(env.PI_REVIEW_CHUNK_CHARS, 96_000, 8_000, 512_000),
    attachChars: clampInt(env.PI_REVIEW_ATTACH_CHARS, 64_000, 0, 262_144),
    maxChildren: clampInt(env.PI_REVIEW_MAX_CHILDREN, 8, 1, 32),
    concurrency: clampInt(env.PI_REVIEW_CONCURRENCY, 8, 1, 16),
    timeoutMs: clampInt(env.PI_REVIEW_TIMEOUT_MS, 20 * 60_000, 10_000, 6 * 60 * 60_000),
    idleTimeoutMs,
    model: env.PI_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL,
    verifyModel: env.PI_REVIEW_VERIFY_MODEL?.trim() || undefined,
    checkCmd: env.PI_REVIEW_CHECK_CMD?.trim() ?? "",
    // Verification on by default: the mechanism-only verifier (rejections
    // require refuting the claim itself; scope doubt downgrades) measured
    // zero verifier kills with noise cut 3.1→1.0 findings/PR at +70% wall/
    // +39% tokens in the paired code-review-bench A/B — worth the tail on
    // every review. Opt out with PI_REVIEW_VERIFY=0 (false/off also honored).
    verify: !["0", "false", "off"].includes(
      String(env.PI_REVIEW_VERIFY ?? "1")
        .trim()
        .toLowerCase(),
    ),
    maxFindings: clampInt(env.PI_REVIEW_MAX_FINDINGS, 25, 1, 100),
    priorChars: clampInt(env.PI_REVIEW_PRIOR_CHARS, 8_000, 0, 32_000),
    persist: String(env.PI_REVIEW_STATE ?? "1") !== "0",
    untrackedMaxBytes: clampInt(env.PI_REVIEW_UNTRACKED_MAX_BYTES, 256 * 1024, 0, 4 * 1024 * 1024),
  };
}

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

export type TargetSpec =
  | { kind: "default" } // ahead of upstream (or all local work when no upstream) + uncommitted + untracked
  | { kind: "uncommitted" } // staged + unstaged + untracked only
  | { kind: "staged" } // staged only
  | { kind: "ref"; ref: string } // merge-base of ref and HEAD .. working tree
  | { kind: "range"; base: string; head: string };

export interface ParsedArgs {
  target: TargetSpec;
  /** Directory of the repo to review (--cwd <dir> or a path-shaped token).
   * Unresolved — the caller expands ~ and resolves against its own cwd. */
  cwd?: string;
  /** Child model overrides for this invocation (--model / --verify-model). */
  model?: string;
  verifyModel?: string;
  /** A flag was given without a value — the caller must fail loudly. */
  error?: string;
}

const UNCOMMITTED_WORDS = new Set(["tree", "local", "uncommitted", "working"]);

/** Effective models for one invocation: command-line flag over env
 * knob; when both are unset the model stays undefined and children inherit
 * (session model, else pi's global default). Pure so tests can pin precedence. */
export function resolveInvocation(
  parsed: ParsedArgs,
  config: Pick<ReviewConfig, "model" | "verifyModel">,
): { model?: string; verifyModel?: string } {
  return {
    model: parsed.model ?? config.model,
    verifyModel: parsed.verifyModel ?? config.verifyModel,
  };
}

/** A token that names a directory, not a git ref: absolute, `~`/`~/…`, or
 * explicitly relative (./ ../ . ..). Bare names stay refs — a branch like
 * feature/x must not be mistaken for a path, and a missing ref fails loudly
 * in git, which is the right error for `/review nonexistent-ref`. `~user`
 * forms are excluded deliberately: the resolver only expands the current
 * user's home, so recognizing them would produce confusing paths like
 * `<cwd>/~root` instead of a loud git error. */
const isPathToken = (token: string) =>
  ["~", ".", ".."].includes(token) || /^(~\/|\.\.?\/)/.test(token) || path.isAbsolute(token);

/**
 * Parse `/review [target] [--cwd <dir>] [--model <m>] [--verify-model <m>]`
 * tokens: a first bare word picks the target — `tree`/`local`/`uncommitted`/
 * `working` mean uncommitted; `staged`/`cached` mean staged; a `a..b`/`a...b`
 * range; anything else is a ref (git validates it later and fails loudly).
 * A path-shaped token (`~/Code/foo`, `../bar`, `/abs`) or `--cwd <dir>` names
 * the directory to review instead of the session cwd; `--model=<m>`/`--model
 * <m>` and `--verify-model` override child models (flag form because refs and
 * model names both contain slashes — `origin/main` is a ref, `anthropic/
 * claude-...` a model).
 */
export function parseReviewArgs(args: string): ParsedArgs {
  const tokens = args.split(/\s+/).filter(Boolean);
  let target: TargetSpec | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let verifyModel: string | undefined;
  let error: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const flag = /^(--cwd|--model|--verify-model)(?:=(.*))?$/.exec(token);
    if (flag) {
      const value = flag[2] ?? tokens[++i];
      if (!value || value.startsWith("--")) {
        const usage =
          flag[1] === "--cwd" ? "a directory path (e.g. --cwd ~/Code/foo)" : "a model name (e.g. --model glm-5.3)";
        error = `${flag[1]} requires ${usage}`;
        break;
      }
      if (flag[1] === "--cwd") cwd ??= value;
      else if (flag[1] === "--model") model = value;
      else verifyModel = value;
      continue;
    }
    if (isPathToken(token)) {
      cwd ??= token;
      continue;
    }
    if (UNCOMMITTED_WORDS.has(token)) {
      target ??= { kind: "uncommitted" };
      continue;
    }
    if (token === "staged" || token === "cached") {
      target ??= { kind: "staged" };
      continue;
    }
    const range = /^(\S+?)\.{2,3}(\S+)$/.exec(token);
    if (range) {
      target ??= { kind: "range", base: range[1], head: range[2] };
      continue;
    }
    target ??= { kind: "ref", ref: token };
  }
  return { target: target ?? { kind: "default" }, cwd, model, verifyModel, ...(error ? { error } : {}) };
}

/** Resolve a review-directory argument to an absolute path: `~`/`~/...`
 * expands to the home directory, everything else resolves against the
 * session cwd (absolute paths pass through unchanged). Pure — whether the
 * directory exists is the caller's fail-fast check, not the parser's. */
export function resolveReviewCwd(sessionCwd: string, requested?: string): string {
  const raw = requested?.trim();
  if (!raw) return sessionCwd;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  return path.resolve(sessionCwd, raw);
}

/** Opt-in for running PI_REVIEW_CHECK_CMD inside a reviewed directory that
 * is not the session cwd. The command is repo-owned (e.g. `npm run check`),
 * so running it in a foreign checkout means executing that repo's scripts —
 * off by default; `PI_REVIEW_CHECK_FOREIGN=1|true|on` allows it. Pure. */
export const foreignCheckAllowed = (env: NodeJS.ProcessEnv): boolean =>
  ["1", "true", "on"].includes(
    String(env.PI_REVIEW_CHECK_FOREIGN ?? "")
      .trim()
      .toLowerCase(),
  );

// ---------------------------------------------------------------------------
// Repo guidelines: REVIEW.md + AGENTS.md "Review guidelines" (closest wins)
// ---------------------------------------------------------------------------

/** Extract the "Review guidelines" section from an AGENTS.md body. */
export function extractReviewGuidelines(agentsMd: string): string {
  const lines = agentsMd.split("\n");
  const start = lines.findIndex((l) => /^#{1,3}\s*(review guidelines|review instructions)\s*$/i.test(l));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // A heading at or above the section's level ends it.
    if (/^#{1,3}\s+\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

export interface GuidelinesDeps {
  /** Read a file; undefined when missing or unreadable. */
  readFile: (p: string) => Promise<string | undefined>;
}

/** Outcome of a guarded repo-file read. "missing" defers to the injected
 * reader's story (nothing there); "refused" means a guard stopped the read,
 * with the reason — callers disclose refused files instead of silently
 * behaving as if they were absent (e.g. an oversized nearer AGENTS.md must
 * not quietly defer to an ancestor's rules), and the reason picks the
 * wording: a too-large file is still readable by the finder, while a symlink
 * escape must not be advertised as openable at all. */
export type RepoFileRead =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "refused"; reason: "outside-repo" | "not-plain-file" | "too-large" | "guard-error" };

/** Bounded, symlink-refusing read of a repo-controlled file, anchored to the
 * repo: the path is realpath'd and refused unless it still lands inside the
 * anchor — git preserves symlinks, so a committed `.pi -> elsewhere` (or a
 * symlinked directory component) must not redirect the read to private files.
 * Also refuse anything that is not a plain file (/dev/zero is endless) or
 * above maxBytes (a huge committed REVIEW.md stalls the review before caps
 * can trim it). Only a plain miss (ENOENT/ENOTDIR) defers to the reader — it
 * owns the missing-file story, and tests inject readers for paths not on
 * disk. Any other stat failure (EACCES, ELOOP, fd exhaustion) is refused:
 * reading past a failed guard is exactly what this function exists to
 * prevent. */
export async function readRepoFile(
  anchor: string,
  p: string,
  maxBytes: number,
  read: (p: string) => Promise<string | undefined>,
): Promise<RepoFileRead> {
  try {
    const [realP, realAnchor] = await Promise.all([realpath(p), realpath(anchor)]);
    if (realP !== realAnchor && !realP.startsWith(realAnchor + path.sep))
      return { kind: "refused", reason: "outside-repo" };
    const st = await lstat(realP);
    if (!st.isFile()) return { kind: "refused", reason: "not-plain-file" };
    if (st.size > maxBytes) return { kind: "refused", reason: "too-large" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "refused", reason: "guard-error" }; // guard failed: refuse
  }
  const content = await read(p);
  return content === undefined ? { kind: "missing" } : { kind: "ok", content };
}

/** Cap on collected repo guidelines: they ride in every finder/verifier task,
 * and the repo under review controls their length — without a cap a hostile
 * (or merely accidental) huge REVIEW.md crowds out the diff it is supposed
 * to review. Generous: real guidelines are a few hundred words. */
export const GUIDELINES_MAX_CHARS = 16_000;

/** Byte bound for the on-disk read — UTF-8 can spend up to 4 bytes per
 * character, so comparing st.size against the character cap would silently
 * drop any non-ASCII REVIEW.md/AGENTS.md at exactly the budget edge. */
const GUIDELINES_MAX_BYTES = GUIDELINES_MAX_CHARS * 4;

/**
 * Collect repo review instructions: REVIEW.md from the repo root (whole file),
 * plus the closest AGENTS.md "Review guidelines" section for each changed
 * file — a deeper AGENTS.md overrides a shallower one for files under it, and
 * identical sections are deduplicated (most repos repeat root rules).
 */
export async function collectGuidelines(
  repoRoot: string,
  changedFiles: string[],
  deps: GuidelinesDeps,
): Promise<string> {
  const sections: string[] = [];
  // Reads are bounded and symlink-refusing: a reviewed repo controls these
  // files, and git preserves symlinks — an unbounded or followed read lets a
  // hostile REVIEW.md stall the review or pull private files into prompts.
  // Guard-refused files are named in the output: a refused nearer AGENTS.md
  // must visibly fall through to an ancestor, not silently substitute it.
  const refused: string[] = [];
  const reviewMd = await readRepoFile(repoRoot, path.join(repoRoot, "REVIEW.md"), GUIDELINES_MAX_BYTES, deps.readFile);
  if (reviewMd.kind === "refused") refused.push("REVIEW.md");
  if (reviewMd.kind === "ok" && reviewMd.content.trim()) sections.push(`# REVIEW.md\n${reviewMd.content.trim()}`);
  const byText = new Map<string, string>(); // section text -> originating path (first wins)
  for (const file of changedFiles) {
    // Walk from the file's directory up to the root; the first AGENTS.md with
    // a review section wins for this file.
    let dir = path.posix.dirname(file);
    for (;;) {
      const agentPath = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`;
      const body = await readRepoFile(repoRoot, path.join(repoRoot, agentPath), GUIDELINES_MAX_BYTES, deps.readFile);
      if (body.kind === "refused") refused.push(agentPath);
      const section = body.kind === "ok" ? extractReviewGuidelines(body.content) : "";
      if (section) {
        if (!byText.has(section)) byText.set(section, agentPath);
        break;
      }
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const [section, agentPath] of byText) {
    sections.push(`# Review guidelines (${agentPath})\n${section}`);
  }
  // Truncate only the guideline sections; the refusal notice rides outside
  // the budget — a near-cap REVIEW.md must not truncate away the very
  // disclosure that says a nearer AGENTS.md was refused. Deduped: one refused
  // file is reachable from every changed file under it. The name list itself
  // is capped (paths are repo-controlled) so the notice cannot balloon past
  // the cap it sits outside of.
  const joined = sections.join("\n\n");
  const base =
    joined.length <= GUIDELINES_MAX_CHARS
      ? joined
      : `${joined.slice(0, GUIDELINES_MAX_CHARS)}\n\n(guidelines truncated at ${GUIDELINES_MAX_CHARS} characters)`;
  const unique = [...new Set(refused)];
  const shown = unique.slice(0, 10);
  const full =
    shown.length === unique.length ? shown.join(", ") : `${shown.join(", ")}, and ${unique.length - shown.length} more`;
  // Names are repo-controlled paths; slice the rendered list too so the
  // whole notice stays a small fixed margin beyond the cap.
  const names = full.length > 400 ? `${full.slice(0, 400)}…` : full;
  if (unique.length === 0) return base;
  return `${base}\n\n(guideline file(s) skipped — oversized, not a plain file, or a symlink escape: ${names})`;
}
