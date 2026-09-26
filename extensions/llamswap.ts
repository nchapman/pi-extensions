import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDERS: Record<string, string> = {
  yeti: "http://yeti:8080/v1",
  spark: "http://spark:8080/v1",
};

const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 65536;

function toModels(data: { id?: unknown; name?: unknown }[]): ProviderModelConfig[] {
  return data
    .filter((m) => typeof m.id === "string" && (m.id as string).length > 0)
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : (m.id as string),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }));
}

export default function (pi: ExtensionAPI) {
  for (const [name, baseUrl] of Object.entries(PROVIDERS)) {
    pi.registerProvider(name, {
      name,
      baseUrl,
      apiKey: "local",
      api: "openai-completions",
      refreshModels: async (context) => {
        const res = await fetch(`${baseUrl}/models`, { signal: context.signal });
        if (!res.ok) throw new Error(`${name}: GET /models returned ${res.status}`);
        const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
        const models = toModels(body.data ?? []);
        if (models.length === 0) throw new Error(`${name}: /models returned no models`);
        return models;
      },
    });
  }
}
