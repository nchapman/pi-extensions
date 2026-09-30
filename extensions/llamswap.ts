import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDERS: Record<string, string> = {
  yeti: "http://yeti:8080/v1",
  spark: "http://spark:8080/v1",
};

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

export function toModels(data: { id?: unknown; name?: unknown }[]): ChatModel[] {
  return data
    .filter((m) => typeof m.id === "string" && (m.id as string).length > 0)
    .map((m) => ({
      type: "chat",
      id: m.id as string,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : (m.id as string),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }));
}

/** Rehydrate a persisted catalog, applying gateway defaults for missing fields. */
export function storedToModels(stored: readonly StoredModel[] | undefined): ChatModel[] {
  return (stored ?? []).map((m) => ({
    type: "chat",
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
  }));
}

/** Fetch and validate a gateway's model catalog from `GET <baseUrl>/models`. */
export async function fetchProviderModels(baseUrl: string, signal: AbortSignal): Promise<ChatModel[]> {
  const res = await fetch(`${baseUrl}/models`, { signal });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
  const models = toModels(body.data ?? []);
  if (models.length === 0) throw new Error("/models returned no models");
  return models;
}

export default function (pi: ExtensionAPI) {
  for (const [name, baseUrl] of Object.entries(PROVIDERS)) {
    pi.registerProvider(name, {
      name,
      baseUrl,
      apiKey: "local",
      api: "openai-completions",
      refreshModels: async (context) => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
        try {
          return await fetchProviderModels(baseUrl, signal);
        } catch (error) {
          // Gateway blip: fall back to the last persisted catalog so the
          // provider keeps working. Only throw if we have nothing at all.
          const stored = storedToModels(context.stored?.models);
          if (stored.length > 0) return stored;
          throw new Error(
            `${name}: model refresh failed (${(error as Error).message}) and no cached catalog available`,
          );
        }
      },
    });
  }
}
