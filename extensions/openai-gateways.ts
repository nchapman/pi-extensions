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
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "openai-gateways.json");
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

/** Rehydrate a persisted catalog, applying gateway defaults for missing fields. */
export function storedToModels(
  stored: readonly StoredModel[] | undefined,
  defaults: { contextWindow: number; maxTokens: number },
): ChatModel[] {
  return (stored ?? []).map((m) => ({
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
  if (typeof config !== "object" || config === null) {
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
  } catch {
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
  const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
  const models = toModels(body.data ?? [], defaults);
  if (models.length === 0) throw new Error("/models returned no models");
  return models;
}

export default function (pi: ExtensionAPI, readFile?: (path: string) => string) {
  const { gateways, skipped } = loadGateways(readFile);
  for (const reason of skipped) {
    console.error(`openai-gateways: skipping config entry — ${reason}`);
  }
  const defaults = (g: Gateway) => ({ contextWindow: g.contextWindow, maxTokens: g.maxTokens });
  for (const gateway of gateways) {
    pi.registerProvider(gateway.name, {
      name: gateway.name,
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      api: "openai-completions",
      refreshModels: async (context) => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
        try {
          return await fetchProviderModels(gateway.baseUrl, signal, defaults(gateway));
        } catch (error) {
          // Gateway blip: fall back to the last persisted catalog, then the
          // hand-written seed list. Only throw if we have nothing at all.
          const stored = storedToModels(context.stored?.models, defaults(gateway));
          if (stored.length > 0) return stored;
          const seeds = storedToModels(gateway.seedModels, defaults(gateway));
          if (seeds.length > 0) return seeds;
          throw new Error(
            `${gateway.name}: model refresh failed (${(error as Error).message}) and no cached or seeded catalog available`,
          );
        }
      },
    });
  }
}
