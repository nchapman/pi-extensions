import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  default as registerGateways,
  fetchProviderModels,
  type Gateway,
  type GatewayDeps,
  loadGateways,
  mergeMirrorIntoModelsJson,
  mirrorProviderEntry,
  parseGateways,
  storedToModels,
  toModels,
  writeModelsJsonMirror,
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

  it("drops stored entries without a usable id", () => {
    const junk = [
      { id: "" },
      { id: 7 },
      null,
      { id: "ok" },
    ] as unknown as readonly import("../extensions/openai-gateways").StoredModel[];
    expect(storedToModels(junk, DEFAULTS).map((m) => m.id)).toEqual(["ok"]);
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
      "gw-a": { baseUrl: "http://gw-a:8080/v1" },
      "gw-b": {
        baseUrl: "http://gw-b:8080/v1/",
        apiKey: "secret",
        contextWindow: 131072,
        maxTokens: 8192,
        models: [{ id: "a", name: "A" }, { junk: true }],
      },
    });
    expect(skipped).toEqual([]);
    expect(gateways).toHaveLength(2);

    const [gwA, gwB] = gateways;
    expect(gwA).toMatchObject({ name: "gw-a", baseUrl: "http://gw-a:8080/v1", apiKey: "local" });
    expect(gwA.seedModels).toEqual([]);
    expect(gwA.contextWindow).toBe(262144);

    expect(gwB.baseUrl).toBe("http://gw-b:8080/v1"); // trailing slash stripped
    expect(gwB.apiKey).toBe("secret");
    expect(gwB.contextWindow).toBe(131072);
    expect(gwB.maxTokens).toBe(8192);
    expect(gwB.seedModels).toEqual([{ id: "a", name: "A" }]);
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
    expect(parseGateways([{ baseUrl: "http://x:1/v1" }]).skipped).toEqual(["config is not an object"]);
  });
});

describe("loadGateways", () => {
  it("returns no gateways when the config file is missing (fail open)", () => {
    const readFile = (path: string) => {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    expect(loadGateways(readFile)).toEqual({ gateways: [], skipped: [] });
  });

  it("rethrows non-ENOENT read errors (fail loud)", () => {
    const readFile = () => {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    };
    expect(() => loadGateways(readFile)).toThrow("EACCES");
  });

  it("throws with the path on unparseable JSON (fail loud)", () => {
    expect(() => loadGateways(() => "{oops")).toThrow(/openai-gateways\.json is not valid JSON/);
  });

  it("validates parsed contents", () => {
    const { gateways, skipped } = loadGateways(() => JSON.stringify({ "gw-a": { baseUrl: "http://gw-a:8080/v1" } }));
    expect(gateways.map((g) => g.name)).toEqual(["gw-a"]);
    expect(skipped).toEqual([]);
  });
});

describe("fetchProviderModels", () => {
  it("returns models from a 200 response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "a", name: "A" }, { id: "b" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const models = await fetchProviderModels("http://gw-a:8080/v1", new AbortController().signal, DEFAULTS);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith("http://gw-a:8080/v1/models", expect.anything());
  });

  it("treats a non-array data payload as an empty catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: "nope" })),
    );
    await expect(fetchProviderModels("http://gw-a:8080/v1", new AbortController().signal, DEFAULTS)).rejects.toThrow(
      "no models",
    );
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "down" }, 503)),
    );
    await expect(fetchProviderModels("http://gw-a:8080/v1", new AbortController().signal, DEFAULTS)).rejects.toThrow(
      "503",
    );
  });

  it("throws when the catalog is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    await expect(fetchProviderModels("http://gw-a:8080/v1", new AbortController().signal, DEFAULTS)).rejects.toThrow(
      "no models",
    );
  });
});

describe("mirrorProviderEntry", () => {
  const gw: Gateway = {
    name: "gw-a",
    baseUrl: "http://gw-a:8080/v1",
    apiKey: "local",
    seedModels: [],
    contextWindow: 262144,
    maxTokens: 65536,
  };

  it("carries the endpoint and only the defined model fields", () => {
    const entry = mirrorProviderEntry(gw, [
      { id: "full", name: "Full", reasoning: true, input: ["text", "image"], contextWindow: 8192, maxTokens: 4096 },
      { id: "bare" },
    ]);
    expect(entry).toMatchObject({ baseUrl: "http://gw-a:8080/v1", api: "openai-completions", apiKey: "local" });
    expect(entry.models).toEqual([
      { id: "full", name: "Full", reasoning: true, input: ["text", "image"], contextWindow: 8192, maxTokens: 4096 },
      { id: "bare" },
    ]);
  });
});

describe("mergeMirrorIntoModelsJson", () => {
  const gateways: Gateway[] = [
    { name: "yeti", baseUrl: "http://yeti:8080/v1", apiKey: "local", seedModels: [], contextWindow: 1, maxTokens: 2 },
  ];

  it("creates the providers object for a missing file", () => {
    expect(mergeMirrorIntoModelsJson(undefined, gateways, new Map([["yeti", [{ id: "m" }]]]))).toEqual({
      providers: { yeti: expect.objectContaining({ baseUrl: "http://yeti:8080/v1" }) },
    });
  });

  it("preserves unrelated providers and unknown top-level keys, replaces only managed entries", () => {
    const current = {
      modelOverrides: { "other/x": { name: "X" } },
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", models: [{ id: "keep" }] },
        yeti: { baseUrl: "http://old:9999/v1", models: [] },
      },
    };
    const merged = mergeMirrorIntoModelsJson(current, gateways, new Map([["yeti", [{ id: "fresh" }]]]))!;
    expect(merged.modelOverrides).toEqual(current.modelOverrides);
    const providers = merged.providers as Record<string, { baseUrl?: string; models?: { id: string }[] }>;
    expect(providers.ollama).toEqual(current.providers.ollama);
    expect(providers.yeti).toMatchObject({ baseUrl: "http://yeti:8080/v1", models: [{ id: "fresh" }] });
    // Input is not mutated.
    expect(current.providers.yeti.baseUrl).toBe("http://old:9999/v1");
  });

  it("returns null when nothing changes (skip the write) and never clobbers odd shapes", () => {
    const catalogs = new Map([["yeti", [{ id: "m" }]]]);
    const once = mergeMirrorIntoModelsJson(undefined, gateways, catalogs)!;
    expect(mergeMirrorIntoModelsJson(once, gateways, catalogs)).toBeNull();
    expect(mergeMirrorIntoModelsJson([], gateways, catalogs)).toBeNull(); // array root
    expect(mergeMirrorIntoModelsJson({ providers: "nope" }, gateways, catalogs)).toBeNull(); // non-object providers
  });

  it("treats a missing catalog as no opinion: an existing entry survives, nothing is written empty", () => {
    // The regression this guards: a seedless gateway at load used to write
    // models: [], clobbering the previous session's fetched list.
    const current = { providers: { yeti: { baseUrl: "http://yeti:8080/v1", models: [{ id: "previous" }] } } };
    expect(mergeMirrorIntoModelsJson(current, gateways, new Map())).toBeNull();
    expect(current.providers.yeti.models).toEqual([{ id: "previous" }]);
    // First run with no catalog at all: still nothing written for that gateway.
    expect(mergeMirrorIntoModelsJson(undefined, gateways, new Map())).toBeNull();
  });
});

describe("writeModelsJsonMirror", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const gateways: Gateway[] = [
    { name: "yeti", baseUrl: "http://yeti:8080/v1", apiKey: "local", seedModels: [], contextWindow: 1, maxTokens: 2 },
  ];

  function makeFs(initial?: string) {
    const writes: Array<{ path: string; text: string }> = [];
    let current = initial;
    return {
      writes,
      deps: {
        modelsJsonPath: "/virtual/models.json",
        readModelsJson: () => {
          if (current === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return current;
        },
        writeModelsJson: (path: string, text: string) => {
          current = text;
          writes.push({ path, text });
        },
      },
    };
  }

  it("creates the file on first run and skips the write when unchanged", () => {
    const fs = makeFs();
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", [{ id: "m" }]]]), fs.deps)).toBe(true);
    const written = JSON.parse(fs.writes[0].text);
    expect(written.providers.yeti.models).toEqual([{ id: "m" }]);
    // Re-run with identical catalogs: no second write.
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", [{ id: "m" }]]]), fs.deps)).toBe(false);
    expect(fs.writes).toHaveLength(1);
  });

  it("never writes over an unparseable models.json", () => {
    const fs = makeFs("{ not json");
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", []]]), fs.deps)).toBe(false);
    expect(fs.writes).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not mirroring"));
  });

  it("warns when the load flush takes over a differing existing entry (catalog updates never do)", () => {
    const existing = JSON.stringify({
      providers: { yeti: { baseUrl: "http://old:9999/v1", models: [{ id: "user-authored", extra: true }] } },
    });
    const fs = makeFs(existing);
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", [{ id: "m" }]]]), fs.deps, { warnOnTakeover: true })).toBe(
      true,
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("gateway config owns models.json providers.yeti"),
    );
    // Without the flag (catalog updates), the same rewrite stays silent.
    vi.mocked(console.error).mockClear();
    const fs2 = makeFs(existing);
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", [{ id: "m2" }]]]), fs2.deps)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("warns and skips on write failure, does nothing with no gateways", () => {
    const fs = makeFs();
    const throwing = {
      ...fs.deps,
      writeModelsJson: () => {
        throw new Error("disk full");
      },
    };
    expect(writeModelsJsonMirror(gateways, new Map([["yeti", [{ id: "m" }]]]), throwing)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(writeModelsJsonMirror([], new Map(), makeFs().deps)).toBe(false);
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
    // Default fetch stub for the load-time kick in tests that don't care:
    // never touch the network from the suite.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const CONFIG = JSON.stringify({
    "gw-a": { baseUrl: "http://gw-a:8080/v1" },
    "gw-b": { baseUrl: "http://gw-b:8080/v1", models: [{ id: "seed" }] },
    broken: "not an object",
  });

  /**
   * Memory filesystem + injected fetch; captures every models.json write.
   * fetchModels omitted by default so refreshModels exercises the real
   * fetchProviderModels against the test's global fetch stub; the load-time
   * kick is deterministic only in tests that pass an explicit fake.
   */
  function makeDeps(
    fetchModels?: (
      baseUrl: string,
      signal: AbortSignal,
      defaults: { contextWindow: number; maxTokens: number },
    ) => Promise<{ id: string }[]>,
    initialModelsJson?: string,
  ) {
    const writes: string[] = [];
    let modelsJson = initialModelsJson;
    return {
      writes,
      deps: {
        readFile: () => CONFIG,
        modelsJsonPath: "/virtual/models.json",
        readModelsJson: () => {
          if (modelsJson === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return modelsJson;
        },
        writeModelsJson: (_path: string, text: string) => {
          modelsJson = text;
          writes.push(text);
        },
        ...(fetchModels ? { fetchModels: fetchModels as GatewayDeps["fetchModels"] } : {}),
      },
      lastMirror: () => {
        expect(writes.length).toBeGreaterThan(0);
        return JSON.parse(writes[writes.length - 1]);
      },
    };
  }

  it("registers every valid gateway and reports skipped entries", () => {
    const { pi, providers } = makePi();
    registerGateways(pi, makeDeps().deps);
    expect([...providers.keys()]).toEqual(["gw-a", "gw-b"]);
    expect(providers.get("gw-a")!.baseUrl).toBe("http://gw-a:8080/v1");
    expect(console.error).toHaveBeenCalledWith(
      "openai-gateways: skipping config entry — broken: settings are not an object",
    );
  });

  it("mirrors seeds into models.json at load; seedless gateways wait for a fetch", async () => {
    const { pi } = makePi();
    const { writes, deps, lastMirror } = makeDeps(async () => [{ id: "live-a" }, { id: "live-b" }]);
    registerGateways(pi, deps);
    // Load-time write: gw-b carries its seed; gw-a has no catalog yet — no
    // opinion, so no entry is written for it (never an empty list).
    const atLoad = JSON.parse(writes[0]);
    expect(atLoad.providers["gw-b"].models).toEqual([{ id: "seed" }]);
    expect(atLoad.providers["gw-a"]).toBeUndefined();
    // The bounded catch-up fetch populates gw-a without any refreshModels call.
    await vi.waitFor(() =>
      expect(lastMirror().providers["gw-a"].models.map((m: { id: string }) => m.id)).toEqual(["live-a", "live-b"]),
    );
    expect(lastMirror().providers["gw-b"].baseUrl).toBe("http://gw-b:8080/v1");
  });

  it("never clobbers an existing mirror when the gateway is unreachable all session", async () => {
    const existing = JSON.stringify({
      providers: {
        "gw-a": { baseUrl: "http://gw-a:8080/v1", models: [{ id: "previous-session" }] },
        other: { baseUrl: "http://elsewhere:1/v1", models: [] },
      },
    });
    const { pi } = makePi();
    const { writes, deps } = makeDeps(async () => {
      throw new Error("gateway down");
    }, existing);
    registerGateways(pi, deps);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the failed kick settle
    // gw-b has seeds and no prior entry, so the load flush legitimately adds
    // it — exactly one write. gw-a never got a catalog (no seeds, fetch
    // failed): its previous mirror survives verbatim and the failed kick
    // writes nothing further.
    expect(writes).toHaveLength(1);
    const finalFile = JSON.parse(writes[0]);
    expect(finalFile.providers["gw-a"].models).toEqual([{ id: "previous-session" }]);
    expect(finalFile.providers.other).toEqual({ baseUrl: "http://elsewhere:1/v1", models: [] });
    expect(finalFile.providers["gw-b"].models).toEqual([{ id: "seed" }]);
  });

  it("refreshModels serves the fetched catalog and mirrors it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "llama" }] })),
    );
    const { pi, providers } = makePi();
    const { deps, lastMirror } = makeDeps();
    registerGateways(pi, deps);

    const models = (await providers.get("gw-a")!.refreshModels({
      signal: new AbortController().signal,
      stored: undefined,
    })) as { id: string }[];
    expect(models.map((m) => m.id)).toEqual(["llama"]);
    expect(lastMirror().providers["gw-a"].models.map((m: { id: string }) => m.id)).toEqual(["llama"]);
  });

  it("refreshModels falls back to the stored catalog on gateway failure and mirrors it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { pi, providers } = makePi();
    const { deps, lastMirror } = makeDeps();
    registerGateways(pi, deps);

    const models = (await providers.get("gw-b")!.refreshModels({
      signal: new AbortController().signal,
      stored: { models: [{ id: "cached", contextWindow: 8192 }] },
    })) as { id: string }[];

    expect(models.map((m) => m.id)).toEqual(["cached"]);
    expect(models[0]).toMatchObject({ contextWindow: 8192 });
    expect(lastMirror().providers["gw-b"].models.map((m: { id: string }) => m.id)).toEqual(["cached"]);
  });

  it("refreshModels falls back to config seeds when nothing is persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { pi, providers } = makePi();
    const { deps } = makeDeps();
    registerGateways(pi, deps);

    const models = (await providers.get("gw-b")!.refreshModels({
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
    const { deps } = makeDeps();
    registerGateways(pi, deps);

    await expect(
      providers.get("gw-a")!.refreshModels({ signal: new AbortController().signal, stored: undefined }),
    ).rejects.toThrow("no cached or seeded catalog available");
  });
});
