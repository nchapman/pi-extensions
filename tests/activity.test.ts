import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindActivity, createActivityStore } from "../lib/activity";

function runtime(id: string) {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void)[]>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => id } } as ExtensionContext;
  return {
    pi,
    emit: (name: string) => {
      for (const h of handlers.get(name) ?? []) h({}, ctx);
    },
  };
}

describe("activity holds", () => {
  it("counts overlapping holds and releases each token only once", () => {
    const store = createActivityStore();
    const counts: number[] = [];
    const unsubscribe = store.subscribe((n) => counts.push(n));
    const a = store.hold("a"),
      b = store.hold("b");
    a();
    a();
    b();
    expect(counts).toEqual([0, 1, 2, 1, 0]);
    unsubscribe();
    store.hold("unobserved")();
    expect(counts).toHaveLength(5);
  });

  it("isolates a failing observer from producers and other observers", () => {
    const store = createActivityStore();
    store.subscribe(() => {
      throw new Error("broken reporter");
    });
    const seen: number[] = [];
    store.subscribe((n) => seen.push(n));
    store.hold("job")();
    expect(seen).toEqual([0, 1, 0]);
  });

  it("shares within a session but isolates other sessions and cleans up owners", () => {
    const a = runtime("activity-shared"),
      b = runtime("activity-shared"),
      c = runtime("activity-other");
    const aa = bindActivity(a.pi, "a"),
      bb = bindActivity(b.pi, "b"),
      cc = bindActivity(c.pi, "c");
    a.emit("session_start");
    b.emit("session_start");
    c.emit("session_start");
    const late = aa.hold();
    bb.hold();
    cc.hold();
    expect([aa.count, bb.count, cc.count]).toEqual([2, 2, 1]);
    a.emit("session_shutdown");
    expect(bb.count).toBe(1);
    a.emit("session_start");
    aa.hold();
    late();
    expect(aa.count).toBe(2);
    a.emit("session_shutdown");
    b.emit("session_shutdown");
    c.emit("session_shutdown");
    a.emit("session_start");
    expect(aa.count).toBe(0);
    a.emit("session_shutdown");
  });

  it("does not acquire holds outside an active session", () => {
    const r = runtime("activity-outside");
    const activity = bindActivity(r.pi, "job");
    activity.hold()();
    expect(activity.count).toBe(0);
    r.emit("session_start");
    activity.hold();
    r.emit("session_shutdown");
    activity.hold()();
    expect(activity.count).toBe(0);
  });

  it("replays current state to late observers and detaches subscriptions on shutdown", () => {
    const r = runtime("activity-observers");
    const job = bindActivity(r.pi, "job"),
      reporter = bindActivity(r.pi, "reporter");
    const seen: number[] = [];
    reporter.subscribe((n) => seen.push(n));
    r.emit("session_start");
    const done = job.hold();
    const late: number[] = [];
    const off = reporter.subscribe((n) => late.push(n));
    expect(late).toEqual([1]);
    off();
    done();
    expect(seen).toEqual([0, 1, 0]);
    r.emit("session_shutdown");
  });

  it("shares across independently loaded module copies (jiti)", async () => {
    const a = runtime("activity-module-copies"),
      b = runtime("activity-module-copies");
    const aa = bindActivity(a.pi, "a");
    vi.resetModules();
    const second = await import("../lib/activity");
    const bb = second.bindActivity(b.pi, "b");
    a.emit("session_start");
    b.emit("session_start");
    aa.hold();
    expect(bb.count).toBe(1);
    a.emit("session_shutdown");
    b.emit("session_shutdown");
  });
});
