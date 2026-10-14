/** Review configuration and invocation parsing: PI_REVIEW_* knobs with
 * fail-open defaults, /review target parsing, and repo guideline collection
 * (REVIEW.md plus the closest AGENTS.md "Review guidelines" section). */

import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default finder model — the benchmarked configuration: 100% recall
 * (31/31, all severities) on code-review-bench at ~1/4 the wall time of the
 * same model with default thinking (which needs >6 minutes per finder child
 * on the benchmark diff — the production hard cap is 20m, so default
 * thinking means reviews measured in many minutes). Thinking-off is the
 * load-bearing part: pi's `provider/id:thinking` suffix means PI_REVIEW_MODEL
 * and --model still override model and level together. */
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

/**
 * Parse `/review [target] [--model <m>] [--verify-model <m>]` tokens,

 * working; a `a..b`/`a...b` range; `--model=<m>`/`--model <m>` and
 * `--verify-model` overrides (flag form because refs and model names both
 * contain slashes — `origin/main` is a ref, `anthropic/claude-...` a model);
 * anything else is a ref (git validates it later and fails loudly).
 */
export function parseReviewArgs(args: string): ParsedArgs {
  const tokens = args.split(/\s+/).filter(Boolean);
  let target: TargetSpec | undefined;
  let model: string | undefined;
  let verifyModel: string | undefined;
  let error: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const flag = /^(--model|--verify-model)(?:=(.*))?$/.exec(token);
    if (flag) {
      const value = flag[2] ?? tokens[++i];
      if (!value || value.startsWith("--")) {
        error = `${flag[1]} requires a model name (e.g. ${flag[1]} glm-5.3)`;
        break;
      }
      if (flag[1] === "--model") model = value;
      else verifyModel = value;
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
  return { target: target ?? { kind: "default" }, model, verifyModel, ...(error ? { error } : {}) };
}

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
  const reviewMd = await deps.readFile(path.join(repoRoot, "REVIEW.md"));
  if (reviewMd?.trim()) sections.push(`# REVIEW.md\n${reviewMd.trim()}`);
  const byText = new Map<string, string>(); // section text -> originating path (first wins)
  for (const file of changedFiles) {
    // Walk from the file's directory up to the root; the first AGENTS.md with
    // a review section wins for this file.
    let dir = path.posix.dirname(file);
    for (;;) {
      const agentPath = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`;
      const body = await deps.readFile(path.join(repoRoot, agentPath));
      const section = body ? extractReviewGuidelines(body) : "";
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
  return sections.join("\n\n");
}
