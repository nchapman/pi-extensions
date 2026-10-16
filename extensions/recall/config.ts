/** Recall configuration: every PI_RECALL_* knob, parsed by small pure helpers
 * with safe defaults — invalid values fall back (range-clamped) and warn,
 * never throw. Kept separate from the wiring so tests cover parsing directly. */

// ---------------------------------------------------------------------------
// Config (env with safe defaults; invalid values fall back and warn)
// ---------------------------------------------------------------------------

export interface RecallConfig {
  defaultScope: "session" | "project";
  foreignWeight: number;
  /** Memory horizon: age (from the archive frontier) at which a chunk's score has halved. */
  halfLifeHours: number;
  /** Minimum recency factor so old content fades but never vanishes (1 disables decay). */
  recencyFloor: number;
  /** Auto-compact when projected context exceeds this many tokens (0 disables) — min of this cap and the window ratio, for every model alike. 80k is the measured cost optimum from issue #3. */
  compactTargetTokens: number;
  /** Also bound the target to this fraction of the model's context window — the smaller of token cap and ratio wins (0 disables the ratio). */
  compactTargetRatio: number;
  /** Idle moments compact early when tokens exceed this fraction of the effective target (1 disables; the mid-run trigger stays at the strict target). */
  compactIdleRatio: number;
  /** Generate compaction summaries ourselves with recall-aware instructions (PI_RECALL_COMPACT_OWN=0 to opt out). */
  ownSummaries: boolean;
  /** Reuse the session's provider KV cache for summaries: send the projected transcript prefix + a trailing instruction under the session's routing id, instead of a one-off embedded prompt (PI_RECALL_SUMMARY_CACHE=0 opts out). */
  summaryReuseCache: boolean;
  /** Hard character budget for generated summaries (PI_RECALL_SUMMARY_CHARS). */
  summaryChars: number;
  /** Thinking for the summarization call: "session" mirrors the session level; or a fixed ThinkingLevel / "off" (PI_RECALL_SUMMARY_THINKING). Governs the one-off legacy layout only — the cached layout always mirrors the session's level (a diverging level re-renders the replayed history on template-aware providers, e.g. zai clear_thinking, and busts the prompt-cache prefix it exists to ride). Defaults to "off": no thinking is requested so the provider applies its own default (glm-5.3 disables outright, deepseek keeps a light default), and the instruction-sandwich layout carries template adherence at literally 0 reasoning tokens — measured across the fleet — so the whole output cap stays available for summary text and no reasoning run can starve it. */
  summaryThinking: "session" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  chunkChars: number;
  snippetChars: number;
  maxResults: number;
  readChars: number;
  projectMaxBytes: number;
  /** Semantic side of hybrid search: local jina-v5-text-nano embeddings, fused into lexical ranking by RRF. */
  embedEnabled: boolean;
  embedDtype: EmbedDtype;
  /** RRF weight of the semantic ranking (lexical is 1.0). 0 keeps ranking purely lexical. */
  embedWeight: number;
  /** Byte budget for embedding foreign-session text per catch-up (0 = current session only). */
  embedForeignMaxBytes: number;
  /** Where the ONNX model caches (must survive npm installs — never inside node_modules). */
  embedModelDir: string;
  /** Dump the rendered provider payloads of cached-layout summary calls and the last live request for first-divergence diffing (PI_RECALL_DEBUG_PREFIX=1; files land under <sessionDir>/recall-debug/). Debug-only: keeps one live payload in memory while armed. */
  debugPrefix: boolean;
}

export const DEFAULTS: RecallConfig = {
  defaultScope: "session",
  foreignWeight: 0.5,
  halfLifeHours: 4,
  recencyFloor: 0.25,
  compactTargetTokens: 80_000,
  compactTargetRatio: 0.7,
  compactIdleRatio: 0.875,
  ownSummaries: true,
  summaryReuseCache: true,
  summaryChars: 5_000,
  summaryThinking: "off",
  chunkChars: 3000,
  snippetChars: 400,
  maxResults: 5,
  readChars: 4000,
  projectMaxBytes: 64 * 1024 * 1024,
  embedEnabled: true,
  embedDtype: "q8",
  embedWeight: 0.15,
  embedForeignMaxBytes: 32 * 1024 * 1024,
  embedModelDir: `${process.env.HOME ?? "~"}/.pi/agent/models`,
  debugPrefix: false,
};

/** Minimum for PI_RECALL_SUMMARY_CHARS. */
const MIN_SUMMARY_CHARS = 500;

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  console.error(`recall: ${name}=${raw} is not a boolean — using ${fallback}`);
  return fallback;
}

function numFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.error(`recall: ${name}=${raw} is not a number — using ${fallback}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, v));
}

function summaryThinkingFromEnv(env: NodeJS.ProcessEnv): RecallConfig["summaryThinking"] {
  const raw = env.PI_RECALL_SUMMARY_THINKING?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULTS.summaryThinking;
  const valid = new Set(["session", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!valid.has(raw)) {
    console.error(
      `recall: PI_RECALL_SUMMARY_THINKING=${raw} is invalid (session|off|minimal|low|medium|high|xhigh|max) — using off`,
    );
    return DEFAULTS.summaryThinking;
  }
  return raw as RecallConfig["summaryThinking"];
}

export type EmbedDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const EMBED_DTYPES = new Set<EmbedDtype>(["fp32", "fp16", "q8", "q4", "q4f16"]);

function dtypeFromEnv(env: NodeJS.ProcessEnv): EmbedDtype {
  const raw = env.PI_RECALL_EMBED_DTYPE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULTS.embedDtype;
  if (EMBED_DTYPES.has(raw as EmbedDtype)) return raw as EmbedDtype;
  console.error(
    `recall: PI_RECALL_EMBED_DTYPE=${raw} is invalid (fp32|fp16|q8|q4|q4f16) — using ${DEFAULTS.embedDtype}`,
  );
  return DEFAULTS.embedDtype;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RecallConfig {
  const scope = env.PI_RECALL_SCOPE?.trim().toLowerCase();
  if (scope !== undefined && scope !== "" && scope !== "session" && scope !== "project") {
    console.error(`recall: PI_RECALL_SCOPE=${scope} is invalid (session|project) — using session`);
  }
  return {
    defaultScope: scope === "project" ? "project" : DEFAULTS.defaultScope,
    foreignWeight: numFromEnv(env, "PI_RECALL_FOREIGN_WEIGHT", DEFAULTS.foreignWeight, 0, 1),
    halfLifeHours: numFromEnv(env, "PI_RECALL_HALF_LIFE_HOURS", DEFAULTS.halfLifeHours, 0.1, 1_000_000),
    recencyFloor: numFromEnv(env, "PI_RECALL_RECENCY_FLOOR", DEFAULTS.recencyFloor, 0, 1),
    compactTargetTokens: Math.floor(
      numFromEnv(env, "PI_RECALL_COMPACT_TARGET", DEFAULTS.compactTargetTokens, 0, 10_000_000),
    ),
    compactTargetRatio: numFromEnv(env, "PI_RECALL_COMPACT_RATIO", DEFAULTS.compactTargetRatio, 0, 1),
    compactIdleRatio: numFromEnv(env, "PI_RECALL_COMPACT_IDLE_RATIO", DEFAULTS.compactIdleRatio, 0.25, 1),
    ownSummaries: boolFromEnv(env, "PI_RECALL_COMPACT_OWN", DEFAULTS.ownSummaries),
    summaryReuseCache: boolFromEnv(env, "PI_RECALL_SUMMARY_CACHE", DEFAULTS.summaryReuseCache),
    summaryChars: Math.floor(
      numFromEnv(env, "PI_RECALL_SUMMARY_CHARS", DEFAULTS.summaryChars, MIN_SUMMARY_CHARS, 20_000),
    ),
    summaryThinking: summaryThinkingFromEnv(env),
    chunkChars: Math.floor(numFromEnv(env, "PI_RECALL_CHUNK_CHARS", DEFAULTS.chunkChars, 500, 100_000)),
    snippetChars: Math.floor(numFromEnv(env, "PI_RECALL_SNIPPET_CHARS", DEFAULTS.snippetChars, 100, 10_000)),
    maxResults: Math.floor(numFromEnv(env, "PI_RECALL_MAX_RESULTS", DEFAULTS.maxResults, 1, 25)),
    readChars: Math.floor(numFromEnv(env, "PI_RECALL_READ_CHARS", DEFAULTS.readChars, 500, 100_000)),
    projectMaxBytes: Math.floor(numFromEnv(env, "PI_RECALL_PROJECT_MAX_MB", 64, 4, 4096) * 1024 * 1024),
    embedEnabled: boolFromEnv(env, "PI_RECALL_EMBED", DEFAULTS.embedEnabled),
    embedDtype: dtypeFromEnv(env),
    embedWeight: numFromEnv(env, "PI_RECALL_EMBED_WEIGHT", DEFAULTS.embedWeight, 0, 2),
    embedForeignMaxBytes: Math.floor(numFromEnv(env, "PI_RECALL_EMBED_MAX_MB", 32, 0, 4096) * 1024 * 1024),
    embedModelDir: env.PI_RECALL_MODEL_DIR?.trim() || DEFAULTS.embedModelDir,
    debugPrefix: boolFromEnv(env, "PI_RECALL_DEBUG_PREFIX", DEFAULTS.debugPrefix),
  };
}
