import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BASH_TAIL_CAP,
  capResultText,
  createBackgroundRegistry,
  createBgTool,
  DEFAULT_BG_AFTER_MS,
  formatDuration,
  formatSubagentWake,
  parseBgAfterMs,
  parseWakeEnabled,
  stashPath,
  WAKE_TEXT_CAP,
} from "../lib/background";

describe("env parsing", () => {
  it("defaults the adoption threshold and rejects invalid values", () => {
    expect(parseBgAfterMs({})).toBe(DEFAULT_BG_AFTER_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "abc" })).toBe(DEFAULT_BG_AFTER_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "-5" })).toBe(DEFAULT_BG_AFTER_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "" })).toBe(DEFAULT_BG_AFTER_MS); // Number("") is 0
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "  " })).toBe(DEFAULT_BG_AFTER_MS);
  });

  it("accepts valid thresholds including zero", () => {
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "1500" })).toBe(1500);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "0" })).toBe(0);
  });

  it("treats 0/false/no/off as wake disabled and everything else enabled", () => {
    for (const off of ["0", "false", "no", "off", "OFF", " no "]) {
      expect(parseWakeEnabled({ PI_BG_WAKE: off })).toBe(false);
    }
    expect(parseWakeEnabled({})).toBe(true);
    expect(parseWakeEnabled({ PI_BG_WAKE: "1" })).toBe(true);
    expect(parseWakeEnabled({ PI_BG_WAKE: "yes" })).toBe(true);
  });
});

describe("capResultText", () => {
  it("passes short text through untouched", () => {
    expect(capResultText("short", "/tmp/s", "bg-1")).toEqual({ text: "short" });
  });

  it("stashes over-cap text beside the session and points at the file", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "bg-cap-"));
    const long = "x".repeat(WAKE_TEXT_CAP + 100);
    const { text, resultPath } = capResultText(long, sessionDir, "bg-7");
    expect(resultPath).toBe(stashPath(sessionDir, "bg-7"));
    expect(text.startsWith("x".repeat(WAKE_TEXT_CAP))).toBe(true);
    expect(text).toContain(`full reply: ${resultPath}`);
    expect(readFileSync(resultPath!, "utf8")).toBe(long);
  });

  it("hard-truncates when there is no session dir, saying so", () => {
    const long = "y".repeat(WAKE_TEXT_CAP + 10);
    const { text, resultPath } = capResultText(long, undefined, "bg-1");
    expect(resultPath).toBeUndefined();
    expect(text).toContain("no session dir");
    expect(text.length).toBeLessThanOrEqual(WAKE_TEXT_CAP + 100);
  });

  it("fails open when the stash write fails", () => {
    // A file where a directory is needed: mkdir fails, the text survives.
    const notADir = join(tmpdir(), `bg-notdir-${Date.now()}`);
    writeFileSync(notADir, "occupied");
    const long = "z".repeat(WAKE_TEXT_CAP + 10);
    const { text } = capResultText(long, notADir, "bg-1");
    expect(text).toContain("stashing the full reply failed");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(3_900_000)).toBe("1h5m");
  });
});

describe("formatSubagentWake", () => {
  it("formats completion with usage and body", () => {
    const text = formatSubagentWake("reviewer", "bg-1", {
      ok: true,
      durationMs: 252_000,
      text: "All clear.",
      usageLine: "105 tokens (100 in / 5 out), $0.120",
    });
    expect(text).toContain('[background] subagent "reviewer" (bg-1, 4m12s) completed');
    expect(text).toContain("105 tokens");
    expect(text).toContain("All clear.");
  });

  it("formats failure with the error message", () => {
    const text = formatSubagentWake("reviewer", "bg-2", { ok: false, durationMs: 5_000, text: "boom happened" });
    expect(text).toContain('[background] subagent "reviewer" (bg-2, 5s) failed');
    expect(text).toContain("boom happened");
  });
});

describe("createBackgroundRegistry", () => {
  function makeDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    let tick = 1000;
    const registry = createBackgroundRegistry({
      sendUserMessage,
      notify,
      setStatus,
      now: () => (tick += 1000),
    });
    return { registry, sendUserMessage, notify, setStatus };
  }

  it("swallows a throwing wake channel instead of surfacing an unhandled rejection", () => {
    const registry = createBackgroundRegistry({
      sendUserMessage: () => {
        throw new Error("channel down");
      },
      notify: vi.fn(),
      setStatus: vi.fn(),
      now: () => 1000,
    });
    const id = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    expect(() => registry.complete(id, { ok: true, text: "wake" })).not.toThrow();
    expect(registry.running()).toHaveLength(0); // still consumed fire-once
  });

  it("adopts with sequential ids and lists running tasks oldest first", () => {
    const { registry } = makeDeps();
    const a = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    const b = registry.adopt({ name: "b", kind: "subagent", kill: () => undefined });
    expect(a).toBe("bg-1");
    expect(b).toBe("bg-2");
    expect(registry.running().map((t) => t.id)).toEqual(["bg-1", "bg-2"]);
    expect(registry.running()[0]).toMatchObject({ id: "bg-1", name: "a", kind: "subagent", state: "running" });
  });

  it("completes with exactly one wake and notification, at the right levels", () => {
    const { registry, sendUserMessage, notify } = makeDeps();
    const id = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    registry.complete(id, { ok: true, text: "done wake" });
    registry.complete(id, { ok: true, text: "done wake" }); // fire-once: ignored
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("done wake");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("done wake"), "info");
    expect(registry.running()).toHaveLength(0);
  });

  it("notifies failures at error level", () => {
    const { registry, notify } = makeDeps();
    const id = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    registry.complete(id, { ok: false, text: "failed wake" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed wake"), "error");
  });

  it("ignores completion for unknown tasks", () => {
    const { registry, sendUserMessage } = makeDeps();
    registry.complete("bg-nope", { ok: true, text: "wake" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("suppresses the wake but keeps the notification when wakes are disabled", () => {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createBackgroundRegistry({ sendUserMessage, notify, wakeEnabled: false });
    const id = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    registry.complete(id, { ok: true, text: "wake" });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("killAll kills running children, skips finished ones, silences their wakes, and returns the count", () => {
    const { registry, sendUserMessage } = makeDeps();
    const kills: string[] = [];
    const id1 = registry.adopt({ name: "a", kind: "subagent", kill: () => kills.push("a") });
    const id2 = registry.adopt({ name: "b", kind: "subagent", kill: () => kills.push("b") });
    registry.complete(id2, { ok: true, text: "b done" });
    expect(registry.killAll()).toBe(1); // b already finished
    expect(kills).toEqual(["a"]);
    expect(sendUserMessage).toHaveBeenCalledTimes(1); // only b's completion
    // The killed child's close event lands after killAll: no wake for it.
    registry.complete(id1, { ok: false, text: "a was killed" });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(registry.killAll()).toBe(0); // nothing left running
  });

  it("maintains the footer status across transitions", () => {
    const { registry, setStatus } = makeDeps();
    const id1 = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    registry.adopt({ name: "b", kind: "subagent", kill: () => undefined });
    expect(setStatus).toHaveBeenLastCalledWith("bg", "2 running");
    registry.complete(id1, { ok: true, text: "wake" });
    expect(setStatus).toHaveBeenLastCalledWith("bg", "1 running");
    registry.killAll();
    expect(setStatus).toHaveBeenLastCalledWith("bg", undefined);
  });
});

describe("stashPath", () => {
  it("nests under bg/ beside the session", () => {
    expect(stashPath("/sessions/s1", "bg-3")).toBe(join("/sessions/s1", "bg", "bg-3.txt"));
  });
});

describe("createBgTool", () => {
  interface FakeBash {
    killed: boolean;
    emitData(chunk: string): void;
    close(code: number | null): void;
    fail(error: Error): void;
  }

  function fakeBash(): FakeBash & import("../lib/background").BashChild {
    const closers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const failers: Array<(error: Error) => void> = [];
    const data: Array<(chunk: string) => void> = [];
    const fake = {
      stdout: { on: (_event: "data", cb: (chunk: string) => void) => void data.push(cb) },
      stderr: { on: () => undefined },
      on: (event: string, cb: (...args: never[]) => void) => {
        if (event === "close") closers.push(cb as never);
        else if (event === "error") failers.push(cb as never);
      },
      killed: false,
      // A real killed process emits close; the fake mirrors that so kill paths settle.
      kill: () => {
        fake.killed = true;
        setImmediate(() => closers.forEach((h) => h(null, "SIGKILL")));
      },
      emitData: (chunk: string) => data.forEach((h) => h(chunk)),
      close: (code: number | null) => closers.forEach((h) => h(code, null)),
      fail: (error: Error) => failers.forEach((h) => h(error)),
    };
    return fake as unknown as FakeBash & import("../lib/background").BashChild;
  }

  function toolDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createBackgroundRegistry({ sendUserMessage, notify, setStatus: vi.fn() });
    return { sendUserMessage, notify, registry };
  }

  const CTX = { sessionManager: { getSessionDir: () => undefined } } as never;

  it("returns a task id immediately and adopts the still-running child", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    const result = await tool.execute("1", { command: "sleep 30" }, undefined, undefined, CTX);
    expect(result.details).toEqual({ kind: "bash", id: "bg-1" });
    expect(child.killed).toBe(false);
    expect(d.registry.running()[0]).toMatchObject({ id: "bg-1", kind: "bash", name: "sleep 30" });
  });

  it("wakes with exit status and the output tail on a clean exit", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "echo hi" }, undefined, undefined, CTX);
    child.emitData("hi\n");
    child.close(0);
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain(`[background] bash (bg-1, 0s) exited 0 — echo hi`);
    expect(wake).toContain("hi");
    expect(d.notify).toHaveBeenCalledWith(wake.split("\n")[0], "info");
    expect(d.registry.running()).toHaveLength(0);
  });

  it("marks nonzero exits as failures", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "false" }, undefined, undefined, CTX);
    child.emitData("boom\n");
    child.close(3);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 3 — false");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 3"), "error");
  });

  it("SIGKILLs on timeout and reports it as a failure", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child, defaultTimeoutMs: 15 });
    await tool.execute("1", { command: "hang" }, undefined, undefined, CTX);
    await new Promise((r) => setTimeout(r, 40));
    expect(child.killed).toBe(true);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("timed out after 0s — hang");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("timed out"), "error");
  });

  it("returns an error result without adopting when spawn throws", async () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, {
      spawnFn: () => {
        throw new Error("no bash");
      },
    });
    const result = await tool.execute("1", { command: "x" }, undefined, undefined, CTX);
    expect(result.isError).toBe(true);
    expect(d.registry.running()).toHaveLength(0);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty command", async () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, { spawnFn: () => fakeBash() });
    const result = await tool.execute("1", { command: "   " }, undefined, undefined, CTX);
    expect(result.isError).toBe(true);
    expect(d.registry.running()).toHaveLength(0);
  });

  it("keeps a rolling tail, caps the wake, and stashes the overflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tool-"));
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "spew" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    child.emitData(`${"x".repeat(50)}HEAD${"x".repeat(BASH_TAIL_CAP)}`);
    child.close(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake.length).toBeLessThan(BASH_TAIL_CAP); // capped well below the in-memory tail
    expect(wake).toContain("full reply"); // stash pointer wording
    const stashed = readFileSync(stashPath(dir, "bg-1"), "utf8");
    expect(stashed.length).toBe(BASH_TAIL_CAP);
    expect(stashed.startsWith("x")).toBe(true);
    expect(stashed.includes("HEAD")).toBe(false); // rolled out of the tail window
  });

  it("sends no wake for a task killed by shutdown", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "long" }, undefined, undefined, CTX);
    d.registry.killAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });
});
