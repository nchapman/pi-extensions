/**
 * Pure-logic tests for the vendored antigravity extension: model routing,
 * catalog grouping/hydration, request-envelope metadata, credential shaping,
 * and the security redaction/validation helpers. Network boundaries are never
 * touched — discovery fixtures are hand-shaped fetchAvailableModels payloads.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { convertMessages, friendlyAntigravityError, streamResponse } from "../extensions/antigravity/stream/stream";
import { getApiKey } from "../extensions/antigravity/auth/oauth";
import {
  defaultProjectId,
  fetchAvailableModelsCatalog,
  isUsableCatalogData,
  parseApiKey,
} from "../extensions/antigravity/client/client";
import {
  DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  getCatalogRefreshIntervalMs,
  hydrateAntigravityCatalog,
} from "../extensions/antigravity/models/discovery";
import {
  buildAntigravityCatalog,
  extractRecommendedModelIds,
  isSelectableRuntimeModelId,
  resolvedCatalog,
} from "../extensions/antigravity/models/grouping";
import {
  applyAntigravityCatalog,
  clearModelEnumCache,
  getAntigravityRequestModelId,
  getCurrentAntigravityCatalog,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  getFallbackRuntimeModel,
  getModelEnum,
  getMaxOutputTokens,
  getThinkingConfig,
  registerModelEnum,
  resetAntigravityCatalogForTests,
} from "../extensions/antigravity/models/models";
import {
  assertSafeApiBaseUrl,
  maskEmail,
  redactSecrets,
  resolveCallbackHost,
} from "../extensions/antigravity/utils/security";
import {
  antigravityRequestEnvelope,
  sanitizeText,
  stableUuid,
  toInt64SessionId,
} from "../extensions/antigravity/utils/util";

describe("antigravity model routing", () => {
  afterEach(() => {
    resetAntigravityCatalogForTests();
  });

  it("maps public ids + thinking effort to runtime ids", () => {
    expect(getAntigravityRequestModelId("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
    expect(getAntigravityRequestModelId("gemini-3.8-flash", undefined)).toBe("gemini-3.8-flash-low");
    expect(getAntigravityRequestModelId("gemini-3.1-pro", "high")).toBe("gemini-pro-agent");
    expect(getAntigravityRequestModelId("gpt-oss-120b", "high")).toBe("gpt-oss-120b-medium");
    // xhigh degrades to the best advertised level
    expect(getAntigravityRequestModelId("gemini-3.8-flash", "xhigh")).toBe("gemini-3.8-flash-high");
  });

  it("passes unknown public ids through unchanged", () => {
    expect(getAntigravityRequestModelId("some-unknown-model", "low")).toBe("some-unknown-model");
  });

  it("refuses bootstrap routes dropped by a refreshed catalog", () => {
    const current = getCurrentAntigravityCatalog();
    applyAntigravityCatalog({
      models: current.models.filter((m) => m.id === "gpt-oss-120b"),
      routing: { "gpt-oss-120b": current.routing["gpt-oss-120b"] },
    });
    expect(() => getAntigravityRequestModelId("gemini-3.8-flash", "low")).toThrow(/absent from the current catalog/);
  });

  it("caps output tokens per runtime family", () => {
    expect(getMaxOutputTokens("gemini-3.8-flash")).toBe(65536);
    // Prefix defaults apply to the resolved runtime id, as the stream passes it.
    expect(getMaxOutputTokens("whatever", "claude-whatever-9")).toBe(64000);
    expect(getMaxOutputTokens("whatever", "gpt-oss-anything")).toBe(32768);
    expect(getMaxOutputTokens("whatever", "gemini-3.1-pro-low")).toBe(65535);
    expect(getMaxOutputTokens("totally-unknown")).toBe(8192);
  });

  it("downgrades next-gen flash models to the previous generation", () => {
    expect(getFallbackRuntimeModel("gemini-3.8-flash-high")).toBe("gemini-3.7-flash-high");
    expect(getFallbackRuntimeModel("gemini-3.8-flash")).toBe("gemini-3.7-flash-low");
    expect(getFallbackRuntimeModel("claude-opus-4-6")).toBeUndefined();
  });

  it("builds wire thinking configs per model family", () => {
    expect(getThinkingConfig("claude-sonnet-4-6", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    });
    expect(getThinkingConfig("claude-sonnet-4-6", "off")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(getThinkingConfig("gpt-oss-120b", "high")?.thinkingBudget).toBe(8192);
    expect(getThinkingConfig("gemini-3.8-flash", "high")?.thinkingBudget).toBe(-1);
    expect(getThinkingConfig("gemini-3.8-flash", "medium")?.thinkingBudget).toBe(4000);
    expect(getThinkingConfig("gemini-3.8-flash", "off")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    // Gemini 4 Argon rejects thinkingBudget 0 entirely — off means no config sent.
    expect(getThinkingConfig("gemini-4-argon", "off")).toBeUndefined();
    expect(getThinkingConfig("gemini-4-argon", "high")?.thinkingBudget).toBe(-1);
  });
});

describe("antigravity catalog grouping", () => {
  const rawModels = {
    "gemini-3.9-flash-low": {
      displayName: "Gemini 3.9 Flash (Low)",
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportsThinking: true,
      supportsImages: true,
    },
    "gemini-3.9-flash-medium": {
      displayName: "Gemini 3.9 Flash (Medium)",
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportsThinking: true,
    },
    "gemini-3.9-flash-high": {
      displayName: "Gemini 3.9 Flash (High)",
      maxTokens: 1048576,
      maxOutputTokens: 32768, // smallest advertised limit wins
      supportsThinking: true,
    },
    "claude-sonnet-5": { displayName: "Claude Sonnet 5 (Thinking)" },
    // Filtered out: internal/tab/chat/image entries
    chat_internal: { displayName: "internal chat" },
    tab_foo: { displayName: "tab completion" },
    "gemini-3.9-image": { displayName: "Gemini 3.9 Image" },
    MODEL_PLACEHOLDER_X: { displayName: "enum" },
  };

  afterEach(() => {
    resetAntigravityCatalogForTests();
  });

  it("collapses thinking variants into public models with routing", () => {
    const catalog = buildAntigravityCatalog(rawModels, getCurrentAntigravityCatalog());
    const flash = catalog.models.find((m) => m.id === "gemini-3.9-flash");
    expect(flash).toBeDefined();
    // Grouped catalog: name is the public id (pi's picker hides names that add
    // nothing beyond the id, so rows render clean).
    expect(flash?.name).toBe("gemini-3.9-flash");
    expect(flash?.thinkingLevelMap).toMatchObject({
      low: "low",
      medium: "medium",
      high: "high",
    });
    // smallest advertised output limit across variants
    expect(flash?.maxTokens).toBe(32768);
    expect(catalog.routing["gemini-3.9-flash"].routing).toMatchObject({
      low: "gemini-3.9-flash-low",
      medium: "gemini-3.9-flash-medium",
      high: "gemini-3.9-flash-high",
    });

    const claude = catalog.models.find((m) => m.id === "claude-sonnet-5");
    expect(claude).toBeDefined();
    expect(catalog.models.some((m) => m.id.startsWith("chat_"))).toBe(false);
  });

  it("keeps the current catalog when discovery returns nothing usable", () => {
    const current = getCurrentAntigravityCatalog();
    expect(resolvedCatalog(undefined, current)).toBe(current);
    expect(resolvedCatalog({ models: [], routing: {} }, current)).toBe(current);
  });

  it("extracts recommended ids from agentModelSorts", () => {
    expect(extractRecommendedModelIds(undefined)).toBeUndefined();
    expect(extractRecommendedModelIds([])).toBeUndefined();
    expect(extractRecommendedModelIds([{ groups: [{ modelIds: ["gemini-3.9-flash-high", 42] }] }])).toEqual(
      new Set(["gemini-3.9-flash-high"]),
    );
  });

  it("filters unselectable runtime ids", () => {
    expect(isSelectableRuntimeModelId("gemini-3.9-flash")).toBe(true);
    expect(isSelectableRuntimeModelId("MODEL_PLACEHOLDER_X")).toBe(false);
    expect(isSelectableRuntimeModelId("tab_foo")).toBe(false);
    expect(isSelectableRuntimeModelId("has image inside")).toBe(false);
    expect(isSelectableRuntimeModelId("fine", { isInternal: true })).toBe(false);
  });
});

describe("antigravity catalog hydration", () => {
  afterEach(() => {
    resetAntigravityCatalogForTests();
    clearModelEnumCache();
  });

  it("restores a persisted catalog and returns its checkedAt", () => {
    const persisted = {
      "pi-antigravity": {
        catalog: {
          models: [
            {
              id: "gemini-9-flash",
              name: "Gemini 9 Flash (Antigravity)",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
            },
          ],
          routing: { "gemini-9-flash": { defaultRequestId: "gemini-9-flash" } },
        },
        checkedAt: 123456,
        modelEnums: { "gemini-9-flash": "MODEL_PLACEHOLDER_M999" },
        schemaVersion: 2,
        credentialKey: "abc",
      },
    };
    expect(hydrateAntigravityCatalog(persisted)).toBe(123456);
    expect(getCurrentAntigravityCatalog().models.map((m) => m.id)).toEqual(["gemini-9-flash"]);
    expect(getAntigravityRequestModelId("gemini-9-flash", "high")).toBe("gemini-9-flash");
  });

  it("normalizes persisted display names to ids on hydrate", () => {
    // A pre-fork store carried humanized names; hydration must not resurrect them.
    const persisted = {
      "pi-antigravity": {
        catalog: {
          models: [
            {
              id: "gemini-3.8-flash",
              name: "Gemini 3.8 Flash (Antigravity)",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
            },
          ],
          routing: {},
        },
        checkedAt: 999,
        modelEnums: {},
        schemaVersion: 2,
        credentialKey: "k",
      },
    };
    expect(hydrateAntigravityCatalog(persisted)).toBe(999);
    expect(getCurrentAntigravityCatalog().models[0]?.name).toBe("gemini-3.8-flash");
  });

  it("returns 0 for missing or malformed stores", () => {
    expect(hydrateAntigravityCatalog(undefined)).toBe(0);
    expect(hydrateAntigravityCatalog({})).toBe(0);
    expect(hydrateAntigravityCatalog({ "pi-antigravity": { checkedAt: "nope" } })).toBe(0);
  });

  it("reads the refresh interval from env with a 4h default", () => {
    const name = "ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS";
    const saved = process.env[name];
    try {
      delete process.env[name];
      expect(getCatalogRefreshIntervalMs()).toBe(DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
      process.env[name] = "0";
      expect(getCatalogRefreshIntervalMs()).toBe(0);
      process.env[name] = "not-a-number";
      expect(getCatalogRefreshIntervalMs()).toBe(DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});

describe("antigravity request envelope", () => {
  it("labels claude/non-gemini traffic and gates last_execution_id to step > 1", () => {
    const first = antigravityRequestEnvelope("gemini-3.8-flash", {
      isClaude: false,
      step: 1,
      conversationId: "conv-1",
      trajectoryId: "traj-1",
      sessionId: "7",
    });
    expect(first.labels.used_claude).toBe("false");
    expect(first.labels.used_non_gemini_model).toBe("false");
    expect(first.labels.last_step_index).toBe("0");
    expect(first.labels.last_execution_id).toBeUndefined();

    const second = antigravityRequestEnvelope("claude-sonnet-4-6", {
      isClaude: true,
      step: 2,
      conversationId: "conv-1",
      trajectoryId: "traj-1",
      sessionId: "7",
    });
    expect(second.labels.used_claude).toBe("true");
    expect(second.labels.used_non_gemini_model).toBe("true");
    expect(second.labels.last_step_index).toBe("1");
    expect(second.labels.last_execution_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("forwards known model enums as labels", () => {
    registerModelEnum("gemini-3.8-flash", "MODEL_PLACEHOLDER_M318");
    try {
      const envelope = antigravityRequestEnvelope("gemini-3.8-flash", { step: 1 });
      expect(envelope.labels.model_enum).toBe("MODEL_PLACEHOLDER_M318");
    } finally {
      clearModelEnumCache();
    }
  });

  it("fails soft when a model enum cannot be resolved", () => {
    const current = getCurrentAntigravityCatalog();
    applyAntigravityCatalog({
      models: current.models.filter((m) => m.id === "gpt-oss-120b"),
      routing: { "gpt-oss-120b": current.routing["gpt-oss-120b"] },
    });
    clearModelEnumCache();
    // A retired id with a static enum still resolves directly (no throw, no
    // routed fallback), and the envelope that consumes it still builds.
    expect(getModelEnum("gemini-3.8-flash")).toBe("MODEL_PLACEHOLDER_M318");
    expect(() => antigravityRequestEnvelope("gemini-3.8-flash", { step: 1 })).not.toThrow();
    // An id in neither cache nor routing resolves to undefined instead of throwing.
    expect(getModelEnum("mystery-model")).toBeUndefined();
    expect(() => antigravityRequestEnvelope("mystery-model", { step: 1 })).not.toThrow();
  });

  it("derives stable ids from seeds", () => {
    expect(stableUuid("seed")).toBe(stableUuid("seed"));
    expect(stableUuid("a")).not.toBe(stableUuid("b"));
    expect(toInt64SessionId("my-session")).toBe(toInt64SessionId("my-session"));
    expect(toInt64SessionId("123")).toBe("123");
    expect(toInt64SessionId()).toMatch(/^-?\d+$/);
  });
});

describe("antigravity credentials", () => {
  it("round-trips stored credentials through getApiKey/parseApiKey", () => {
    const credentials = {
      refresh: "1//refresh-token",
      access: "ya29.access-token",
      expires: Date.now() + 3_600_000,
      projectId: "proj-123",
      email: "user@example.com",
    };
    const parsed = parseApiKey(getApiKey(credentials));
    expect(parsed).toEqual({ token: "ya29.access-token", projectId: "proj-123" });
  });

  it("falls back to a deterministic project id derived from the account email", () => {
    const credentials = {
      refresh: "1//refresh-token",
      access: "ya29.access-token",
      expires: Date.now() + 3_600_000,
      email: "user@example.com",
    };
    const { projectId } = parseApiKey(getApiKey(credentials));
    expect(projectId).toBe(defaultProjectId("user@example.com"));
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("rejects missing or malformed credentials with a useful error", () => {
    expect(() => parseApiKey(undefined)).toThrow(/Run \/login antigravity/);
    expect(() => parseApiKey("not-json")).toThrow(/Invalid Antigravity credentials/);
    expect(() => parseApiKey(JSON.stringify({ token: "t" }))).toThrow(/Invalid Antigravity credentials/);
  });
});

describe("antigravity security helpers", () => {
  it("redacts tokens from diagnostics text", () => {
    expect(redactSecrets("Authorization: Bearer ya29.ABC123xyz")).not.toContain("ya29.ABC123xyz");
    expect(redactSecrets('{"refresh_token":"1//secret-token"}')).not.toContain("1//secret-token");
    expect(redactSecrets("plain error text")).toBe("plain error text");
  });

  it("only allows https googleapis endpoints without credentials", () => {
    expect(assertSafeApiBaseUrl("https://daily-cloudcode-pa.googleapis.com")).toBe(
      "https://daily-cloudcode-pa.googleapis.com",
    );
    expect(assertSafeApiBaseUrl("https://cloudcode-pa.googleapis.com/")).toBe("https://cloudcode-pa.googleapis.com");
    expect(() => assertSafeApiBaseUrl("http://cloudcode-pa.googleapis.com")).toThrow(/https/);
    expect(() => assertSafeApiBaseUrl("https://evil.example.com")).toThrow(/not allowed/);
    expect(() => assertSafeApiBaseUrl("https://user:pw@cloudcode-pa.googleapis.com")).toThrow(/credentials/);
  });

  it("masks emails and restricts the oauth callback host to loopback", () => {
    expect(maskEmail("someone@example.com")).toBe("s***e@example.com");
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail(undefined)).toBeUndefined();

    expect(resolveCallbackHost(undefined)).toBe("127.0.0.1");
    expect(resolveCallbackHost("localhost")).toBe("127.0.0.1");
    expect(resolveCallbackHost("::1")).toBe("::1");
    expect(() => resolveCallbackHost("0.0.0.0")).toThrow(/loopback/);
  });

  it("replaces lone surrogates so model text stays well-formed", () => {
    expect(sanitizeText("ab\uD800cd")).toBe("ab\uFFFDcd");
    expect(sanitizeText(undefined)).toBe("");
  });
});

describe("antigravity review-fix regressions", () => {
  afterEach(() => {
    resetAntigravityCatalogForTests();
  });

  it("keeps the last-known-good catalog when the stored credential is malformed", async () => {
    const { refreshAntigravityModels } = await import("../extensions/antigravity/models/discovery");
    const context = {
      allowNetwork: true,
      credential: { type: "api_key" as const, key: "not-json" },
      signal: new AbortController().signal,
      publish: async () => true,
    };
    const before = getCurrentAntigravityCatalog().models;
    // Non-forced: parse failure inside discovery keeps the current catalog.
    await expect(refreshAntigravityModels(context)).resolves.toHaveLength(before.length);
    // Forced refreshes report the failure instead of swallowing it.
    await expect(refreshAntigravityModels({ ...context, force: true })).rejects.toThrow(
      /Invalid Antigravity credentials/,
    );
    expect(getCurrentAntigravityCatalog().models).toHaveLength(before.length);
  });
});

describe("antigravity stream hooks", () => {
  it("observes parsed provider events through onProviderStreamEvent", async () => {
    const { streamResponse } = await import("../extensions/antigravity/stream/stream");
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
    const model = {
      id: "gemini-3.8-flash",
      api: "antigravity-api",
      provider: "antigravity",
    } as unknown as Model<Api>;
    const output = {
      role: "assistant" as const,
      content: [],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.8-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const event = {
      candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    };
    // Trailing event deliberately lacks a final newline to cover the flush path.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}`));
        controller.close();
      },
    });
    const observed: unknown[] = [];
    const received = await streamResponse(new Response(body), createAssistantMessageEventStream(), output, model, {
      onProviderStreamEvent: (data) => void observed.push(data),
    });
    expect(received).toBe(true);
    expect(observed).toEqual([event]);
    expect(output.stopReason).toBe("stop");
    expect(output.usage.totalTokens).toBe(5);
  });
});

describe("antigravity retry-classifier parity", () => {
  // pi retries assistant errors by pattern-matching errorMessage
  // (isRetryableAssistantError). These tests run our real messages through
  // pi's real classifier so transient failures auto-retry and permanent ones
  // fail fast, exactly like the built-in providers.
  const classify = (errorMessage: string) =>
    isRetryableAssistantError({
      stopReason: "error",
      errorMessage,
    } as Parameters<typeof isRetryableAssistantError>[0]);

  const wrapped = (status: number | undefined, body: string) =>
    `Antigravity API error (request-failed, endpoint=x, project=p, runtimeModel=m): ${friendlyAntigravityError(status, body)}`;

  it("classifies transient failures as retryable", () => {
    expect(classify(wrapped(500, "internal error"))).toBe(true);
    expect(classify(wrapped(502, "bad gateway"))).toBe(true);
    expect(classify(wrapped(503, "unavailable"))).toBe(true);
    expect(classify(wrapped(503, "No capacity available"))).toBe(true);
    expect(classify(wrapped(504, "upstream timeout"))).toBe(true);
    expect(classify(wrapped(408, "request timeout"))).toBe(true);
    expect(classify("Rate limited by Antigravity (429 ResourceExhausted). Next: retrying automatically.")).toBe(true);
    expect(classify("Antigravity stream ended without a finish reason; terminated early.")).toBe(true);
    expect(classify("Antigravity stream ended without a stop reason")).toBe(true);
    expect(classify("fetch failed")).toBe(true);
  });

  it("classifies permanent failures as non-retryable", () => {
    expect(classify(wrapped(401, "invalid token"))).toBe(false);
    expect(classify(wrapped(403, "permission denied"))).toBe(false);
    expect(classify(wrapped(404, "Requested entity was not found"))).toBe(false);
    expect(classify("Quota reached. Please wait 5 hours. Next: switch models.")).toBe(false);
    expect(classify("context_length_exceeded: Antigravity API error (request-failed): input too long")).toBe(false);
    expect(classify(wrapped(400, "Unknown name: badField"))).toBe(false);
  });
});

describe("antigravity built-in conformance (SME audit fixes)", () => {
  // Base64, length % 4 === 0.
  const SIG = "c2lnbmF0dXJlLXZhbGlkLWJhc2U2NC0wMQ==";
  const baseOutput = () => ({
    role: "assistant" as const,
    content: [],
    api: "antigravity-api",
    provider: "antigravity",
    model: "gemini-3.8-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });

  it("drops cross-model thoughtSignatures on toolCall parts but keeps same-model ones", () => {
    const model = { id: "gemini-3.8-flash", input: ["text", "image"] } as unknown as Model<Api>;
    const assistant = (modelId: string) =>
      ({
        role: "assistant",
        provider: "antigravity",
        model: modelId,
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" }, thoughtSignature: SIG }],
      }) as never;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
    } as never;
    const cross = convertMessages(
      model,
      { messages: [{ role: "user", content: "hi" } as never, assistant("claude-sonnet-4.6"), toolResult] },
      "claude-sonnet-4.6",
    );
    const crossCall = cross.flatMap((c) => c.parts).find((p) => "functionCall" in p) as Record<string, unknown>;
    expect(crossCall).toBeDefined();
    expect(crossCall).not.toHaveProperty("thoughtSignature");

    const same = convertMessages(
      model,
      { messages: [{ role: "user", content: "hi" } as never, assistant("gemini-3.8-flash"), toolResult] },
      "gemini-3.8-flash",
    );
    const sameCall = same.flatMap((c) => c.parts).find((p) => "functionCall" in p) as Record<string, unknown>;
    expect(sameCall).toHaveProperty("thoughtSignature", SIG);
  });

  it("synthesizes tool results for orphaned tool calls (mid-history and final turn)", () => {
    const model = { id: "gemini-3.8-flash", input: ["text", "image"] } as unknown as Model<Api>;
    const callTurn = {
      role: "assistant",
      provider: "antigravity",
      model: "gemini-3.8-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {}, thoughtSignature: SIG }],
    } as never;
    const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;

    const mid = convertMessages(model, { messages: [user("hi"), callTurn, user("continue")] }, "claude-sonnet-4.6");
    const synthetics = mid
      .flatMap((c) => c.parts)
      .filter((p) => "functionResponse" in p && JSON.stringify(p).includes("No result provided"));
    expect(synthetics).toHaveLength(1);

    // Final-turn orphan no longer throws; it degrades to a synthetic result.
    const final = convertMessages(model, { messages: [user("hi"), callTurn] }, "claude-sonnet-4.6");
    expect(JSON.stringify(final)).toContain("No result provided");

    // Answered calls get no synthetic result.
    const answered = convertMessages(
      model,
      {
        messages: [
          user("hi"),
          callTurn,
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
          } as never,
        ],
      },
      "claude-sonnet-4.6",
    );
    expect(JSON.stringify(answered)).not.toContain("No result provided");
  });

  it("only escalates to toolUse on a clean STOP finish", async () => {
    const model = { id: "gemini-3.8-flash", input: ["text", "image"] } as unknown as Model<Api>;
    const run = async (finishReason: string) => {
      const output = baseOutput();
      const event = {
        candidates: [{ content: { parts: [{ functionCall: { name: "bash", args: {} } }] }, finishReason }],
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.close();
        },
      });
      await streamResponse(new Response(body), createAssistantMessageEventStream(), output, model);
      return output.stopReason;
    };
    expect(await run("MAX_TOKENS")).toBe("length");
    expect(await run("STOP")).toBe("toolUse");
  });

  it("replaces images with placeholders for text-only models", () => {
    const model = { id: "gpt-oss-120b", input: ["text"] } as unknown as Model<Api>;
    const contents = convertMessages(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", mimeType: "image/png", data: "aGlzdGVjaQ==" },
            ],
            timestamp: Date.now(),
          } as never,
        ],
      },
      "gpt-oss-120b-medium",
    );
    const json = JSON.stringify(contents);
    expect(json).toContain("(image omitted: model does not support images)");
    expect(json).not.toContain("inlineData");
  });

  it("recovers a stray error payload after a stray non-error JSON line", async () => {
    const model = { id: "gemini-3.8-flash", input: ["text", "image"] } as unknown as Model<Api>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"healthy":"metadata"}\n'));
        controller.enqueue(new TextEncoder().encode('{"error":{"code":429,"message":"too many requests"}}\n\n'));
        controller.close();
      },
    });
    await expect(
      streamResponse(new Response(body), createAssistantMessageEventStream(), baseOutput(), model),
    ).rejects.toThrow(/429/);
  });
});

describe("antigravity xhigh grouping (live agy 1.5.7 payload shape)", () => {
  it("merges plain -xhigh runtime ids into their family instead of a separate group", () => {
    const info = (displayName: string) => ({
      displayName,
      supportsImages: true,
      supportsThinking: true,
      recommended: true,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
    });
    const raw = {
      models: {
        "gemini-4-hydrogen-low": info("Gemini 4 Hydrogen (Low)"),
        "gemini-4-hydrogen-medium": info("Gemini 4 Hydrogen (Medium)"),
        "gemini-4-hydrogen-high": info("Gemini 4 Hydrogen (High)"),
        "gemini-4-hydrogen-xhigh": info("Gemini 4 Hydrogen (XHigh)"),
      },
      agentModelSorts: [
        {
          displayName: "Recommended",
          groups: [
            {
              modelIds: [
                "gemini-4-hydrogen-low",
                "gemini-4-hydrogen-medium",
                "gemini-4-hydrogen-high",
                "gemini-4-hydrogen-xhigh",
              ],
            },
          ],
        },
      ],
    };
    const catalog = buildAntigravityCatalog(
      raw.models,
      { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } },
      raw.agentModelSorts,
    );
    expect(catalog.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen"]);
    expect(catalog.routing["gemini-4-hydrogen"]?.routing).toMatchObject({
      low: "gemini-4-hydrogen-low",
      medium: "gemini-4-hydrogen-medium",
      high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh",
    });
  });

  const liveDump = "/tmp/agy-catalog.json";
  it.skipIf(!existsSync(liveDump))(
    "groups the recorded live 1.5.7 catalog like the agy CLI (regression snapshot)",
    () => {
      const raw = JSON.parse(readFileSync(liveDump, "utf8"));
      const catalog = buildAntigravityCatalog(
        raw.models,
        { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } },
        raw.agentModelSorts,
      );
      expect(catalog.models.map((m) => m.id)).toEqual([
        "gemini-3.8-flash",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "gemini-4-argon",
        "gemini-4-carbon",
        "gemini-4-hydrogen",
        "gpt-oss-120b",
      ]);
    },
  );
});

describe("antigravity catalog source of truth (agy parity)", () => {
  // Google's hosts serve different rollout snapshots (2026-11-12: cloudcode-pa
  // lacked the Gemini-4 carbon/hydrogen families that daily-cloudcode-pa served).
  // The catalog now comes from the FIRST valid endpoint only — never a mix —
  // so a lagging host cannot filter fresh models out of the picker.
  const info = (displayName: string) => ({
    displayName,
    supportsImages: true,
    supportsThinking: true,
    recommended: true,
    maxTokens: 1048576,
    maxOutputTokens: 262144,
  });
  const hydrogenModels = {
    "gemini-4-hydrogen-low": info("Gemini 4 Hydrogen (Low)"),
    "gemini-4-hydrogen-xhigh": info("Gemini 4 Hydrogen (XHigh)"),
  };
  const sorts = (ids: string[]) => [{ displayName: "Recommended", groups: [{ modelIds: ids }] }];
  const dailyPayload = {
    models: { ...hydrogenModels },
    agentModelSorts: sorts(Object.keys(hydrogenModels)),
    defaultAgentModelId: "gemini-4-hydrogen-low",
  };
  const laggingPayload = {
    models: { "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)") },
    agentModelSorts: sorts(["gemini-3.8-flash-low"]),
  };
  const fakeFetch =
    (responders: Record<string, () => Response | Error>) =>
    (url: string | URL): Promise<Response> => {
      for (const [needle, respond] of Object.entries(responders)) {
        if (String(url).includes(needle)) {
          const out = respond();
          if (out instanceof Error) return Promise.reject(out);
          return Promise.resolve(out);
        }
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    };

  it("takes the first valid endpoint's catalog whole — no mixing with lagging hosts", async () => {
    const fetched: string[] = [];
    const fetchFn = fakeFetch({
      "daily-cloudcode-pa.googleapis.com": () => {
        fetched.push("daily");
        return new Response(JSON.stringify(dailyPayload), { status: 200 });
      },
      "cloudcode-pa.googleapis.com": () => {
        fetched.push("cloudcode");
        return new Response(JSON.stringify(laggingPayload), { status: 200 });
      },
    });
    expect(isUsableCatalogData(dailyPayload)).toBe(true);
    expect(isUsableCatalogData({ models: {} })).toBe(false);
    const got = await fetchAvailableModelsCatalog("token", "project", undefined, fetchFn);
    expect(got.endpoint).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(Object.keys(got.data.models ?? {})).toEqual(Object.keys(hydrogenModels));
    expect(got.data.defaultAgentModelId).toBe("gemini-4-hydrogen-low");
    expect(fetched).toEqual(["daily"]); // lagging host never consulted
  });

  it("falls back to the next endpoint when the first fails", async () => {
    const fetchFn = fakeFetch({
      "daily-cloudcode-pa.googleapis.com": () => new Response("upstream error", { status: 503 }),
      "sandbox.googleapis.com": () => new Error("connection reset"),
      "cloudcode-pa.googleapis.com": () => new Response(JSON.stringify(laggingPayload), { status: 200 }),
    });
    const got = await fetchAvailableModelsCatalog("token", "project", undefined, fetchFn);
    expect(got.endpoint).toBe("https://cloudcode-pa.googleapis.com");
    expect(Object.keys(got.data.models ?? {})).toEqual(["gemini-3.8-flash-low"]);
  });

  it("fails with a diagnostic when every endpoint fails", async () => {
    const fetchFn = fakeFetch({
      googleapis: () => new Response("upstream error", { status: 503 }),
    });
    await expect(fetchAvailableModelsCatalog("token", "project", undefined, fetchFn)).rejects.toThrow(
      /failed on all endpoints/,
    );
  });

  it("groups the first endpoint's payload into one hydrogen family with an xhigh variant", async () => {
    const fetchFn = fakeFetch({
      "daily-cloudcode-pa.googleapis.com": () => new Response(JSON.stringify(dailyPayload), { status: 200 }),
    });
    const got = await fetchAvailableModelsCatalog("token", "project", undefined, fetchFn);
    const catalog = buildAntigravityCatalog(
      got.data.models!,
      { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } },
      got.data.agentModelSorts,
    );
    expect(catalog.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen"]);
    expect(catalog.routing["gemini-4-hydrogen"]?.routing).toMatchObject({ xhigh: "gemini-4-hydrogen-xhigh" });
  });
});
