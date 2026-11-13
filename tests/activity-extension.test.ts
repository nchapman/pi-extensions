import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import registerActivity from "../extensions/activity";
import { bindActivity } from "../lib/activity";
import { createTaskRegistry } from "../lib/superbash";

function harness(mode = "tui") {
  vi.useFakeTimers();
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void)[]>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const reports: ProgramStatus[] = [];
  const terminal = {
    setProgramStatus(status: ProgramStatus) {
      reports.push(status);
    },
  };
  const original = terminal.setProgramStatus;
  let widget: { render(): string[]; dispose(): void } | undefined;
  const setWidget = vi.fn((_key, factory) => {
    widget?.dispose();
    widget = factory?.({ terminal });
  });
  const ctx = {
    mode,
    isIdle: () => true,
    sessionManager: { getSessionId: () => `activity-extension-${mode}`, getSessionName: () => undefined },
    ui: { setWidget },
  } as unknown as ExtensionContext;
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({ reason: "startup" }, ctx);
  };
  registerActivity(pi);
  const activity = bindActivity(pi, "test-tasks");
  return { emit, activity, reports, terminal, original, setWidget, widget: () => widget };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("activity extension lifecycle", () => {
  it("keeps settled Pi working for shared-registry jobs and restores reporting on shutdown", () => {
    const h = harness();
    h.emit("session_start");
    expect(h.widget()?.render()).toEqual([]);
    const registry = createTaskRegistry({ holdBusy: h.activity.hold });
    const a = registry.adopt({ kind: "bash", name: "ssh or local bash", kill() {} });
    const b = registry.adopt({ kind: "subagent", name: "child", kill() {} });
    h.terminal.setProgramStatus({ state: "done", app: "pi" });
    registry.complete(a, { ok: true, text: "done", wake: false });
    vi.advanceTimersByTime(1000);
    expect(h.reports.map((r) => r.state)).not.toContain("done");
    registry.kill(b);
    vi.advanceTimersByTime(1000);
    expect(h.reports.at(-1)?.state).toBe("done");
    h.emit("session_shutdown");
    expect(h.terminal.setProgramStatus).toBe(h.original);
    expect(h.widget()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "json", "print"])("never touches the terminal in %s mode, even with inherited Herdr env", (mode) => {
    vi.stubEnv("HC_TERMINAL_ID", "t1");
    const h = harness(mode);
    h.emit("session_start");
    h.activity.hold();
    expect(h.setWidget).not.toHaveBeenCalled();
    expect(h.reports).toEqual([]);
    h.emit("session_shutdown");
  });

  it("supports disabling only the status adapter without disabling holds", () => {
    vi.stubEnv("PI_ACTIVITY_STATUS", "0");
    const h = harness();
    h.emit("session_start");
    h.activity.hold();
    expect(h.activity.count).toBe(1);
    expect(h.setWidget).not.toHaveBeenCalled();
    h.emit("session_shutdown");
  });
});
