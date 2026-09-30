import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BASH_TAIL_CAP,
  capResultText,
  clampTimeoutMs,
  createBackgroundRegistry,
  createBgTool,
  createKillTaskTool,
  createTasksCommand,
  DEFAULT_BG_AFTER_MS,
  MAX_TIMEOUT_MS,
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
    emitData(chunk: string | Buffer): void;
    emitErr(chunk: string): void;
    close(code: number | null): void;
    closeSignaled(): void;
    fail(error: Error): void;
  }

  function fakeBash(): FakeBash & import("../lib/background").BashChild {
    const closers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const failers: Array<(error: Error) => void> = [];
    const data: Array<(chunk: string | Buffer) => void> = [];
    const errs: Array<(chunk: string) => void> = [];
    const fake = {
      stdout: { on: (_event: "data", cb: (chunk: string | Buffer) => void) => void data.push(cb) },
      stderr: { on: (_event: "data", cb: (chunk: string) => void) => void errs.push(cb) },
      on: (event: string, cb: (...args: never[]) => void) => {
        if (event === "close") closers.push(cb as never);
        else if (event === "error") failers.push(cb as never);
      },
      pid: 4242,
      killed: false,
      // A real killed process emits close; the fake mirrors that so kill paths settle.
      kill: () => {
        fake.killed = true;
        setImmediate(() => closers.forEach((h) => h(null, "SIGKILL")));
      },
      emitData: (chunk: string | Buffer) => data.forEach((h) => h(chunk)),
      emitErr: (chunk: string) => errs.forEach((h) => h(chunk)),
      close: (code: number | null) => closers.forEach((h) => h(code, null)),
      closeSignaled: () => closers.forEach((h) => h(null, "SIGTERM")),
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
    expect(wake).toContain("full output"); // stash pointer wording
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

  it("leaves no orphaned stash when a killed task had over-cap output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-kill-"));
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "spew" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    child.emitData("x".repeat(BASH_TAIL_CAP));
    d.registry.killAll(); // marks killed before the close event lands
    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(stashPath(dir, "bg-1"))).toBe(false);
  });

  it("keeps multi-byte UTF-8 intact across chunk boundaries", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "cjk" }, undefined, undefined, CTX);
    // Split "日日日" mid-codepoint: byte 4 falls inside the second character.
    const whole = Buffer.from("日日日");
    child.emitData(whole.subarray(0, 4));
    child.emitData(whole.subarray(4));
    child.close(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("日日日");
    expect(wake).not.toContain("\uFFFD");
  });

  it("interleaves stdout and stderr into one tail", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "both" }, undefined, undefined, CTX);
    child.emitData("out-");
    child.emitErr("err-");
    child.emitData("done\n");
    child.close(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("out-err-done");
  });

  it("reports an async spawn error and settles once despite a trailing close", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child });
    await tool.execute("1", { command: "enoent" }, undefined, undefined, CTX);
    child.fail(new Error("spawn enoent ENOENT"));
    child.close(null); // real error paths are followed by close — fire-once absorbs it
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("failed: spawn enoent ENOENT");
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("labels an external signal kill without the timeout wording", async () => {
    const d = toolDeps();
    const child = fakeBash();
    const tool = createBgTool(d.registry, { spawnFn: () => child, defaultTimeoutMs: 5_000_000 });
    await tool.execute("1", { command: "victim" }, undefined, undefined, CTX);
    child.closeSignaled(); // SIGTERM from outside, not our timeout
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("killed (SIGTERM) — victim");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("killed (SIGTERM)"), "error");
  });

  it("honors timeout_ms, clamps overflow to schedulable range, and falls back on invalid values", async () => {
    // Overflow would clamp inside Node to 1ms — an instant kill.
    const sane = toolDeps();
    const saneChild = fakeBash();
    const toolA = createBgTool(sane.registry, { spawnFn: () => saneChild });
    await toolA.execute("1", { command: "a", timeout_ms: 1e10 }, undefined, undefined, CTX);
    await new Promise((r) => setTimeout(r, 25));
    expect(saneChild.killed).toBe(false); // ~24 days, not 1ms
    sane.registry.killAll();

    // Invalid values fall back to the tool default (15ms here → timeout).
    const fallback = toolDeps();
    const fbChild = fakeBash();
    const toolB = createBgTool(fallback.registry, { spawnFn: () => fbChild, defaultTimeoutMs: 15 });
    await toolB.execute("1", { command: "b", timeout_ms: -5 }, undefined, undefined, CTX);
    await new Promise((r) => setTimeout(r, 40));
    expect(fbChild.killed).toBe(true);
    const wake = fallback.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("timed out after 0s");
  });

  it("runs a real command end to end through Node's ChildProcess", async () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, { defaultTimeoutMs: 10_000 });
    const dir = mkdtempSync(join(tmpdir(), "bg-real-"));
    const result = await tool.execute("1", { command: "echo real-hi" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    expect(result.details).toEqual({ kind: "bash", id: "bg-1" });
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 0 — echo real-hi");
    expect(wake).toContain("real-hi");
  }, 10_000);
});

describe("clampTimeoutMs", () => {
  it("keeps schedulable values, clamps overflow, and falls back on invalid input", () => {
    expect(clampTimeoutMs(5_000, 1_000)).toBe(5_000);
    expect(clampTimeoutMs(1.9, 1_000)).toBe(1); // fractional ms floor to 1
    expect(clampTimeoutMs(1e12, 1_000)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimeoutMs(-5, 1_000)).toBe(1_000);
    expect(clampTimeoutMs(Number.NaN, 1_000)).toBe(1_000);
    expect(clampTimeoutMs(undefined, 1_000)).toBe(1_000);
  });
});

describe("kill and control surfaces", () => {
  function controlDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createBackgroundRegistry({ sendUserMessage, notify, setStatus: vi.fn(), now: () => 1_000 });
    return { sendUserMessage, notify, registry };
  }

  it("registry.kill kills a running task by id and silences its wake", () => {
    const d = controlDeps();
    const kills: string[] = [];
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => kills.push("a") });
    expect(d.registry.kill(id)).toBe(true);
    expect(kills).toEqual(["a"]);
    d.registry.complete(id, { ok: true, text: "late" }); // close event after the kill
    expect(d.sendUserMessage).not.toHaveBeenCalled();
    expect(d.registry.kill(id)).toBe(false); // already killed
    expect(d.registry.kill("bg-99")).toBe(false); // unknown
  });

  it("kill_task kills a bg task and never wakes it", async () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    const onKilled = vi.fn();
    const bg = createBgTool(d.registry, { spawnFn: () => child });
    const killTool = createKillTaskTool(d.registry, { onKilled });
    await bg.execute("1", { command: "spin" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const result = await killTool.execute("2", { id: "bg-1" }, undefined, undefined, undefined);
    expect(result.details).toEqual({ killed: true, id: "bg-1" });
    expect(onKilled).toHaveBeenCalledWith("bg-1");
    await new Promise((r) => setTimeout(r, 10));
    expect(child.killed).toBe(true);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("kill_task errors with the running list when the id is unknown", async () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    const bg = createBgTool(d.registry, { spawnFn: () => child });
    await bg.execute("1", { command: "live" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const killTool = createKillTaskTool(d.registry);
    const result = await killTool.execute("2", { id: "bg-9" }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No running task bg-9");
    expect(text).toContain("bg-1 (bash,");
    expect(child.killed).toBe(false);
  });

  it("/tasks lists running tasks and kills by id argument", () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    void createBgTool(d.registry, { spawnFn: () => child }).execute("1", { command: "idle" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const cmd = createTasksCommand(d.registry, { now: () => 4_000 });
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    cmd.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("bg-1 (bash, 3s) idle"), "info");

    cmd.handler("bg-1", ctx);
    expect(notify).toHaveBeenCalledWith("Killed bg-1. Its wake will not arrive.", "warning");
    expect(child.killed).toBe(true);

    cmd.handler("bg-8", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No running task bg-8"), "error");
  });

  it("kill_task and /tasks work on adopted subagent tasks too", () => {
    const d = controlDeps();
    const id = d.registry.adopt({ name: "reviewer", kind: "subagent", kill: () => undefined });
    const cmd = createTasksCommand(d.registry);
    const notify = vi.fn();
    cmd.handler("", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(`${id} (subagent,`), "info");
  });
});

/** Shared minimal bash fake for the control-surface tests. */
function fakeBashForControl() {
  const closers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const data: Array<(chunk: string) => void> = [];
  const child = {
    stdout: { on: (_event: "data", cb: (chunk: string) => void) => void data.push(cb) },
    stderr: { on: () => undefined },
    on: (event: string, cb: (...args: never[]) => void) => {
      if (event === "close") closers.push(cb as never);
    },
    pid: 4242,
    killed: false,
    kill: () => {
      child.killed = true;
      setImmediate(() => closers.forEach((h) => h(null, "SIGKILL")));
    },
  };
  return child as unknown as import("../lib/background").BashChild & { killed: boolean };
}
