import { describe, expect, it } from "vitest";
import {
  createPushoverNotifier,
  formatPushoverMessage,
  parsePushoverConfig,
  type PushoverConfig,
} from "../extensions/pushover";
import type { GoalCompletedEvent } from "../lib/goal-events";

const event: GoalCompletedEvent = {
  id: 7,
  objective: "make the build green",
  summary: "fixed the flaky test",
  criteriaCount: 3,
  cwd: "/Users/x/proj",
  at: 1_700_000_000_000,
};

describe("parsePushoverConfig", () => {
  it("accepts both credentials, trimming blanks", () => {
    expect(parsePushoverConfig({ PI_PUSHOVER_TOKEN: " t ", PI_PUSHOVER_USER: "u" })).toEqual({ token: "t", user: "u" });
  });

  it("is inert unless both are present and non-blank", () => {
    expect(parsePushoverConfig({})).toBeNull();
    expect(parsePushoverConfig({ PI_PUSHOVER_TOKEN: "t" })).toBeNull();
    expect(parsePushoverConfig({ PI_PUSHOVER_USER: "u" })).toBeNull();
    expect(parsePushoverConfig({ PI_PUSHOVER_TOKEN: "  ", PI_PUSHOVER_USER: "u" })).toBeNull();
  });
});

describe("formatPushoverMessage", () => {
  it("puts the id, objective, summary, and project in the notification", () => {
    const { title, message } = formatPushoverMessage(event);
    expect(title).toContain("Goal #7 complete: make the build green");
    expect(message).toContain("fixed the flaky test");
    expect(message).toContain("3 criteria");
    expect(message).toContain("/Users/x/proj");
  });

  it("falls back to the objective when the summary is empty", () => {
    const { message } = formatPushoverMessage({ ...event, summary: "" });
    expect(message).toContain("make the build green");
  });

  it("clips to Pushover's documented title/message limits", () => {
    const giant = { ...event, objective: "x".repeat(10_000), summary: "y".repeat(10_000) };
    const { title, message } = formatPushoverMessage(giant);
    expect(title.length).toBeLessThanOrEqual(250);
    expect(message.length).toBeLessThanOrEqual(1024);
  });
});

describe("createPushoverNotifier", () => {
  const config: PushoverConfig = { token: "tok", user: "usr" };

  function captureFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(_url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("POSTs the credentials and message with a bounded signal, without reading the body", async () => {
    const { calls, fetchFn } = captureFetch();
    const notify = createPushoverNotifier(config, { fetchFn });
    notify(event);
    // Fire-and-forget: let the microtask chain settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const body = calls[0].init.body as URLSearchParams;
    expect(body.get("token")).toBe("tok");
    expect(body.get("user")).toBe("usr");
    expect(body.get("title")).toContain("Goal #7");
    expect(body.get("message")).toContain("fixed the flaky test");
  });

  it("never throws: fetch rejection and non-2xx both fail open to one log line", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const reject = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    createPushoverNotifier(config, { fetchFn: reject, log })(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toEqual([expect.stringContaining("network down")]);

    const badStatus = (async () => new Response(null, { status: 502 })) as typeof fetch;
    lines.length = 0;
    createPushoverNotifier(config, { fetchFn: badStatus, log })(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toEqual([expect.stringContaining("HTTP 502")]);
  });
});
