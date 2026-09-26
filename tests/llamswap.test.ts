import { afterEach, describe, expect, it, vi } from "vitest";
import { default as registerLlamswap, fetchProviderModels, storedToModels, toModels } from "../extensions/llamswap";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("toModels", () => {
  it("keeps entries with a non-empty string id", () => {
    const models = toModels([{ id: "llama", name: "Llama" }, { id: "" }, { id: 42 }, {}]);
    expect(models.map((m) => m.id)).toEqual(["llama"]);
  });

  it("falls back to id when name is missing or empty", () => {
    const models = toModels([{ id: "a", name: "" }, { id: "b" }]);
    expect(models.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("applies gateway defaults", () => {
    const [model] = toModels([{ id: "a" }]);
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(65536);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("storedToModels", () => {
  it("returns an empty list for no stored catalog", () => {
    expect(storedToModels(undefined)).toEqual([]);
  });

  it("applies defaults for missing optional fields", () => {
    expect(storedToModels([{ id: "llama" }])).toEqual([
      {
        id: "llama",
        name: "llama",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    ]);
  });

  it("preserves persisted overrides", () => {
    const [model] = storedToModels([
      { id: "qwen", name: "Qwen", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 8192 },
    ]);
    expect(model).toMatchObject({ id: "qwen", name: "Qwen", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 8192 });
  });
});

describe("fetchProviderModels", () => {
  it("returns models from a 200 response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "a", name: "A" }, { id: "b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchProviderModels("http://yeti:8080/v1", new AbortController().signal);

    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith("http://yeti:8080/v1/models", expect.anything());
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "down" }, 503)));
    await expect(fetchProviderModels("http://yeti:8080/v1", new AbortController().signal)).rejects.toThrow("503");
  });

  it("throws when the catalog is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));
    await expect(fetchProviderModels("http://yeti:8080/v1", new AbortController().signal)).rejects.toThrow("no models");
  });
});

describe("registerLlamswap", () => {
  function makePi() {
    const providers = new Map<string, { name: string; refreshModels: (context: unknown) => Promise<unknown> }>();
    const pi = {
      registerProvider: (name: string, opts: { name: string; refreshModels: (context: unknown) => Promise<unknown> }) =>
        providers.set(name, opts),
    };
    return { pi: pi as never, providers };
  }

  it("registers every configured gateway", () => {
    const { pi, providers } = makePi();
    registerLlamswap(pi);
    expect([...providers.keys()].sort()).toEqual(["spark", "yeti"]);
  });

  it("refreshModels serves the fetched catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ id: "llama" }] })));
    const { pi, providers } = makePi();
    registerLlamswap(pi);

    const models = (await providers.get("yeti")!.refreshModels({ signal: new AbortController().signal, stored: undefined })) as { id: string }[];
    expect(models.map((m) => m.id)).toEqual(["llama"]);
  });

  it("refreshModels falls back to the stored catalog on gateway failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    const { pi, providers } = makePi();
    registerLlamswap(pi);

    const models = (await providers.get("spark")!.refreshModels({
      signal: new AbortController().signal,
      stored: { models: [{ id: "cached", contextWindow: 8192 }] },
    })) as { id: string }[];

    expect(models.map((m) => m.id)).toEqual(["cached"]);
    expect(models[0]).toMatchObject({ contextWindow: 8192 });
  });

  it("refreshModels throws when the gateway fails and no catalog is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    const { pi, providers } = makePi();
    registerLlamswap(pi);

    await expect(
      providers.get("yeti")!.refreshModels({ signal: new AbortController().signal, stored: undefined }),
    ).rejects.toThrow("no cached catalog available");
  });
});
