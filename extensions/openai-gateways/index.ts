/**
 * Generic OpenAI-compatible gateway registration.
 *
 * pi's native models.json covers static endpoints, but a gateway like llamswap
 * serves a model list that changes with whatever is currently loaded — the
 * custom-provider docs prescribe exactly this shape: registerProvider with
 * refreshModels doing live GET /v1/models discovery.
 *
 * Gateways are configured in ~/.pi/agent/openai-gateways.json (same
 * name->settings shape as pi's models.json providers object), not env vars or
 * source constants, so repointing never touches this file. Invalid entries are
 * skipped with a logged warning; an unparseable file fails loudly at load.
 *
 * Extension-registered providers are invisible to headless pi runs without
 * extensions — subagent children spawn `pi -p --no-extensions` and cannot
 * resolve a gateway model at all (an explicit --model fails with "not found",
 * and an unpinned child silently falls back to an arbitrary paid provider).
 * The extension therefore mirrors each gateway into pi's native
 * ~/.pi/agent/models.json: provider entry (baseUrl/api/apiKey) plus a model
 * list seeded from config, refreshed by a bounded catch-up fetch at load and
 * rewritten whenever refreshModels resolves a catalog. Everything else in
 * models.json is preserved verbatim (formatting is normalized to 2-space JSON
 * on first write); an unreadable file is never clobbered. Gateway names own
 * their models.json entries — a same-named hand-written entry is taken over
 * with a load-time warning. A gateway removed from the config leaves its
 * last mirror entry behind — a static alias to the same baseUrl, inert unless
 * explicitly selected. Accepted trade-off: the load-time fetch can hold a
 * short-lived process open up to its 15s timeout against a hanging (not
 * refusing) gateway.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "openai-gateways.json");
const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
const DEFAULT_API_KEY = "local"; // dummy key; local gateways ignore it (same convention as models.json + ollama)
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 65536;
const REFRESH_TIMEOUT_MS = 15_000;

/** Model entry as persisted in pi's model store. */
export interface StoredModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

/** Chat-model member of pi's ProviderModelConfig union (the chat variant isn't exported at the package root). */
export type ChatModel = Extract<ProviderModelConfig, { type?: "chat" }>;

/** A validated gateway from the config file. */
export interface Gateway {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Hand-written seed catalog: last-resort fallback when the gateway is down and nothing is persisted. */
  seedModels: StoredModel[];
  contextWindow: number;
  maxTokens: number;
}

export function toModels(
  data: { id?: unknown; name?: unknown }[],
  defaults: { contextWindow: number; maxTokens: number },
): ChatModel[] {
  return data
    .filter((m) => typeof m.id === "string" && (m.id as string).length > 0)
    .map((m) => ({
      type: "chat",
      id: m.id as string,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : (m.id as string),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: defaults.contextWindow,
      maxTokens: defaults.maxTokens,
    }));
}

/** Rehydrate a persisted catalog, applying gateway defaults for missing fields. Unusable entries are dropped. */
export function storedToModels(
  stored: readonly StoredModel[] | undefined,
  defaults: { contextWindow: number; maxTokens: number },
): ChatModel[] {
  return (stored ?? [])
    .filter((m) => typeof m?.id === "string" && m.id.length > 0)
    .map((m) => ({
      type: "chat",
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? defaults.contextWindow,
      maxTokens: m.maxTokens ?? defaults.maxTokens,
    }));
}

/** Coerce a config-file token count: positive finite integers only, everything else falls back to the default. */
function parseTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/** Parse a hand-written seed model entry; null for entries without a usable id. */
function parseSeedModel(value: unknown): StoredModel | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) return null;
  const input = Array.isArray(m.input)
    ? (m.input.filter((v) => v === "text" || v === "image") as ("text" | "image")[])
    : undefined;
  return {
    id: m.id,
    name: typeof m.name === "string" && m.name.length > 0 ? m.name : undefined,
    reasoning: m.reasoning === true ? true : undefined,
    input: input && input.length > 0 ? input : undefined,
    contextWindow: parseTokenCount(m.contextWindow),
    maxTokens: parseTokenCount(m.maxTokens),
  };
}

/**
 * Validate a parsed config file into gateways. Entries without a usable name
 * and baseUrl are skipped (with the reason collected) so one typo can't take
 * down every gateway; this never throws.
 */
export function parseGateways(config: unknown): { gateways: Gateway[]; skipped: string[] } {
  const gateways: Gateway[] = [];
  const skipped: string[] = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { gateways, skipped: ["config is not an object"] };
  }
  for (const [name, raw] of Object.entries(config as Record<string, unknown>)) {
    if (name.length === 0) {
      skipped.push("entry with empty name");
      continue;
    }
    if (typeof raw !== "object" || raw === null) {
      skipped.push(`${name}: settings are not an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.baseUrl !== "string" || !/^https?:\/\//.test(entry.baseUrl)) {
      skipped.push(`${name}: missing or non-http baseUrl`);
      continue;
    }
    const seeds = Array.isArray(entry.models)
      ? entry.models.map(parseSeedModel).filter((m): m is StoredModel => m !== null)
      : [];
    gateways.push({
      name,
      baseUrl: entry.baseUrl.replace(/\/+$/, ""),
      apiKey: typeof entry.apiKey === "string" && entry.apiKey.length > 0 ? entry.apiKey : DEFAULT_API_KEY,
      seedModels: seeds,
      contextWindow: parseTokenCount(entry.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: parseTokenCount(entry.maxTokens) ?? DEFAULT_MAX_TOKENS,
    });
  }
  return { gateways, skipped };
}

/**
 * Read and validate the config file. Missing file = no gateways (fail open —
 * an unconfigured machine just registers nothing); unparseable JSON throws
 * with the path so a corrupted config is loud, not silently empty.
 */
export function loadGateways(readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): {
  gateways: Gateway[];
  skipped: string[];
} {
  let text: string;
  try {
    text = readFile(CONFIG_PATH);
  } catch (error) {
    // Only a missing file is the benign "unconfigured machine" case; anything
    // else (EACCES, EISDIR, ...) is a real problem and must be loud.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { gateways: [], skipped: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`openai-gateways: ${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  return parseGateways(parsed);
}

/** Fetch and validate a gateway's model catalog from `GET <baseUrl>/models`. */
export async function fetchProviderModels(
  baseUrl: string,
  signal: AbortSignal,
  defaults: { contextWindow: number; maxTokens: number },
): Promise<ChatModel[]> {
  const res = await fetch(`${baseUrl}/models`, { signal });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  const models = toModels(Array.isArray(body.data) ? (body.data as { id?: unknown; name?: unknown }[]) : [], defaults);
  if (models.length === 0) throw new Error("/models returned no models");
  return models;
}

// ---------------------------------------------------------------------------
// models.json mirror
// ---------------------------------------------------------------------------

/** Provider entry the mirror manages in models.json for one gateway. */
export function mirrorProviderEntry(gateway: Gateway, models: readonly StoredModel[]): Record<string, unknown> {
  return {
    baseUrl: gateway.baseUrl,
    api: "openai-completions",
    apiKey: gateway.apiKey,
    models: models.map((m) => ({
      id: m.id,
      ...(m.name !== undefined ? { name: m.name } : {}),
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.input !== undefined ? { input: [...m.input] } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    })),
  };
}

/**
 * Merge managed gateway entries into parsed models.json content, preserving
 * every other key (other providers, modelOverrides, unknown future fields).
 * Returns the merged root, or null when nothing would change (skip the write)
 * or the existing shape is not a modifiable object (never clobber — the caller
 * warns). `current === undefined` models a missing file.
 */
export function mergeMirrorIntoModelsJson(
  current: unknown,
  gateways: readonly Gateway[],
  catalogs: ReadonlyMap<string, readonly StoredModel[]>,
): Record<string, unknown> | null {
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    return null;
  }
  const root = { ...(current as Record<string, unknown>) };
  if (
    root.providers !== undefined &&
    (typeof root.providers !== "object" || root.providers === null || Array.isArray(root.providers))
  ) {
    return null;
  }
  const providers = { ...(root.providers as Record<string, unknown> | undefined) };
  let changed = false;
  for (const gateway of gateways) {
    // A missing catalog is "no opinion yet", not "empty": fetchProviderModels
    // throws on empty catalogs, so a known catalog is never empty — writing []
    // here would clobber a previous session's good mirror whenever the seeds
    // are absent (and pin it empty for the whole session when the gateway is
    // down). Skip instead; the load-time fetch or refreshModels will fill it.
    if (!catalogs.has(gateway.name)) continue;
    const entry = mirrorProviderEntry(gateway, catalogs.get(gateway.name) ?? []);
    if (JSON.stringify(providers[gateway.name]) !== JSON.stringify(entry)) {
      providers[gateway.name] = entry;
      changed = true;
    }
  }
  return changed ? { ...root, providers } : null;
}

/** Injected filesystem seams for the mirror; production defaults read and write the real models.json atomically. */
export interface MirrorDeps {
  /** Read current models.json content; defaults to the real file. */
  readModelsJson?: (path: string) => string;
  /** Persist merged content; the default writes tmp+rename so a crash never leaves a torn file. */
  writeModelsJson?: (path: string, text: string) => void;
  /** Override for tests. */
  modelsJsonPath?: string;
}

/**
 * Write managed gateway entries into models.json so headless pi runs — subagent
 * children run --no-extensions and cannot see extension-registered providers —
 * can resolve gateway models. Fail-soft on every step: a missing file is the
 * common first-run case (create), anything unreadable/unparseable warns and
 * skips so user-authored content is never clobbered, and an unchanged merge
 * skips the write entirely. With warnOnTakeover (the load flush), replacing a
 * pre-existing differing entry for a managed name is announced — gateway
 * config owns its models.json entry, and a same-named hand-written entry is
 * being taken over.
 */
export function writeModelsJsonMirror(
  gateways: readonly Gateway[],
  catalogs: ReadonlyMap<string, readonly StoredModel[]>,
  deps: MirrorDeps = {},
  options: { warnOnTakeover?: boolean } = {},
): boolean {
  if (gateways.length === 0) return false;
  const path = deps.modelsJsonPath ?? MODELS_JSON_PATH;
  const read = deps.readModelsJson ?? ((p: string) => readFileSync(p, "utf8"));
  const write =
    deps.writeModelsJson ??
    ((p: string, text: string) => {
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, p);
    });
  let current: unknown;
  try {
    current = JSON.parse(read(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`openai-gateways: not mirroring into ${path} — unreadable (${(error as Error).message})`);
      return false;
    }
    current = undefined; // first run: file does not exist yet
  }
  const merged = mergeMirrorIntoModelsJson(current, gateways, catalogs);
  if (merged === null) return false;
  if (options.warnOnTakeover) {
    const prior = (current as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
    for (const gateway of gateways) {
      if (catalogs.has(gateway.name) && prior[gateway.name] !== undefined) {
        const before = JSON.stringify(prior[gateway.name]);
        const after = JSON.stringify((merged.providers as Record<string, unknown>)[gateway.name]);
        if (before !== after) {
          console.error(
            `openai-gateways: gateway config owns models.json providers.${gateway.name} — replacing the existing differing entry`,
          );
        }
      }
    }
  }
  try {
    write(path, JSON.stringify(merged, null, 2) + "\n");
    return true;
  } catch (error) {
    console.error(`openai-gateways: mirror write to ${path} failed (${(error as Error).message})`);
    return false;
  }
}

/** Full extension seams: config read plus the mirror filesystem and fetch. */
export interface GatewayDeps extends MirrorDeps {
  /** Read the gateway config; defaults to the real openai-gateways.json. */
  readFile?: (path: string) => string;
  /** Catalog fetch; defaults to the real GET <baseUrl>/models. */
  fetchModels?: typeof fetchProviderModels;
}

export default function (pi: ExtensionAPI, deps: GatewayDeps = {}) {
  const { gateways, skipped } = loadGateways(deps.readFile);
  for (const reason of skipped) {
    console.error(`openai-gateways: skipping config entry — ${reason}`);
  }
  const defaults = (g: Gateway) => ({ contextWindow: g.contextWindow, maxTokens: g.maxTokens });
  // Mirror state: the freshest known catalog per gateway, flushed to models.json
  // on every update. Concurrent updates each rewrite the whole managed set, so
  // the last write wins with the newest catalogs — a local cache, not a ledger.
  const catalogs = new Map<string, readonly StoredModel[]>();
  const flushMirror = (warnOnTakeover: boolean) => writeModelsJsonMirror(gateways, catalogs, deps, { warnOnTakeover });
  const mirrorCatalog = (gateway: Gateway, models: readonly StoredModel[]) => {
    catalogs.set(gateway.name, models);
    flushMirror(false);
  };
  for (const gateway of gateways) {
    if (gateway.seedModels.length > 0) catalogs.set(gateway.name, gateway.seedModels);
  }
  // Load flush announces takeovers of same-named existing entries; catalog
  // updates never do (they only ever rewrite our own entry).
  flushMirror(true);
  const fetchModels = deps.fetchModels ?? fetchProviderModels;
  // Bounded catch-up fetch at load: pi does not persist extension-provider
  // catalogs and may never call refreshModels this session, so the mirror
  // would sit at seeds (possibly none) — one fail-soft fetch per gateway keeps
  // it fresh without blocking load.
  for (const gateway of gateways) {
    void fetchModels(gateway.baseUrl, AbortSignal.timeout(REFRESH_TIMEOUT_MS), defaults(gateway))
      .then((models) => mirrorCatalog(gateway, models))
      .catch(() => {});
  }
  for (const gateway of gateways) {
    pi.registerProvider(gateway.name, {
      name: gateway.name,
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      api: "openai-completions",
      refreshModels: async (context) => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
        try {
          const fresh = await fetchModels(gateway.baseUrl, signal, defaults(gateway));
          mirrorCatalog(gateway, fresh);
          return fresh;
        } catch (error) {
          // Gateway blip: fall back to the last persisted catalog, then the
          // hand-written seed list. Only throw if we have nothing at all.
          const stored = storedToModels(context.stored?.models, defaults(gateway));
          if (stored.length > 0) {
            mirrorCatalog(gateway, stored);
            return stored;
          }
          const seeds = storedToModels(gateway.seedModels, defaults(gateway));
          if (seeds.length > 0) {
            mirrorCatalog(gateway, seeds);
            return seeds;
          }
          throw new Error(
            `${gateway.name}: model refresh failed (${(error as Error).message}) and no cached or seeded catalog available`,
          );
        }
      },
    });
  }
}
