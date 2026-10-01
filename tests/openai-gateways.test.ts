import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  default as registerGateways,
  fetchProviderModels,
  loadGateways,
  parseGateways,
  storedToModels,
  toModels,
} from "../extensions/openai-gateways";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DEFAULTS = { contextWindow: 262144, maxTokens: 65536 };

describe("toModels", () => {
  it("keeps entries with a non-empty string id", () => {
    const models = toModels([{ id: "llama", name: "Llama" }, { id: "" }, { id: 42 }, {}], DEFAULTS);
    expect(models.map((m) => m.id)).toEqual(["llama"]);
  });

  it("falls back to id when name is missing or empty", () => {
    const models = toModels([{ id: "a", name: "" }, { id: "b" }], DEFAULTS);
    expect(models.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("applies gateway defaults", () => {
    const [model] = toModels([{ id: "a" }], DEFAULTS);
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(65536);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("uses per-gateway overrides", () => {
    const [model] = toModels([{ id: "a" }], { contextWindow: 32768, maxTokens: 4096 });
    expect(model.contextWindow).toBe(32768);
    expect(model.maxTokens).toBe(4096);
  });
});

describe("storedToModels", () => {
  it("returns an empty list for no stored catalog", () => {
    expect(storedToModels(undefined, DEFAULTS)).toEqual([]);
  });

  it("applies defaults for missing optional fields", () => {
    expect(storedToModels([{ id: "llama" }], DEFAULTS)).toEqual([
      {
        type: "chat",
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
    const [model] = storedToModels(
      [{ id: "qwen", name: "Qwen", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 8192 }],
      DEFAULTS,
    );
    expect(model).toMatchObject({
      id: "qwen",
      name: "Qwen",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 8192,
    });
  });
});

describe("parseGateways", () => {
  it("parses a full config with defaults", () => {
    const { gateways, skipped } = parseGateways({
      yeti: { baseUrl: "http://yeti:8080/v1" },
      spark: {
        baseUrl: "http://spark:8080/v1/",
        apiKey: "secret",
        contextWindow: 131072,
        maxTokens: 8192,
        models: [{ id: "a", name: "A" }, { junk: true }],
      },
    });
    expect(skipped).toEqual([]);
    expect(gateways).toHaveLength(2);

    const [yeti, spark] = gateways;
    expect(yeti).toMatchObject({ name: "yeti", baseUrl: "http://yeti:8080/v1", apiKey: "local" });
    expect(yeti.seedModels).toEqual([]);
    expect(yeti.contextWindow).toBe(262144);

    expect(spark.baseUrl).toBe("http://spark:8080/v1"); // trailing slash stripped
    expect(spark.apiKey).toBe("secret");
    expect(spark.contextWindow).toBe(131072);
    expect(spark.maxTokens).toBe(8192);
    expect(spark.seedModels).toEqual([{ id: "a", name: "A" }]);
  });

  it("skips invalid entries with a reason instead of throwing", () => {
    const { gateways, skipped } = parseGateways({
      good: { baseUrl: "http://good:8080/v1" },
      "": { baseUrl: "http://x:1/v1" },
      notObject: "nope",
      noUrl: { apiKey: "k" },
      badUrl: { baseUrl: "ftp://nope" },
    });
    expect(gateways.map((g) => g.name)).toEqual(["good"]);
    expect(skipped).toEqual([
      "entry with empty name",
      "notObject: settings are not an object",
      "noUrl: missing or non-http baseUrl",
      "badUrl: missing or non-http baseUrl",
    ]);
  });

  it("rejects nonsense token counts in favor of defaults", () => {
    const { gateways } = parseGateways({
      g: { baseUrl: "http://g:8080/v1", contextWindow: -5, maxTokens: "big" },
    });
    expect(gateways[0].contextWindow).toBe(262144);
    expect(gateways[0].maxTokens).toBe(65536);
  });

  it("handles a non-object config", () => {
    expect(parseGateways(null)).toEqual({ gateways: [], skipped: ["config is not an object"] });
    expect(parseGateways("junk").skipped).toEqual(["config is not an object"]);
  });
});

describe("loadGateways", () => {
  it("returns no gateways when the config file is missing (fail open)", () => {
    const readFile = (path: string) => {
      throw new Error(`ENOENT: ${path}`);
    };
    expect(loadGateways(readFile)).toEqual({ gateways: [], skipped: [] });
  });

  it("throws with the path on unparseable JSON (fail loud)", () => {
    expect(() => loadGateways(() => "{oops")).toThrow(/openai-gateways\.json is not valid JSON/);
  });

  it("validates parsed contents", () => {
    const { gateways, skipped } = loadGateways(() => JSON.stringify({ yeti: { baseUrl: "http://yeti:8080/v1" } }));
    expect(gateways.map((g) => g.name)).toEqual(["yeti"]);
    expect(skipped).toEqual([]);
  });
});

describe("fetchProviderModels", () => {
  it("returns models from a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "a", name: "A" }, { id: "b" }] })),
    );
    const models = await fetchProviderModels("http://yeti:8080/v1", new AbortController().signal, DEFAULTS);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "down" }, 503)),
    );
    await expect(fetchProviderModels("http://yeti:8080/v1", new AbortController().signal, DEFAULTS)).rejects.toThrow(
      "503",
    );
  });

  it("throws when the catalog is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    await expect(fetchProviderModels("http://yeti:8080/v1", new AbortController().signal, DEFAULTS)).rejects.toThrow(
      "no models",
    );
  });
});

describe("registerGateways", () => {
  function makePi() {
    const providers = new Map<
      string,
      { name: string; baseUrl: string; refreshModels: (context: unknown) => Promise<unknown> }
    >();
    const pi = {
      registerProvider: (
        name: string,
        opts: { name: string; baseUrl: string; refreshModels: (context: unknown) => Promise<unknown> },
      ) => providers.set(name, opts),
    };
    return { pi: pi as never, providers };
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const CONFIG = JSON.stringify({
    yeti: { baseUrl: "http://yeti:8080/v1" },
    spark: { baseUrl: "http://spark:8080/v1", models: [{ id: "seed" }] },
    broken: "not an object",
  });

  it("registers every valid gateway and reports skipped entries", () => {
    const { pi, providers } = makePi();
    registerGateways(pi, () => CONFIG);
    expect([...providers.keys()]).toEqual(["yeti", "spark"]);
    expect(providers.get("yeti")!.baseUrl).toBe("http://yeti:8080/v1");
    expect(console.error).toHaveBeenCalledWith(
      "openai-gateways: skipping config entry — broken: settings are not an object",
    );
  });

  it("refreshModels serves the fetched catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "llama" }] })),
    );
    const { pi, providers } = makePi();
    registerGateways(pi, () => CONFIG);

    const models = (await providers.get("yeti")!.refreshModels({
      signal: new AbortController().signal,
      stored: undefined,
    })) as { id: string }[];
    expect(models.map((m) => m.id)).toEqual(["llama"]);
  });

  it("refreshModels falls back to the stored catalog on gateway failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { pi, providers } = makePi();
    registerGateways(pi, () => CONFIG);

    const models = (await providers.get("spark")!.refreshModels({
      signal: new AbortController().signal,
      stored: { models: [{ id: "cached", contextWindow: 8192 }] },
    })) as { id: string }[];

    expect(models.map((m) => m.id)).toEqual(["cached"]);
    expect(models[0]).toMatchObject({ contextWindow: 8192 });
  });

  it("refreshModels falls back to config seeds when nothing is persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { pi, providers } = makePi();
    registerGateways(pi, () => CONFIG);

    const models = (await providers.get("spark")!.refreshModels({
      signal: new AbortController().signal,
      stored: undefined,
    })) as { id: string }[];
    expect(models.map((m) => m.id)).toEqual(["seed"]);
  });

  it("refreshModels throws when the gateway fails and no catalog exists anywhere", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { pi, providers } = makePi();
    registerGateways(pi, () => CONFIG);

    await expect(
      providers.get("yeti")!.refreshModels({ signal: new AbortController().signal, stored: undefined }),
    ).rejects.toThrow("no cached or seeded catalog available");
  });
});
