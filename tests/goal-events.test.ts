import { describe, expect, it, vi } from "vitest";
import {
  emitGoalCompleted,
  emitGoalParked,
  onGoalCompleted,
  onGoalParked,
  type GoalCompletedEvent,
  type GoalParkedEvent,
} from "../lib/goal-events";

const event: GoalCompletedEvent = {
  id: 3,
  objective: "land the release",
  summary: "all tests green",
  criteriaCount: 2,
  cwd: "/tmp/proj",
  at: 1_700_000_000_000,
};

describe("goal-events", () => {
  it("delivers the event to every listener", () => {
    const seen: GoalCompletedEvent[] = [];
    const off = onGoalCompleted("a", (e) => seen.push(e));
    emitGoalCompleted(event);
    expect(seen).toEqual([event]);
    off();
  });

  it("treats zero listeners as the normal case (no throw)", () => {
    expect(() => emitGoalCompleted(event)).not.toThrow();
  });

  it("isolates a throwing listener: siblings still run, the emitter never sees the error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const good: GoalCompletedEvent[] = [];
      const offBad = onGoalCompleted("bad", () => {
        throw new Error("consumer bug");
      });
      const off = onGoalCompleted("good", (e) => good.push(e));
      expect(() => emitGoalCompleted(event)).not.toThrow();
      expect(good).toEqual([event]);
      expect(errSpy).toHaveBeenCalledOnce();
      off();
      offBad();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stops delivery after unsubscribe", () => {
    const seen: GoalCompletedEvent[] = [];
    const off = onGoalCompleted("a", (e) => seen.push(e));
    off();
    emitGoalCompleted(event);
    expect(seen).toEqual([]);
  });

  it("owner re-registration replaces (reload-idempotent), and a stale unsubscribe is a no-op", () => {
    const first: GoalCompletedEvent[] = [];
    const second: GoalCompletedEvent[] = [];
    const offOld = onGoalCompleted("pushover", (e) => first.push(e));
    const offNew = onGoalCompleted("pushover", (e) => second.push(e));
    offOld(); // stale copy's unsubscribe must not remove the new registration
    emitGoalCompleted(event);
    expect(first).toEqual([]);
    expect(second).toEqual([event]);
    offNew();
  });

  it("shares the bus across module copies (pi loads each extension through its own jiti instance)", async () => {
    // Two query specifiers force two module instances — the production shape,
    // where goal.ts and pushover.ts hold separate copies of this module and a
    // module-scoped bus would silently never connect them.
    type GoalEvents = typeof import("../lib/goal-events");
    const spec = (tag: string) => `../lib/goal-events?copy=${tag}`;
    const copyA = (await import(/* @vite-ignore */ spec("a"))) as GoalEvents;
    const copyB = (await import(/* @vite-ignore */ spec("b"))) as GoalEvents;
    expect(copyA.onGoalCompleted).not.toBe(copyB.onGoalCompleted);

    const seen: GoalCompletedEvent[] = [];
    const off = copyB.onGoalCompleted("cross-copy", (e: GoalCompletedEvent) => seen.push(e));
    copyA.emitGoalCompleted(event);
    expect(seen).toEqual([event]);
    off();
  });
});

describe("goal parked events", () => {
  const park: GoalParkedEvent = {
    id: 3,
    objective: "ship it",
    flavor: "impasse",
    reason: "no credentials",
    resumeRequires: "evidence",
    spendMs: 1_000,
    cwd: "/p",
    at: 1,
  };
  it("delivers to every listener and isolates throwers", () => {
    const good: GoalParkedEvent[] = [];
    const offBad = onGoalParked("bad", () => {
      throw new Error("consumer bug");
    });
    const off = onGoalParked("a", (e) => good.push(e));
    try {
      expect(() => emitGoalParked(park)).not.toThrow();
      expect(good).toEqual([park]);
    } finally {
      off();
      offBad();
    }
  });
  it("unsubscribes idempotently and only its own listener", () => {
    const seen: GoalParkedEvent[] = [];
    const off1 = onGoalParked("one", (e) => {
      seen.push(e);
    });
    const listener2 = (e: GoalParkedEvent): void => {
      seen.push(e);
    };
    const off2 = onGoalParked("two", listener2);
    off2();
    off2(); // double-off is a no-op
    emitGoalParked(park);
    off1();
    emitGoalParked(park);
    expect(seen).toEqual([park]);
  });
  it("owner re-registration replaces, not stacks", () => {
    const seen: GoalParkedEvent[] = [];
    const offA = onGoalParked("owner", (e) => seen.push(e));
    offA();
    const offB = onGoalParked("owner", (e) => {
      seen.push({ ...e, flavor: "premise" });
    });
    try {
      emitGoalParked(park);
      expect(seen).toEqual([{ ...park, flavor: "premise" }]);
    } finally {
      offB();
    }
  });
});
