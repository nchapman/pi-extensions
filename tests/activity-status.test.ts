import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { createActivityStore } from "../lib/activity";
import { attachProgramStatus, RELEASE_GRACE_MS } from "../extensions/activity";

function setup() {
  vi.useFakeTimers();
  const activity = createActivityStore();
  const reports: ProgramStatus[] = [];
  const terminal = {
    setProgramStatus(status: ProgramStatus) {
      expect(this).toBe(terminal);
      reports.push({ ...status });
    },
  };
  const original = terminal.setProgramStatus;
  const detach = attachProgramStatus(terminal, activity, { state: "idle", app: "pi" });
  return { activity, terminal, reports, detach, original, states: () => reports.map((r) => r.state) };
}
afterEach(() => vi.useRealTimers());

describe("terminal activity adapter", () => {
  it("never emits native done while background work remains", () => {
    const s = setup();
    s.terminal.setProgramStatus({ state: "working", app: "pi", message: "project" });
    const release = s.activity.hold("background");
    s.terminal.setProgramStatus({ state: "done", app: "pi", message: "project" });
    expect(s.states()).toEqual(["working"]);
    release();
    expect(s.states()).toEqual(["working"]);
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.reports.at(-1)).toEqual({ state: "done", app: "pi", message: "project" });
    s.detach();
  });

  it("actively republishes on acquisition and final release without a native event", () => {
    const s = setup();
    s.terminal.setProgramStatus({ state: "done", app: "pi" });
    const a = s.activity.hold("a"),
      b = s.activity.hold("b");
    a();
    vi.advanceTimersByTime(1000);
    expect(s.states()).toEqual(["done", "working"]);
    b();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.states()).toEqual(["done", "working", "done"]);
    s.detach();
  });

  it("bridges completion to a native wake without a false done transition", () => {
    const s = setup();
    const release = s.activity.hold("task");
    s.terminal.setProgramStatus({ state: "done", app: "pi" });
    release();
    vi.advanceTimersByTime(50);
    s.terminal.setProgramStatus({ state: "working", app: "pi" });
    vi.advanceTimersByTime(1000);
    expect(s.states()).toEqual(["working"]);
    s.terminal.setProgramStatus({ state: "done", app: "pi" });
    expect(s.states()).toEqual(["working", "done"]);
    s.detach();
  });

  it("bounds the grace when a wake is rejected or consumed", () => {
    const s = setup();
    const release = s.activity.hold("task");
    s.terminal.setProgramStatus({ state: "done" });
    release();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.reports.at(-1)?.state).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    s.detach();
  });

  it.each(["blocked", "error", "clear"] as const)("preserves native %s even with holds and pending grace", (state) => {
    const s = setup();
    const release = s.activity.hold("job");
    s.terminal.setProgramStatus({ state: "done" });
    release();
    const status: ProgramStatus = {
      state,
      message: "native detail",
      ...(state === "blocked" ? { kind: "permission" as const } : {}),
    };
    s.terminal.setProgramStatus(status);
    vi.advanceTimersByTime(1000);
    expect(s.reports.at(-1)).toEqual(status);
    s.activity.hold("another");
    expect(s.reports.at(-1)).toEqual(status);
    s.detach();
  });

  it("does not mask native working during compaction when the last hold releases", () => {
    const s = setup();
    const release = s.activity.hold("job");
    s.terminal.setProgramStatus({ state: "working", message: "Compacting context" });
    release();
    vi.advanceTimersByTime(1000);
    expect(s.reports.at(-1)).toEqual({ state: "working", message: "Compacting context" });
    s.detach();
  });

  it("new work during grace keeps working and restores the latest native outcome", () => {
    const s = setup();
    const a = s.activity.hold("a");
    s.terminal.setProgramStatus({ state: "done", message: "old" });
    a();
    const b = s.activity.hold("b");
    s.terminal.setProgramStatus({ state: "idle", message: "new" });
    vi.advanceTimersByTime(1000);
    expect(s.states()).not.toContain("done");
    expect(s.states()).not.toContain("idle");
    b();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.reports.at(-1)).toEqual({ state: "idle", message: "new" });
    s.detach();
  });

  it("restores the setter and cancels pending output on teardown", () => {
    const s = setup();
    s.activity.hold("job")();
    const before = s.reports.length;
    s.detach();
    s.detach();
    expect(s.terminal.setProgramStatus).toBe(s.original);
    vi.advanceTimersByTime(1000);
    expect(s.reports).toHaveLength(before);
    s.activity.hold("late")();
    expect(s.reports).toHaveLength(before);
  });

  it("does not clobber a later decorator and leaves a retained wrapper inert", () => {
    const s = setup();
    const wrapper = s.terminal.setProgramStatus;
    const newer = (status: ProgramStatus) => wrapper(status);
    s.terminal.setProgramStatus = newer;
    s.detach();
    expect(s.terminal.setProgramStatus).toBe(newer);
    s.activity.hold("late");
    newer({ state: "done" });
    expect(s.states()).toEqual(["done"]);
  });

  it("retains the raw native state across reload, not the overridden working state", () => {
    const s = setup();
    const release = s.activity.hold("old");
    s.terminal.setProgramStatus({ state: "done", message: "result" });
    s.detach();
    release();
    const next = createActivityStore();
    const end = next.hold("adopted");
    const detach = attachProgramStatus(s.terminal, next, { state: "idle" }, true);
    end();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.reports.at(-1)).toEqual({ state: "done", message: "result" });
    detach();
  });
});
