/**
 * Recall extension — lossless search over compacted-away session history.
 *
 * Design:
 * - One `recall` tool. Compaction summarizes old turns but pi keeps every raw
 *   entry in the session file forever; this tool makes that archive searchable
 *   again. The archive is defined precisely: `getBranch()` (leaf→root, all raw
 *   entries) minus the ids the session projection still shows (compaction- and
 *   context-edit-aware) — so archived summaries drop in the moment a later
 *   compaction folds them away, and edit-omitted entries stay searchable, all
 *   from one set-diff with zero bookkeeping.
 * - Ranking is hand-rolled BM25 over line-aligned chunks (~3k chars) with
 *   identifier-aware tokenization (`parseHeader` matches "parse header"),
 *   multiplied by a memory-horizon recency decay (score halves every
 *   `PI_RECALL_HALF_LIFE_HOURS` measured from the archive frontier, floored
 *   at `PI_RECALL_RECENCY_FLOOR`) — so the latest decision about a topic
 *   outranks older discussions of it, while rare distinctive terms from far
 *   back still surface. Lexical match is deliberate: recall returns verbatim
 *   text, the regime where models are strongest (NoLiMa), and every hit
 *   carries provenance.
 * - Hybrid: a local jina-v5-text-nano (768-dim ONNX, q8) adds a semantic
 *   ranking over the same chunks, fused into BM25 by weighted
 *   reciprocal-rank fusion
 *   (`PI_RECALL_EMBED_WEIGHT`, default 0.15 — benchmarked optimum for the
 *   binary-quantized nano) so
 *   paraphrase queries surface discussions that share no terms. Embeddings
 *   run in a disposable child process (the model parks ~1.7GB of arena that
 *   only exit reclaims) and persist in a flat append-only file per session
 *   dir, keyed by content hash — a pure derived cache: vectors are only ever
 *   missing, never wrong, and every failure (worker dead, model absent,
 *   nothing cached yet) degrades to lexical-only ranking. Catch-up embedding
 *   drains in budgeted batches from session_start/agent_settled.
 * - Scope `session` (default) indexes the in-memory branch on demand — always
 *   fresh, branch/rewind-correct, nothing persisted. Scope `project` adds
 *   sibling session files from the cwd-scoped session directory, labeled and
 *   down-ranked (`PI_RECALL_FOREIGN_WEIGHT`), never injected — retrieval is
 *   always model-initiated, so cross-session context can't leak in ambiently.
 * - Cache invariants hold by construction: a plain tool whose results ride at
 *   the tail; no context rewrites, no system-prompt churn, one promptSnippet.
 * - The extension owns the context budget and the summary: auto-compaction
 *   fires when projected context exceeds a target — min(256k tokens, 70% of
 *   the model's context window), whichever is reached first: an absolute
 *   ceiling at the top of the measured 128–256k reasoning-reliability cliff
 *   band, scaled down for smaller windows (PI_RECALL_COMPACT_TARGET caps
 *   tokens, PI_RECALL_COMPACT_RATIO scales to the window; token cap 0
 *   disables, and so does a target below what compaction can achieve) —
 *   via a turn_end boundary draft mid-run (a continuously busy agent never
 *   settles, so a settled-only trigger drifts to pi's near-limit backstop)
 *   and from agent_settled when idle, with pi's near-limit threshold as the
 *   remaining mid-run safety net — and every compaction is summarized with
 *   recall-aware instructions (terse working map, searchable anchors): via
 *   session_before_compact for pi-triggered compactions (manual /compact
 *   included), falling back to pi's default summarizer on any failure, and by
 *   the same summarizer inline for drafts, which never fire the hook and
 *   simply retry on the next turn (PI_RECALL_COMPACT_OWN=0 opts out).
 * - Idle compaction is off the critical path and rides the provider's KV
 *   cache. At agent_settled the summary is generated in the background — no
 *   isCompacting flag, so the user's next prompt starts immediately — and the
 *   result is committed via ctx.compact() the moment it is done and the
 *   session is idle again; session_before_compact serves the precomputed
 *   text when pi's preparation matches the fingerprint the background pass
 *   recorded (stale results are discarded and regenerated, never served).
 *   Idle triggers also fire EARLY, below the strict target, at
 *   PI_RECALL_COMPACT_IDLE_RATIO (default 0.8) of the target: a settled
 *   moment right after a run is when the provider's cache still holds the
 *   session prefix, so the summary's input is a cache read, and spending that
 *   cheap summary there keeps mid-run crossings of the strict target (which
 *   block a boundary) rare. The mid-run turn_end draft stays at the strict
 *   target and inline — boundary drafts must return synchronously — but it
 *   fast-paths a fresh background result instead of re-generating.
 * - Summaries reuse the session's prompt cache (PI_RECALL_SUMMARY_CACHE=0
 *   opts out): the summarization request sends the projected transcript up to
 *   the cut — system prompt, prior compaction summary, the span, exactly as
 *   the session's own requests serialized it — plus one trailing instruction
 *   message, under the session's routing id with cache retention on. The
 *   provider then prefills only the instruction instead of re-reading the
 *   whole span. The instruction is instruction-only (no embedded
 *   <conversation>), the trailing half of the measured instruction sandwich,
 *   and opens by claiming the summarizer role — the replayed history starts at
 *   the session's own system prompt, so the instruction alone must establish
 *   that this call summarizes the transcript rather than continuing it; the
 *   opt-out keeps the embedded layout whose leading half bought template
 *   adherence on models that ignore trailing instructions. Cache reuse is
 *   best-effort: any serialization divergence from the session's requests
 *   (image blocking, other extensions' context transforms) only costs the
 *   cache hit, never correctness.
 * - Mid-run drafts chain a plan message after the compaction entry (## Current
 *   Plan, from the todo tool's branch snapshot): current state belongs at the
 *   recent position — after the kept tail — not frozen inside the summary,
 *   where it would age behind newer todo calls. Drafts fire no session_compact
 *   for the todo extension's reminder to catch, so the chained message is the
 *   carrier; pi-triggered compactions stay plan-less and lean on that reminder
 *   instead (the todo extension's resume scan recognizes the chained carrier,
 *   so resumed drafts do not double-inject).
 * - Every compaction chains/sends a one-shot reminder message at commit time —
 *   appended behind the compaction (after the kept tail, before whatever the
 *   user sends next), never injected at the next run start, where it would
 *   land after the user's message and get answered instead of the user
 *   (observed live: the first idle compaction in a long session derailed the
 *   next turn into re-orienting from the summary).
 */

/**
 * Module map (pure layers below the wiring; this file owns registration, the
 * tool's search/read internals, and the compaction boundary wiring):
 * - config.ts   env knobs, parsed by small pure helpers (fail-open defaults)
 * - chunks.ts   tokenize → entry sections → line-aligned chunks; the archive definition
 * - rank.ts     BM25 + recency decay, the semantic side and RRF fusion, result formatting
 * - corpus.ts   sibling session files as a labeled, LRU-cached foreign corpus
 * - render.ts   what the user sees: tool rows, read-mode full text, the reminder
 * - summary.ts  context budget, compaction ownership, the summarization seam
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { EmbedClient } from "../../lib/embed-client";
import { VectorStore } from "../../lib/vecstore";
import { PLAN_MESSAGE_TYPE } from "../todo";
import { configFromEnv } from "./config";
import type { RecallConfig } from "./config";
import { buildArchiveChunks, parseRef, visibleEntryIds } from "./chunks";
import type { RecallChunk } from "./chunks";
import {
  archiveFrontier,
  ECHO_NEEDLE_MIN_CHARS,
  EMBED_BATCH_LIMIT,
  extractSnippet,
  formatReadResult,
  formatSearchResult,
  FUSION_DEPTH,
  fuseHybrid,
  rankChunks,
  semanticRankedKeys,
} from "./rank";
import type { EmbedSeam, SearchHit, VectorStoreLike } from "./rank";
import { fsProjectReader, ProjectCorpusCache } from "./corpus";
import type { FileCorpus, ProjectReader } from "./corpus";
import { entryFullText, reminderMessage, renderRecallCall, renderRecallResult, reuseText } from "./render";
import type { RecallDetails } from "./render";
import {
  carryForwardFileLists,
  collectFileOps,
  compactionFingerprint,
  defaultSummaryFn,
  draftPreparation,
  lastCompactionDetails,
  planSection,
  retryTransient,
  shouldAutoCompact,
  shouldIdleCompact,
  SUMMARY_RETRY_ATTEMPTS,
} from "./summary";
import type { CompactionUsage, DraftPreparation, SummaryFn, SummaryModel } from "./summary";

/** Resolved embed-worker path, module-relative (exported so a test can pin it
 * to the real file: a silently wrong path degrades every session to
 * lexical-only search with no error — tsc cannot see runtime URL resolution,
 * so the file's existence is the only guard). */
export const EMBED_WORKER_PATH = (() => {
  try {
    return fileURLToPath(new URL("../../lib/embed-worker.ts", import.meta.url));
  } catch {
    return path.resolve("lib/embed-worker.ts");
  }
})();

export * from "./config";
export * from "./chunks";
export * from "./rank";
export * from "./corpus";
export * from "./render";
export * from "./summary";

export const RECALL_TOOL_NAME = "recall";

const RecallParams = Type.Object({
  description: Type.Optional(
    Type.String({
      description:
        "Natural-language description of what you're looking for — a sentence or two describing the ideal memory. Drives semantic (paraphrase) matching; also used for exact-term matching when no queries are given",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 5,
      description:
        "Keyword search queries — the exact terms you'd grep for and expect verbatim in the history: identifiers, file paths, names, error strings. 1-5 short queries; drives exact-term (BM25) matching and replaces the description there (omit or pass [] for none)",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("search"), Type.Literal("read")], {
      description: '"search" (default) ranks archived chunks; "read" returns one full entry',
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("session"), Type.Literal("project")], {
      description:
        '"session" (default): this session\'s compacted history; "project": also past sessions in this directory (labeled, down-ranked)',
    }),
  ),
  id: Type.Optional(Type.String({ description: "Entry ref from a previous recall result (read mode)" })),
  offset: Type.Optional(Type.Number({ description: "Char offset to continue a long read (read mode, default 0)" })),
  limit: Type.Optional(Type.Number({ description: "Max results (search mode, default 5)" })),
});

export function registerRecallTool(
  pi: ExtensionAPI,
  config: RecallConfig = configFromEnv(),
  reader: ProjectReader = fsProjectReader,
  deps: {
    summarize?: SummaryFn;
    logCompactionError?: (line: string) => void;
    retryDelayMs?: number;
    /** Semantic-side seams — inject fakes in tests; defaults are the real worker client and vector store. */
    embed?: EmbedSeam;
    openStore?: (file: string) => Promise<VectorStoreLike>;
  } = {},
): void {
  let autoCompactInFlight = false;
  const corpusCache = new ProjectCorpusCache(reader, config.projectMaxBytes, config.chunkChars);
  const summarize = deps.summarize ?? defaultSummaryFn;
  // Semantic support, opened lazily at session_start and torn down at
  // session_shutdown. `vectors` is null whenever the feature is off, the
  // store failed to open, or the session ended — search treats null as
  // "lexical only" and never blocks on it.
  const embed: EmbedSeam =
    deps.embed ??
    new EmbedClient({
      // Registration must never throw — if the loader yields an exotic
      // import.meta.url, fall back to a best-effort path and let the spawn
      // fail open (one notice, lexical-only search).
      workerPath: EMBED_WORKER_PATH,
      dtype: config.embedDtype,
      modelDir: config.embedModelDir,
      onNotice: (message) => console.error(`recall: ${message}`),
    });
  const openStore = deps.openStore ?? ((file: string) => VectorStore.open(file));
  let vectorSupport: { store: VectorStoreLike; embed: EmbedSeam } | null = null;
  let catchUpInFlight = false;
  // Breadcrumb for compaction failures — ctx.compact() failures are otherwise
  // invisible (async, no UI surface). One line per failure, never throws.
  const logCompactionError =
    deps.logCompactionError ??
    ((line: string) => {
      // Promise form: diagnostics must never throw or block the extension.
      void fsp
        .appendFile(
          `${process.env.HOME ?? "~"}/.pi/agent/recall-compaction-errors.log`,
          `${new Date().toISOString()} ${line}\n`,
        )
        .catch(() => {});
    });

  /** Chunks awaiting embedding: archived current-session chunks always, plus foreign sessions newest-first within the byte budget. */
  const pendingEmbeddings = async (
    sm: ExtensionContext["sessionManager"],
    support: { store: VectorStoreLike; embed: EmbedSeam },
  ): Promise<Array<{ key: string; text: string }>> => {
    const candidates = buildArchiveChunks(
      sm.getBranch(),
      visibleEntryIds(sm.buildSessionProjection()),
      sm.getSessionId(),
      config,
    );
    if (config.embedForeignMaxBytes > 0 && config.defaultScope === "project") {
      try {
        await corpusCache.refresh(sm.getSessionDir(), sm.getSessionFile());
        // Newest files first: recent sessions are the likeliest searches. A
        // corpus that alone exceeds the remaining budget is skipped, not
        // squeezed in — one giant newest session must not starve older ones.
        const corpora = [...corpusCache.list()].sort((a, b) => b.mtimeMs - a.mtimeMs);
        let budget = config.embedForeignMaxBytes;
        for (const corpus of corpora) {
          if (corpus.bytes > budget) continue;
          candidates.push(...corpus.chunks);
          budget -= corpus.bytes;
          if (budget <= 0) break;
        }
      } catch {
        // Foreign embedding is best-effort — search still reports unreadable files.
      }
    }
    const unique: RecallChunk[] = [];
    const seen = new Set<string>();
    for (const chunk of candidates)
      if (!seen.has(chunk.key)) {
        seen.add(chunk.key);
        unique.push(chunk);
      }
    const present = support.store.has(unique.map((c) => c.key));
    return unique.filter((c) => !present.has(c.key)).map((c) => ({ key: c.key, text: c.text }));
  };

  /**
   * Background embedding catch-up, budgeted per round: one batch of at most
   * EMBED_BATCH_LIMIT chunks per trigger (session_start, agent_settled) so a
   * large backlog drains across settles instead of hogging the worker.
   * Failures are silent-but-retryable — the next trigger diffs again and
   * re-sends only what is still missing.
   */
  const catchUp = async (sm: ExtensionContext["sessionManager"]): Promise<void> => {
    const support = vectorSupport;
    // No `embed.available` gate: a dead worker is respawned lazily by the
    // request (bounded by maxStartAttempts, reset on health evidence) so one
    // transient crash doesn't disable the semantic side for the session.
    if (support === null || catchUpInFlight) return;
    catchUpInFlight = true;
    try {
      const pending = await pendingEmbeddings(sm, support);
      if (pending.length === 0) return;
      const vectors = await support.embed.embed(pending.slice(0, EMBED_BATCH_LIMIT));
      if (vectors !== undefined && vectors.length > 0) await support.store.add(vectors);
    } catch (err) {
      console.error(`recall: embedding catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      catchUpInFlight = false;
    }
  };

  /**
   * Reclaim dead vector bytes so the store tracks what search can see. Live
   * keys = the current archive plus the ENTIRE post-LRU foreign corpus —
   * not the embed-budgeted subset, or BM25-visible foreign files would lose
   * their semantic side to a cost-control budget they were never meant to
   * follow. Session scope never compacts: its corpus view excludes foreign
   * files, and dropping their vectors on a transient scope change would
   * re-embed the whole project on the way back to project scope.
   */
  const compactIfNeeded = async (sm: ExtensionContext["sessionManager"], store: VectorStoreLike): Promise<void> => {
    if (config.defaultScope !== "project") return;
    try {
      // Always refresh: unlike catch-up, compaction needs the full foreign
      // view even when the embed budget is zero.
      await corpusCache.refresh(sm.getSessionDir(), sm.getSessionFile());
      const live = new Set(
        buildArchiveChunks(sm.getBranch(), visibleEntryIds(sm.buildSessionProjection()), sm.getSessionId(), config).map(
          (c) => c.key,
        ),
      );
      for (const corpus of corpusCache.list()) for (const chunk of corpus.chunks) live.add(chunk.key);
      const reclaimed = await store.compact(live);
      if (reclaimed > 0)
        console.error(
          `recall: compacted vector cache, reclaimed ${(reclaimed / (1024 * 1024)).toFixed(1)} MB of dead vectors`,
        );
    } catch (err) {
      console.error(`recall: vector cache compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ---------------------------------------------------------------------
  // Background idle compaction
  //
  // Idle compaction must not block the user: pi's ctx.compact() sets
  // isCompacting for the whole summarizer call, which queues the user's next
  // prompt. So the expensive half — summary generation — runs detached (no
  // compaction state, nothing queued, the user's next run starts freely), and
  // only the cheap commit goes through ctx.compact(), where the
  // session_before_compact hook below serves the precomputed text with zero
  // provider calls. Freshness is a fingerprint over the preparation (cut id,
  // span shape, previous summary, model): a result generated for a different
  // span is discarded and regenerated, never served.
  // ---------------------------------------------------------------------

  /** A background summary awaiting its moment: `result` once generated. */
  interface PendingCompaction {
    controller: AbortController;
    /** Fingerprint of the span the summary covers — serving re-checks it. */
    fingerprint: string;
    result?: { text: string; usage: unknown };
  }
  let pendingCompact: PendingCompaction | null = null;

  const modelKeyId = (model: SummaryModel): string => `${model.provider}/${model.id}`;

  /** The session's routing id, when the context exposes a manager — cache affinity for the summary request. */
  // Total on purpose: a degenerate context (no manager, or one without the
  // method — observed live from child pi processes) degrades to "no routing
  // id" — the summary still fires, just without provider cache affinity —
  // instead of throwing away the whole compaction.
  const sessionRoutingId = (ctx: ExtensionContext): string | undefined =>
    (ctx as Partial<ExtensionContext>).sessionManager?.getSessionId?.();

  /** Fresh preparation from the live projection. `keepRecentTokens` defaults to pi's — resolved per-model settings are not exposed to extensions. */
  const livePreparation = (
    ctx: ExtensionContext,
    keepRecentTokens: number = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  ): DraftPreparation | undefined => {
    const projection = (ctx as Partial<ExtensionContext>).sessionManager?.buildSessionProjection?.();
    return projection ? draftPreparation(projection.entries, keepRecentTokens) : undefined;
  };

  const fingerprintOf = (preparation: DraftPreparation, model: SummaryModel): string =>
    compactionFingerprint({
      firstKeptEntryId: preparation.firstKeptEntryId,
      spanMessages: preparation.messages,
      previousSummary: preparation.previousSummary,
      modelId: modelKeyId(model),
    });

  /** Commit a finished background result: fresh → ctx.compact() (the hook serves it); stale → discard and re-arm. */
  const commitPendingCompaction = (ctx: ExtensionContext): void => {
    const pending = pendingCompact;
    if (pending?.result === undefined) return;
    const model = ctx.model;
    if (!model) {
      pendingCompact = null;
      return;
    }
    // Freshness against the live projection: anything the session did since
    // generation — appends, rewinds, edits, a model switch — invalidates the span.
    const preparation = livePreparation(ctx);
    if (!preparation || fingerprintOf(preparation, model) !== pending.fingerprint) {
      pendingCompact?.controller.abort();
      pendingCompact = null;
      const usage = ctx.getContextUsage();
      if (
        shouldIdleCompact(
          usage?.tokens ?? null,
          usage?.contextWindow ?? 0,
          config.compactTargetTokens,
          config.compactTargetRatio,
          config.compactIdleRatio,
          false,
        )
      ) {
        void startBackgroundCompaction(ctx);
      }
      return;
    }
    try {
      ctx.compact({
        onComplete: () => {
          if (pendingCompact === pending) pendingCompact = null;
        },
        onError: (err) => {
          if (pendingCompact === pending) pendingCompact = null;
          logCompactionError(`background compaction failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
    } catch (err) {
      pendingCompact = null;
      logCompactionError(`background compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Generate an idle compaction's summary off the critical path. The
   * settled moment is the warmest the provider's prompt cache ever gets —
   * the run's last request just wrote the whole prefix — so the summary
   * rides cache reads (PI_RECALL_SUMMARY_CACHE=0 pays full price instead).
   */
  const startBackgroundCompaction = async (ctx: ExtensionContext): Promise<void> => {
    // The whole body sits inside the guard: the pass is fire-and-forget from a
    // synchronous handler, so any setup throw (a stale ctx accessor after a
    // session replacement, a malformed projected entry) must become a crumb,
    // never an unhandled rejection — pi exits on those.
    let controller: AbortController | undefined;
    try {
      const sm = (ctx as Partial<ExtensionContext>).sessionManager; // captured synchronously: ctx facades go stale across session replacement
      const model = ctx.model;
      if (!model) {
        logCompactionError("background compaction skipped: no model on session context");
        return;
      }
      const preparation = livePreparation(ctx);
      if (!preparation) return; // nothing compactable; pi's near-limit backstop owns the rest
      // Registry object captured (staleness), method called bound to it —
      // ModelRegistry.complete reads `this.runtime`, so a bare method capture
      // throws on every real call (test fakes are plain arrows and hide it).
      const registry = ctx.modelRegistry;
      const complete: Parameters<typeof summarize>[0]["complete"] = (m, context, options) =>
        registry.complete(m, context, options);
      controller = new AbortController();
      const signal = controller.signal; // captured: TS cannot narrow the mutable let through the retry closure
      const pending: PendingCompaction = {
        controller,
        fingerprint: fingerprintOf(preparation, model),
      };
      pendingCompact = pending;
      const { text, usage } = await retryTransient(
        () =>
          summarize({
            model,
            complete,
            thinkingLevel: config.summaryThinking === "session" ? ctx.thinkingLevel : config.summaryThinking,
            messages: preparation.messages,
            prefixMessages:
              config.summaryReuseCache && preparation.prefixCacheable ? preparation.prefixMessages : undefined,
            sessionId: sm?.getSessionId?.(), // same tolerance as sessionRoutingId: degenerate managers degrade, never throw
            previousSummary: preparation.previousSummary,
            userFocus: undefined, // background triggers never carry /compact focus
            budgetChars: config.summaryChars,
            keptRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
            signal,
          }),
        SUMMARY_RETRY_ATTEMPTS,
        deps.retryDelayMs ?? 1000,
        signal,
      );
      if (pendingCompact !== pending) return; // superseded: a compaction committed, or the session ended/replaced
      if (!text.trim()) {
        pendingCompact = null;
        logCompactionError("background compaction skipped: summarizer returned empty text");
        return;
      }
      pending.result = { text, usage };
      // Commit when idle. A run starting inside the gap is picked up at its
      // own agent_settled (or turn_end fast-path) instead — nothing is aborted.
      if (ctx.isIdle()) commitPendingCompaction(ctx);
    } catch (err) {
      if (controller !== undefined) {
        if (pendingCompact?.controller === controller) pendingCompact = null;
        if (controller.signal.aborted) return; // teardown/supersede, not a failure
      }
      logCompactionError(`background compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    autoCompactInFlight = false;
    pendingCompact?.controller.abort();
    pendingCompact = null;
    if (!config.embedEnabled) return;
    // Capture the session manager synchronously, before the first await: a
    // session replacement (pi -p forks the latest session in the cwd) or
    // reload invalidates the ctx facade mid-flight, and every later ctx
    // access would throw staleness. The captured manager stays usable — at
    // worst it is the outgoing session's, and the replacement's own
    // session_start re-runs catch-up for the new one.
    const sm = ctx.sessionManager;
    void (async () => {
      try {
        // A session replacement (new/resume/fork) in the same process must not
        // leak the previous session's store handle or worker — shutdown
        // normally did this, belt and braces if it did not. reset, not kill:
        // the prior shutdown disposed the client terminally for that session,
        // and only reset() can resurrect it for the replacement (kill+start
        // would silently no-op on the disposed flags → lexical-only forever).
        const previous = vectorSupport;
        vectorSupport = null;
        embed.reset();
        await previous?.store.close();
        const store = await openStore(path.join(sm.getSessionDir(), "recall-vectors.bin"));
        vectorSupport = { store, embed };
        embed.start();
        await catchUp(sm);
        // After catch-up so the corpus cache is warm and fresh embeds are
        // already on disk — they are live keys, so the rewrite keeps them.
        await compactIfNeeded(sm, store);
      } catch (err) {
        vectorSupport = null;
        console.error(`recall: semantic search unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  pi.on("session_compact", (_event) => {
    autoCompactInFlight = false;
    // Any committed compaction (the background commit, manual /compact, pi's
    // backstop) retires the background pass: its span no longer exists.
    pendingCompact?.controller.abort();
    pendingCompact = null;
    // The reminder rides at the compaction commit, not the next run start.
    // Appended now it lands after the kept tail and before whatever the user
    // sends next — the position mid-run compactions always had. A
    // before_agent_start injection instead lands after the user's next
    // message (the front of context), where the model answers the reminder
    // instead of the user — observed live in a long session's first idle
    // compaction. pi.sendMessage with triggerTurn:false appends while idle
    // and defers to turn end mid-run; it never steers and never lands
    // between a tool call and its result. Fire-and-forget by design: a
    // failed append surfaces as a pi extension error, and the lost reminder
    // is bounded — the summary and kept tail still carry the session.
    pi.sendMessage(reminderMessage(), { triggerTurn: false });
  });

  // Torn down on quit, reload, and session replacement — the worker child
  // must not outlive the session that spawned it (its result would have no
  // consumer), and the store handle belongs to one session directory.
  pi.on("session_shutdown", () => {
    // dispose, not kill: an in-flight catch-up can land its request after this
    // handler runs — kill alone would let the request lazily respawn the
    // worker, whose pipes would then hold the host's event loop open forever.
    embed.dispose();
    const support = vectorSupport;
    vectorSupport = null;
    catchUpInFlight = false;
    pendingCompact?.controller.abort();
    pendingCompact = null;
    autoCompactInFlight = false;
    void support?.store.close();
  });

  // Context budget, background-first: idle moments generate the summary off
  // the critical path (the user's next prompt is never queued behind it) and
  // commit when fresh; the mid-run turn_end draft below stays inline — boundary
  // drafts must return synchronously — but at the strict target, and it
  // fast-paths a fresh background result. Idle triggers also fire early, at
  // PI_RECALL_COMPACT_IDLE_RATIO of the target, to spend the cheap
  // cache-warm summary before a mid-run crossing can block a boundary.
  // PI_RECALL_COMPACT_TARGET=0 disables. Also drains the embedding backlog —
  // settled moments are exactly when background CPU is free.
  pi.on("agent_settled", (_event, ctx) => {
    // ctx access is synchronous here; async work holds only captured pieces.
    void catchUp(ctx.sessionManager);
    const usage = ctx.getContextUsage();
    if (!config.ownSummaries) {
      // Not owning summaries: no background pass (the hook would discard it) —
      // trigger pi's compaction directly and let pi's summarizer run.
      if (
        !shouldAutoCompact(
          usage?.tokens ?? null,
          usage?.contextWindow ?? 0,
          config.compactTargetTokens,
          config.compactTargetRatio,
          autoCompactInFlight,
        )
      ) {
        return;
      }
      autoCompactInFlight = true;
      ctx.compact({
        onComplete: () => (autoCompactInFlight = false),
        onError: (err) => {
          autoCompactInFlight = false;
          logCompactionError(`budget trigger failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      return;
    }
    if (pendingCompact !== null) {
      // One background pass at a time: commit a landed result, wait out an
      // in-flight generation — never stack a second on top.
      if (pendingCompact.result !== undefined) commitPendingCompaction(ctx);
      return;
    }
    if (
      !shouldIdleCompact(
        usage?.tokens ?? null,
        usage?.contextWindow ?? 0,
        config.compactTargetTokens,
        config.compactTargetRatio,
        config.compactIdleRatio,
        autoCompactInFlight,
      )
    ) {
      return;
    }
    void startBackgroundCompaction(ctx);
  });

  // Mid-run budget compaction. A continuously busy agent never settles — one
  // long run can climb from the target to pi's near-limit backstop (~94% of
  // the window) with the trigger above dormant — but turn_end fires after
  // every assistant response. Its boundary-result seam is pi's sanctioned
  // mid-run compaction: proposed entries commit before the next request, no
  // continuation is forced (entries only — pi's own decision stands), and
  // nothing is aborted. The summary is generated here because drafts carry
  // extension content (session_before_compact does not fire for them); a
  // failure costs one turn's wait, then the next turn_end tries again.
  pi.on("turn_end", async (event, ctx) => {
    // Draft content is ours alone — no pi-default fallback exists for drafts.
    if (!config.ownSummaries) return;
    // Aborted/error turns defer to pi's recovery — and a user cancel must not
    // pay for a summary.
    if (event.outcome !== "completed") return;
    // A naturally-ending turn settles immediately; the idle trigger above owns
    // compaction there.
    if (!event.context.canContinue) return;
    // Boundary entries are last-writer-wins across handlers — if another
    // extension already proposed a compaction this boundary, defer to it.
    if (event.entries.some((entry) => entry.type === "compaction")) return;
    const usage = ctx.getContextUsage();
    if (
      !shouldAutoCompact(
        usage?.tokens ?? null,
        usage?.contextWindow ?? 0,
        config.compactTargetTokens,
        config.compactTargetRatio,
        autoCompactInFlight,
      )
    ) {
      return;
    }
    // ExtensionContext does not expose resolved per-model compaction settings,
    // so drafts always keep pi's default recent tail (20k tokens).
    const keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
    const preparation = draftPreparation(event.context.contextEntries, keepRecentTokens);
    if (!preparation) return;
    const model = ctx.model;
    if (!model) {
      logCompactionError("mid-run compaction skipped: no model on session context");
      return;
    }
    // The plan rides as a message chained after the compaction entry — the
    // recent position, after the kept tail, not frozen inside the summary:
    // drafts fire no session_compact, so the todo extension's post-compaction
    // reminder never runs for them.
    const plan = planSection(ctx.sessionManager.getBranch());
    const draftEntries = (text: string, summaryUsage: unknown): SessionBoundaryDraft[] => [
      ...event.entries,
      {
        type: "compaction",
        summary: text,
        firstKeptEntryId: preparation.firstKeptEntryId,
        details: carryForwardFileLists(
          lastCompactionDetails(ctx.sessionManager.getBranch()),
          collectFileOps(preparation.messages),
        ),
        usage: summaryUsage as CompactionUsage,
      },
      // The plan at the recent position — after the kept tail, where only
      // later todo calls (never older ones) supersede it.
      ...(plan === ""
        ? []
        : ([
            { type: "custom_message", customType: PLAN_MESSAGE_TYPE, content: plan, display: false },
          ] as SessionBoundaryDraft[])),
      // The reminder rides the same chain: boundary commits fire no
      // session_compact, so the immediate-send path there never runs —
      // chained here it keeps its position behind the compaction without
      // waiting for the next run start.
      { type: "custom_message", ...reminderMessage() } as SessionBoundaryDraft,
    ];
    // A background result for exactly this span commits for free. An in-flight
    // generation defers (the idle commit owns it); a landed-but-stale one is
    // dropped so the inline path regenerates — stale spans are never served.
    const pending = pendingCompact;
    if (pending !== null) {
      if (pending.result === undefined) return;
      const fresh = fingerprintOf(preparation, model) === pending.fingerprint;
      pendingCompact = null;
      if (fresh) {
        return { entries: draftEntries(pending.result.text, pending.result.usage) };
      }
    }
    const signal = ctx.signal ?? new AbortController().signal;
    try {
      const { text, usage: summaryUsage } = await retryTransient(
        () =>
          summarize({
            model,
            complete: (m, context, options) => ctx.modelRegistry.complete(m, context, options),
            thinkingLevel: config.summaryThinking === "session" ? ctx.thinkingLevel : config.summaryThinking,
            // Chronological, mirroring the session_before_compact path; the auto
            // trigger never sets a user focus. The cached layout rides the
            // session's prompt-cache prefix when the knob allows.
            messages: preparation.messages,
            prefixMessages:
              config.summaryReuseCache && preparation.prefixCacheable ? preparation.prefixMessages : undefined,
            sessionId: sessionRoutingId(ctx),
            previousSummary: preparation.previousSummary,
            userFocus: undefined,
            budgetChars: config.summaryChars,
            keptRecentTokens: keepRecentTokens,
            signal,
          }),
        SUMMARY_RETRY_ATTEMPTS,
        deps.retryDelayMs ?? 1000,
        signal,
      );
      if (!text.trim()) {
        logCompactionError("mid-run compaction skipped: summarizer returned empty text");
        return;
      }
      // Entries-only (no forced continuation — pi's own decision stands), and
      // merge with earlier handlers' proposals: boundary entries are
      // last-writer-wins, so returning a fresh array would clobber them.
      return { entries: draftEntries(text, summaryUsage) };
    } catch (err) {
      // An aborted signal is a user cancel, not a failure — stay silent.
      if (signal.aborted) return;
      logCompactionError(`mid-run compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  });

  // pi-side compaction failures (any trigger, including the default summarizer
  // fallback path) — aborted=true is a user cancel, not a failure.
  pi.on("session_compact_failed", (event) => {
    if (event.aborted) return;
    logCompactionError(`compaction failed (${event.reason}): ${event.errorMessage ?? "unknown error"}`);
  });

  // Own the summary end to end: every compaction (ours, manual /compact,
  // pi's backstop) is generated here with the extension's own prompt — pi's
  // built-in summarizer prompt is never involved, so pi-side prompt changes
  // cannot reshape our summaries. Failure ladder mirrors pi's own confidence:
  // transient provider failures retry in place (the same 3-attempt budget pi
  // gives its own summarizer); deterministic failures fall back to pi's
  // default — custom compaction must never block compaction.
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.ownSummaries) return;
    const model = ctx.model;
    if (!model) {
      logCompactionError("summary ownership fell back to pi default: no model on session context");
      return;
    }
    const p = event.preparation;
    // A background result for exactly this preparation commits with zero
    // provider calls — but never for a manual /compact with custom
    // instructions: the user's focus was not in the precomputed prompt.
    const pending = pendingCompact;
    if (pending?.result !== undefined && !event.customInstructions?.trim()) {
      const fingerprint = compactionFingerprint({
        firstKeptEntryId: p.firstKeptEntryId,
        spanMessages: [...p.messagesToSummarize, ...p.turnPrefixMessages],
        previousSummary: p.previousSummary,
        modelId: modelKeyId(model),
      });
      if (fingerprint === pending.fingerprint) {
        const served = pending.result;
        pendingCompact = null;
        return {
          compaction: {
            summary: served.text,
            firstKeptEntryId: p.firstKeptEntryId,
            tokensBefore: p.tokensBefore,
            usage: served.usage as CompactionUsage,
            details: carryForwardFileLists(lastCompactionDetails(event.branchEntries), p.fileOps),
          },
        };
      }
      // Fingerprint mismatch: the span the background pass summarized is not
      // the one pi is compacting now (entries landed in the gap, or the
      // session's resolved compaction settings differ from the default tail
      // the background pass derived). The result is discarded — never served —
      // and this compaction regenerates. The crumb surfaces a persistent
      // settings divergence, which otherwise silently pays a wasted background
      // pass on every idle trigger.
      logCompactionError(
        "background summary discarded: the span changed since generation (resolved compaction settings may differ from pi's default tail)",
      );
    }
    // Cached layout: re-derive the request prefix from the live projection and
    // use it only when the projection agrees with pi's preparation (same cut
    // id). Knob off, no manager on the context, or a cut divergence (resolved
    // per-model settings differ from pi's default) falls back to the legacy
    // one-off prompt.
    let prefixMessages: Parameters<typeof convertToLlm>[0] | undefined;
    if (config.summaryReuseCache) {
      // pi's resolved tail here, so the derived cut matches whenever the
      // session uses pi's own settings. A split-turn prefix (dangling toolCall)
      // is not replayable and declines to the legacy prompt.
      const live = livePreparation(ctx, p.settings.keepRecentTokens);
      if (live && live.firstKeptEntryId === p.firstKeptEntryId && live.prefixCacheable)
        prefixMessages = live.prefixMessages;
    }
    // Plan-less by design: current state belongs at the recent position, and
    // pi-triggered compactions fire session_compact — the todo extension's
    // reminder re-injects the plan at the next run start.
    try {
      const { text, usage } = await retryTransient(
        () =>
          summarize({
            model,
            complete: (m, context, options) => ctx.modelRegistry.complete(m, context, options),
            // Default "off": no thinking is requested (the provider applies its
            // own default) — the instruction-sandwich prompt holds template
            // adherence at zero reasoning tokens across the fleet, and nothing
            // can starve the output cap from the reasoning side.
            // PI_RECALL_SUMMARY_THINKING pins another level or mirrors the
            // session's (often low) interactive level with "session" — measured
            // on glm-5.3, "low" effort followed the template ~1/3 runs on a long
            // input while "high" adhered.
            thinkingLevel: config.summaryThinking === "session" ? ctx.thinkingLevel : config.summaryThinking,
            // Chronological: older spans first, split-turn prefix last, so the
            // newest state the prompt re-derives sits at the end of the transcript.
            messages: [...p.messagesToSummarize, ...p.turnPrefixMessages],
            prefixMessages,
            sessionId: prefixMessages === undefined ? undefined : sessionRoutingId(ctx),
            previousSummary: p.previousSummary,
            userFocus: event.customInstructions?.trim() || undefined,
            // Tight target: recall makes the summary a map, not the archive.
            budgetChars: config.summaryChars,
            keptRecentTokens: p.settings.keepRecentTokens,
            signal: event.signal,
          }),
        SUMMARY_RETRY_ATTEMPTS,
        deps.retryDelayMs ?? 1000,
        event.signal,
      );
      if (!text.trim()) {
        logCompactionError("summary ownership fell back to pi default: summarizer returned empty text");
        return;
      }
      return {
        compaction: {
          summary: text,
          firstKeptEntryId: p.firstKeptEntryId,
          tokensBefore: p.tokensBefore,
          usage: usage as CompactionUsage,
          details: carryForwardFileLists(lastCompactionDetails(event.branchEntries), p.fileOps),
        },
      };
    } catch (err) {
      // An aborted signal is a user cancel, not a failure — stay silent.
      if (event.signal.aborted) return;
      logCompactionError(
        `summary ownership fell back to pi default: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  });

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: "Recall",
    description:
      "Search conversation history that is no longer in your context (compacted away). Compaction folds dropped turns into a summary — the newest messages stay in context, and the verbatim transcript remains on disk where this tool retrieves it. Use it when you need earlier details you cannot see: decisions, prior failed attempts, file paths, command outputs, error strings. mode 'search' (default) ranks archived chunks and returns verbatim excerpts with provenance: give a `description` of what you're looking for in natural language (drives semantic matching — paraphrases and summaries of the idea find their targets) plus optional `queries` — short keyword searches of the exact terms you expect verbatim in the history, like identifiers, file paths, and error strings (drives exact-term matching). What makes a good description makes a poor keyword query and vice versa — describe the idea, grep for the tokens. mode 'read' takes an id from a prior result and returns the full entry. scope 'session' (default) searches this session's compacted history; scope 'project' also searches past sessions in this directory (labeled and down-ranked). Prefer recall over re-deriving or guessing at earlier state.",
    promptSnippet:
      "recall — search compacted-away session history verbatim (description = what you're looking for, natural language; queries = exact terms like identifiers/paths/errors; scope 'project' adds past sessions)",
    parameters: RecallParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const mode = params.mode ?? "search";
      if (mode === "read") {
        const details = await readEntry(params, ctx, corpusCache, config);
        return { content: [{ type: "text", text: details.text }], details: details.details };
      }
      return search(params, ctx, corpusCache, config, vectorSupport);
    },
    renderCall(args, theme, context) {
      const text = reuseText(context);
      text.setText(
        renderRecallCall(
          (args ?? {}) as { description?: unknown; queries?: unknown; mode?: unknown; id?: unknown },
          theme,
        ),
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = reuseText(context);
      text.setText(
        renderRecallResult(result.details as RecallDetails | undefined, { expanded: options.expanded }, theme),
      );
      return text;
    },
  });
}

// ---------------------------------------------------------------------------
// Tool internals (kept out of the registration closure for testability)
// ---------------------------------------------------------------------------

function errorResult(
  text: string,
  details: RecallDetails,
): { content: Array<{ type: "text"; text: string }>; details: RecallDetails } {
  return { content: [{ type: "text", text: `Error: ${text}` }], details };
}

async function search(
  params: { description?: string; queries?: string[]; scope?: "session" | "project"; limit?: number },
  ctx: ExtensionContext,
  corpusCache: ProjectCorpusCache,
  config: RecallConfig,
  vectors: { store: VectorStoreLike; embed: EmbedSeam } | null,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: RecallDetails }> {
  const description = params.description?.trim() ?? "";
  // Keyword queries replace the description for exact-term matching — prose
  // dilutes BM25 (low-IDF filler everywhere), and terse identifiers starve the
  // embedding model (trained on natural queries). Each side gets its diet.
  const lexical = (params.queries ?? [])
    .map((q) => q.trim())
    .filter((q) => q !== "")
    .join(" ");
  const lexicalQuery = lexical !== "" ? lexical : description;
  const semanticQuery = description !== "" ? description : lexicalQuery;
  const scope = params.scope ?? config.defaultScope;
  const limit = Math.floor(
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.min(25, Math.max(1, params.limit))
      : config.maxResults,
  );
  const details: RecallDetails = { mode: "search", scope };
  if (lexicalQuery === "") {
    return errorResult(
      "description (or queries) is required in search mode (use mode 'read' with an id to fetch a full entry)",
      details,
    );
  }

  const sm = ctx.sessionManager;
  const archiveChunks = buildArchiveChunks(
    sm.getBranch(),
    visibleEntryIds(sm.buildSessionProjection()),
    sm.getSessionId(),
    config,
  );
  if (archiveChunks.length === 0 && scope === "session") {
    const text =
      "Nothing has been compacted yet — your full history is still in context, no archive to search. (Scope 'project' searches past sessions.)";
    return { content: [{ type: "text", text }], details };
  }

  let foreignSessions = 0;
  let skippedFiles = 0;
  let allChunks = archiveChunks;
  if (scope === "project") {
    const dir = sm.getSessionDir();
    let corpora: FileCorpus[] = [];
    try {
      skippedFiles = await corpusCache.refresh(dir, sm.getSessionFile());
      corpora = corpusCache.list();
    } catch (err) {
      return errorResult(`project scope unavailable: ${err instanceof Error ? err.message : String(err)}`, details);
    }
    foreignSessions = corpora.length;
    allChunks = [...archiveChunks, ...corpora.flatMap((c) => c.chunks)];
  }

  // The search's own words are its own best match: any chunk quoting the
  // description verbatim — this tool call echoed in the transcript, from this
  // session or a foreign one — is the question served back as its top answer.
  // The searcher already knows what they asked. Echoes drop before ranking
  // (BM25 and semantic sides share allChunks). Keyword-only searches keep
  // their echo risk by design: their short terms are the targets themselves.
  const echoNeedle = normalizeWsCi(description);
  if (echoNeedle.length >= ECHO_NEEDLE_MIN_CHARS) {
    allChunks = allChunks.filter((c) => !normalizeWsCi(decodeJsonEscapes(c.text)).includes(echoNeedle));
  }

  let rankedAll = rankChunks(allChunks, lexicalQuery, config.foreignWeight, config.halfLifeHours, config.recencyFloor);
  // Semantic side: embed the query, scan the cached vectors over this
  // corpus's keys, and fuse by rank. Every step fails open — worker down
  // (lazily respawned by the request itself, bounded), query timeout, or
  // nothing cached yet leaves rankedAll exactly as BM25 produced it.
  if (vectors !== null && config.embedWeight > 0) {
    const queryVector = await vectors.embed.query(semanticQuery);
    if (queryVector !== undefined) {
      const chunksByKey = new Map(allChunks.map((c) => [c.key, c]));
      const frontier = archiveFrontier(allChunks);
      const hits = vectors.store.topK(queryVector, chunksByKey.keys(), FUSION_DEPTH);
      const semanticKeys = semanticRankedKeys(hits, chunksByKey, config, frontier);
      rankedAll = fuseHybrid(rankedAll, semanticKeys, chunksByKey, config, frontier);
    }
  }
  const ranked = rankedAll.slice(0, limit);
  const hits: SearchHit[] = ranked.map((r) => ({
    ref: r.chunk.ref,
    kind: r.chunk.kind,
    label: r.chunk.label,
    sessionLabel: r.chunk.sessionLabel,
    timestamp: r.chunk.timestamp,
    score: r.score,
    recencyFactor: r.recencyFactor,
    match: r.sides,
    snippet: extractSnippet(r.chunk.text, lexicalQuery, config.snippetChars),
  }));
  const archiveEntries = new Set(allChunks.map((c) => c.ref)).size;
  const text = formatSearchResult(hits, {
    archiveEntries,
    foreignSessions,
    scope,
    skippedFiles,
    totalMatches: rankedAll.length,
  });
  return {
    content: [{ type: "text", text }],
    details: {
      ...details,
      hits: hits.map((h) => ({
        ref: h.ref,
        kind: h.kind,
        session: h.sessionLabel,
        score: h.score,
        snippet: h.snippet,
      })),
    },
  };
}

/** Collapse whitespace and case — the space both sides of an echo comparison
 * live in. Punctuation differences (a retyped quote) stay unmatched by design. */
function normalizeWsCi(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Decode the escapes a transcript adds when it serializes a tool call
 * (\" \\ \n) so an echoed description compares equal to the needle. Applied to
 * chunk text only: pi hands the tool real characters, and decoding the needle
 * too would corrupt descriptions that legitimately contain backslashes. */
function decodeJsonEscapes(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => (ch === "n" || ch === "r" || ch === "t" ? " " : ch));
}

/** Resolve the project cache through the injected reader (test seam). */
async function readEntry(
  params: { id?: string; offset?: number },
  ctx: ExtensionContext,
  corpusCache: ProjectCorpusCache,
  config: RecallConfig,
): Promise<{ text: string; details: RecallDetails }> {
  const details: RecallDetails = { mode: "read", scope: "session" };
  const ref = params.id?.trim() ?? "";
  if (ref === "") return { text: "Error: id is required in read mode (take it from a search result)", details };
  const parsed = parseRef(ref);
  if (parsed === undefined)
    return { text: `Error: "${ref}" is not a valid ref — use the id value from a recall search result`, details };
  const offset = Math.floor(
    typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0 ? params.offset : 0,
  );

  const sm = ctx.sessionManager;
  if (parsed.sessionIdShort === undefined) {
    const entry = sm.getEntry(parsed.entryId);
    if (entry === undefined) {
      return {
        text: `Error: entry ${ref} not found on the current branch (refs are branch-local; search again after rewinds)`,
        details,
      };
    }
    const text = entryFullText(entry);
    return {
      text: formatReadResult(
        ref,
        `Entry ${ref} — current session · ${entry.timestamp}`,
        text,
        offset,
        config.readChars,
      ),
      details: { ...details, read: { ref, total: text.length } },
    };
  }

  // Foreign ref: refresh cache (cheap once warm) then read the exact line.
  const located = await locateForeignEntry(corpusCache, sm, parsed);
  if (typeof located === "string") return { text: `Error: ${located}`, details };
  const { entry, corpus } = located;
  const text = entryFullText(entry);
  return {
    text: formatReadResult(
      ref,
      `Entry ${parsed.entryId} — past session ${corpus.label} · ${entry.timestamp}`,
      text,
      offset,
      config.readChars,
    ),
    details: { ...details, scope: "project", read: { ref, total: text.length } },
  };
}

/**
 * Resolve a foreign ref to its parsed entry: refresh the project cache, locate
 * the cached line, re-read it through the injected reader, and verify the id
 * still matches (a rewritten file shifts line numbers silently). Every failure
 * returns a model-facing message instead of throwing.
 */
async function locateForeignEntry(
  corpusCache: ProjectCorpusCache,
  sm: ExtensionContext["sessionManager"],
  parsed: { entryId: string; sessionIdShort?: string },
): Promise<{ entry: SessionEntry; corpus: FileCorpus } | string> {
  try {
    await corpusCache.refresh(sm.getSessionDir(), sm.getSessionFile());
  } catch (err) {
    return `project scope unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const located = corpusCache.locate(parsed.sessionIdShort ?? "", parsed.entryId);
  if (located === undefined) {
    return `entry ${parsed.entryId}.${parsed.sessionIdShort} not found in past sessions (refs are stable per session file; search again to refresh)`;
  }
  let entryLine: string | undefined;
  try {
    entryLine = await corpusCache.readEntryLine(located.corpus, located.line);
  } catch (err) {
    return `session file unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (entryLine === undefined) return "session file changed since indexing — search again to refresh refs";
  try {
    const entry = JSON.parse(entryLine) as SessionEntry;
    if (entry.id !== parsed.entryId) return "session file changed since indexing — search again to refresh refs";
    return { entry, corpus: located.corpus };
  } catch {
    return `session file line ${located.line} is unreadable`;
  }
}

export default registerRecallTool;
