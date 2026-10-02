import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  BASH_TAIL_CAP,
  bashCommandHead,
  buildBashEnv,
  capResultText,
  clampTimeoutMs,
  createBackgroundRegistry,
  createBgTool,
  createKillTaskTool,
  createTasksCommand,
  DEFAULT_BG_AFTER_MS,
  formatDuration,
  formatSubagentWake,
  MAX_TIMEOUT_MS,
  outputLogPath,
  parseBgAfterMs,
  parseWakeEnabled,
  piAgentDir,
  stashPath,
  tempOutputLogPath,
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

describe("buildBashEnv", () => {
  it("prepends pi's bin dir to PATH when missing and never duplicates it", () => {
    expect(buildBashEnv({ PATH: "/usr/bin" }, { agentDir: "/agent" }).PATH).toBe("/agent/bin:/usr/bin");
    expect(buildBashEnv({ PATH: "/agent/bin:/usr/bin" }, { agentDir: "/agent" }).PATH).toBe("/agent/bin:/usr/bin");
  });

  it("strips inherited PI_* session vars and re-adds this session's", () => {
    const env = buildBashEnv(
      { PI_SESSION_ID: "stale", PI_MODEL: "old", PI_REASONING_LEVEL: "high", PATH: "/usr/bin" },
      { sessionId: "s1", sessionFile: "/s.jsonl", provider: "p1", model: "m1" },
    );
    expect(env.PI_SESSION_ID).toBe("s1");
    expect(env.PI_SESSION_FILE).toBe("/s.jsonl");
    expect(env.PI_PROVIDER).toBe("p1");
    expect(env.PI_MODEL).toBe("m1");
    expect(env.PI_REASONING_LEVEL).toBeUndefined(); // not re-added without a level
  });

  it("omits provider and model unless both are present", () => {
    const env = buildBashEnv({}, { provider: "p1", model: "m1", thinkingLevel: "low" });
    expect(env.PI_PROVIDER).toBe("p1");
    expect(env.PI_MODEL).toBe("m1");
    expect(env.PI_REASONING_LEVEL).toBe("low");
    expect(buildBashEnv({}, { model: "m1" }).PI_MODEL).toBeUndefined();
    expect(buildBashEnv({}, { provider: "p1" }).PI_PROVIDER).toBeUndefined();
  });

  it("leaves the base env otherwise untouched", () => {
    expect(buildBashEnv({ HOME: "/home/x" }, {})).toEqual({ HOME: "/home/x" });
  });
});

describe("piAgentDir", () => {
  it("defaults to ~/.pi/agent and honors PI_CODING_AGENT_DIR including ~", () => {
    expect(piAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/.custom" })).toBe(join(homedir(), ".custom"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/abs/dir" })).toBe("/abs/dir");
  });
});

describe("output log paths", () => {
  it("nests command logs under bg/ beside the session", () => {
    expect(outputLogPath("/sessions/s1", "bg-3")).toBe(join("/sessions/s1", "bg", "bg-3.log"));
  });

  it("falls back to a temp file named after the task", () => {
    expect(tempOutputLogPath("bg-3")).toBe(join(tmpdir(), "pi-bg-bg-3.log"));
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
  interface FakeOps extends BashOperations {
    last: { command: string; cwd: string; timeout?: number; env: NodeJS.ProcessEnv } | undefined;
    aborted: boolean;
    emit(chunk: string | Buffer): void;
    exit(code: number | null): void;
    fail(message: string): void;
  }

  /**
   * Hand-rolled fake of pi's local BashOperations. It mimics the contract the
   * tool relies on: data chunks via onData, resolution with the exit code
   * (signal kills already mapped to 128+signal by pi), rejection with
   * "aborted"/"timeout:…"/spawn errors.
   */
  function fakeBashOps(): FakeOps {
    let onData: ((chunk: Buffer) => void) | undefined;
    let resolve: ((r: { exitCode: number | null }) => void) | undefined;
    let reject: ((e: Error) => void) | undefined;
    const fake: FakeOps = {
      last: undefined,
      aborted: false,
      exec: (command, cwd, { onData: d, signal, timeout, env }) => {
        fake.last = { command, cwd, timeout, env: env ?? {} };
        onData = d;
        return new Promise((res, rej) => {
          resolve = res;
          reject = rej;
          signal?.addEventListener(
            "abort",
            () => {
              fake.aborted = true;
              rej(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      emit: (chunk) => onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      // resolve/reject are captured; resolving triggers the tool's settle on the
      // next microtask, so exit/fail return a promise that resolves after it.
      exit: (code) => {
        resolve?.({ exitCode: code });
        return new Promise<void>((r) => setImmediate(r));
      },
      fail: (message) => {
        reject?.(new Error(message));
        return new Promise<void>((r) => setImmediate(r));
      },
    };
    return fake;
  }

  function toolDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createBackgroundRegistry({ sendUserMessage, notify, setStatus: vi.fn() });
    return { sendUserMessage, notify, registry };
  }

  const CTX = { sessionManager: { getSessionDir: () => undefined } } as never;

  it("teaches the wake contract in its description and guidelines", () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, { operations: fakeBashOps() });
    expect(tool.description).toContain("even mid-run");
    expect(tool.description).toContain("Never sleep or poll");
    expect(tool.promptGuidelines.join("\n")).toContain("never sleep or poll");
  });

  it("returns a task id immediately and adopts the still-running command", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "sleep 30" }, undefined, undefined, CTX);
    expect(result.details).toEqual({ kind: "bash", id: "bg-1" });
    expect(ops.last?.command).toBe("sleep 30");
    expect(ops.aborted).toBe(false);
    expect(d.registry.running()[0]).toMatchObject({ id: "bg-1", kind: "bash", name: "sleep 30" });
    // The result text carries the delivery contract: the wake steers in as
    // the next message, even mid-run — never sleep or poll for it.
    expect(result.content[0].text).toContain("delivered to you automatically");
    expect(result.content[0].text).toContain("even mid-run");
    expect(result.content[0].text).toContain("never sleep or poll");
  });

  it("wakes with exit status and the output tail on a clean exit", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "echo hi" }, undefined, undefined, CTX);
    ops.emit("hi\n");
    await ops.exit(0);
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain(`[background] bash (bg-1, 0s) exited 0 — echo hi`);
    expect(wake).toContain("hi");
    expect(d.notify).toHaveBeenCalledWith(wake.split("\n")[0], "info");
    expect(d.registry.running()).toHaveLength(0);
  });

  it("marks nonzero exits as failures", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "false" }, undefined, undefined, CTX);
    ops.emit("boom\n");
    await ops.exit(3);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 3 — false");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 3"), "error");
  });

  it("passes a clamped timeout to the executor and reports timeout rejections", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops, defaultTimeoutMs: 15 });
    await tool.execute("1", { command: "hang" }, undefined, undefined, CTX);
    expect(ops.last?.timeout).toBe(0.015); // executor takes seconds
    await ops.fail("timeout:0.015");
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("timed out after 0s — hang");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("timed out"), "error");
  });

  it("settles as a failure when the executor throws synchronously", async () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, {
      operations: {
        exec: () => {
          throw new Error("no bash");
        },
      },
    });
    const result = await tool.execute("1", { command: "x" }, undefined, undefined, CTX);
    expect(result.details).toMatchObject({ kind: "bash" });
    await new Promise((r) => setTimeout(r, 10));
    expect(d.registry.running()).toHaveLength(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("failed: no bash");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("failed: no bash"), "error");
  });

  it("rejects a missing working directory before adopting, like the bash tool", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "x" }, undefined, undefined, {
      cwd: "/no/such/bg-dir",
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Working directory does not exist");
    expect(ops.last).toBeUndefined();
    expect(d.registry.running()).toHaveLength(0);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty command", async () => {
    const d = toolDeps();
    const tool = createBgTool(d.registry, { operations: fakeBashOps() });
    const result = await tool.execute("1", { command: "   " }, undefined, undefined, CTX);
    expect(result.isError).toBe(true);
    expect(d.registry.running()).toHaveLength(0);
  });

  it("exposes the session environment like the built-in bash tool", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "x" }, undefined, undefined, {
      sessionManager: {
        getSessionDir: () => undefined,
        getSessionId: () => "s-1",
        getSessionFile: () => "/sessions/s-1.jsonl",
      },
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "medium",
    } as never);
    const env = ops.last?.env ?? {};
    expect(env.PI_SESSION_ID).toBe("s-1");
    expect(env.PI_SESSION_FILE).toBe("/sessions/s-1.jsonl");
    expect(env.PI_PROVIDER).toBe("anthropic");
    expect(env.PI_MODEL).toBe("claude-x");
    expect(env.PI_REASONING_LEVEL).toBe("medium");
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    expect(env[pathKey]).toContain(join(homedir(), ".pi", "agent", "bin"));
  });

  it("keeps a rolling tail, caps the wake, and stashes the full output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tool-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "spew" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    ops.emit(`${"x".repeat(50)}HEAD${"x".repeat(BASH_TAIL_CAP)}`);
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake.length).toBeLessThan(BASH_TAIL_CAP); // inline body capped to the wake budget
    expect(wake).toContain("full output"); // stash pointer wording
    // The log is written through an async stream; wait for it to flush.
    await vi.waitFor(() => {
      const stashed = readFileSync(outputLogPath(dir, "bg-1"), "utf8");
      expect(stashed).toContain("HEAD"); // the full output is stashed, not just the tail
      expect(stashed).toContain("x".repeat(100));
    });
  });

  it("sends no wake for a task killed by shutdown", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "long" }, undefined, undefined, CTX);
    d.registry.killAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(ops.aborted).toBe(true);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves no orphaned log when a killed task had over-cap output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-kill-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "spew" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    ops.emit("x".repeat(BASH_TAIL_CAP)); // > wake cap → the log is open
    // The log is created asynchronously; wait for it before killing so the
    // cleanup path — not async creation timing — is what we're testing.
    await vi.waitFor(() => expect(existsSync(outputLogPath(dir, "bg-1"))).toBe(true));
    d.registry.killAll(); // marks killed, tears the log down before the abort lands
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(outputLogPath(dir, "bg-1"))).toBe(false);
  });

  it("does not resurrect the log from a chunk that arrives after a kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-kill2-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "spew" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => dir },
    } as never);
    ops.emit("x".repeat(BASH_TAIL_CAP)); // opens the log
    await vi.waitFor(() => expect(existsSync(outputLogPath(dir, "bg-1"))).toBe(true));
    d.registry.killAll(); // marks killed, tears the log down
    ops.emit("more"); // a delayed pipe read would race in here
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(outputLogPath(dir, "bg-1"))).toBe(false);
  });

  it("does not claim the output was lost when truncation is line-based under the cap", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "lines" }, undefined, undefined, CTX);
    // >2000 lines but <4000 bytes: the line cap truncates the wake, but no log
    // opens, so the wake must not say the output was lost.
    ops.emit("\n".repeat(2001));
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).not.toContain("could not save the full output");
  });

  it("keeps multi-byte UTF-8 intact across chunk boundaries", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "cjk" }, undefined, undefined, CTX);
    // Split "日日日" mid-codepoint: byte 4 falls inside the second character.
    const whole = Buffer.from("日日日");
    ops.emit(whole.subarray(0, 4));
    ops.emit(whole.subarray(4));
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("日日日");
    expect(wake).not.toContain("\uFFFD");
  });

  it("interleaves stdout and stderr into one tail", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "both" }, undefined, undefined, CTX);
    // pi's local ops route both stdout and stderr through the single onData.
    ops.emit("out-");
    ops.emit("err-");
    ops.emit("done\n");
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("out-err-done");
  });

  it("reports an executor error and settles once despite a trailing exit", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "enoent" }, undefined, undefined, CTX);
    ops.fail("spawn enoent ENOENT");
    await ops.exit(0); // real error paths are followed by an exit — fire-once absorbs it
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("failed: spawn enoent ENOENT");
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("reports signal kills by their 128+signal exit code, like the bash tool", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "victim" }, undefined, undefined, CTX);
    await ops.exit(143); // SIGTERM: pi's local ops resolve 128 + 15, not a raw signal
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 143 — victim");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 143"), "error");
  });

  it("labels a codeless termination after the executor gives up", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "zombie" }, undefined, undefined, CTX);
    await ops.exit(null);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("terminated without an exit code");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("terminated"), "error");
  });

  it("aborts the task when the tool call is interrupted", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBgTool(d.registry, { operations: ops });
    const ac = new AbortController();
    await tool.execute("1", { command: "long" }, ac.signal, undefined, CTX);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(ops.aborted).toBe(true);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("aborted");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("aborted"), "error");
  });

  it("honors timeout_ms, clamps overflow to schedulable range, and falls back on invalid values", async () => {
    // Overflow would clamp inside Node to 1ms — an instant kill.
    const sane = toolDeps();
    const saneOps = fakeBashOps();
    const toolA = createBgTool(sane.registry, { operations: saneOps });
    await toolA.execute("1", { command: "a", timeout_ms: 1e10 }, undefined, undefined, CTX);
    expect(saneOps.last?.timeout).toBe(MAX_TIMEOUT_MS / 1000); // ~24 days, not 1ms
    sane.registry.killAll();

    // Invalid values fall back to the tool default (15ms here → 0.015s).
    const fallback = toolDeps();
    const fbOps = fakeBashOps();
    const toolB = createBgTool(fallback.registry, { operations: fbOps, defaultTimeoutMs: 15 });
    await toolB.execute("1", { command: "b", timeout_ms: -5 }, undefined, undefined, CTX);
    expect(fbOps.last?.timeout).toBe(0.015);
    await fbOps.fail("timeout:0.015");
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
    const bg = createBgTool(d.registry, { operations: child });
    const killTool = createKillTaskTool(d.registry, { onKilled });
    await bg.execute("1", { command: "spin" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const result = await killTool.execute("2", { id: "bg-1" }, undefined, undefined, undefined);
    expect(result.details).toEqual({ killed: true, id: "bg-1" });
    expect(onKilled).toHaveBeenCalledWith("bg-1");
    await new Promise((r) => setTimeout(r, 10));
    expect(child.aborted).toBe(true);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("kill_task errors with the running list when the id is unknown", async () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    const bg = createBgTool(d.registry, { operations: child });
    await bg.execute("1", { command: "live" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const killTool = createKillTaskTool(d.registry);
    const result = await killTool.execute("2", { id: "bg-9" }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No running task bg-9");
    expect(text).toContain("bg-1 (bash,");
    expect(child.aborted).toBe(false);
  });

  it("/tasks lists, kills by `kill <id>`, kills all, and teaches its grammar on misuse", () => {
    const d = controlDeps();
    const childA = fakeBashForControl();
    const childB = fakeBashForControl();
    const bg = createBgTool(d.registry, { operations: childA });
    const bg2 = createBgTool(d.registry, { operations: childB });
    void bg.execute("1", { command: "a" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    void bg2.execute("2", { command: "b" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const cmd = createTasksCommand(d.registry, { now: () => 4_000 });
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    cmd.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("bg-1 (bash, 3s) a"), "info");

    // Bare id — the old form — now teaches the grammar instead of killing.
    cmd.handler("bg-1", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /tasks"), "info");
    expect(childA.aborted).toBe(false);

    cmd.handler("kill bg-8", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No running task bg-8"), "error");

    cmd.handler("kill bg-1", ctx);
    expect(notify).toHaveBeenCalledWith("Killed bg-1. Its wake will not arrive.", "warning");
    expect(childA.aborted).toBe(true);

    cmd.handler("kill all", ctx);
    expect(notify).toHaveBeenCalledWith("Killed 1 task. Their wakes will not arrive.", "warning");
    expect(childB.aborted).toBe(true);

    cmd.handler("kill all", ctx); // nothing left
    expect(notify).toHaveBeenCalledWith("No running tasks.", "info");

    cmd.handler("kill", ctx); // missing target
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /tasks"), "info");
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

/** Shared minimal bash-operations fake for the control-surface tests. */
function fakeBashForControl() {
  const fake = {
    aborted: false,
    exec: (_command: string, _cwd: string, { signal }: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        // pi's local ops kill the tree and reject with "aborted" on signal.
        signal?.addEventListener(
          "abort",
          () => {
            fake.aborted = true;
            rej(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  return fake as unknown as import("@earendil-works/pi-coding-agent").BashOperations & { aborted: boolean };
}

describe("bashCommandHead", () => {
  it("collapses whitespace so commands cannot forge extra header lines", () => {
    expect(bashCommandHead("a\nb  c\td")).toBe("a b c d");
    expect(bashCommandHead("   padded   ")).toBe("padded");
  });

  it("caps at 80 code points without splitting surrogate pairs", () => {
    expect(bashCommandHead("x".repeat(100))).toHaveLength(80);
    const emoji = "🎉".repeat(81); // 162 UTF-16 units, 81 code points
    const head = bashCommandHead(emoji);
    expect(Array.from(head)).toHaveLength(80);
    // A lone surrogate makes encodeURIComponent throw — the old slice did exactly that.
    expect(() => encodeURIComponent(head)).not.toThrow();
  });
});

describe("bg with real bash commands", () => {
  function realTool(sessionDir?: string) {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const registry = createBackgroundRegistry({ sendUserMessage, notify, setStatus });
    const tool = createBgTool(registry, { defaultTimeoutMs: 30_000 });
    const ctx = {
      sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "real-test" },
    };
    return { sendUserMessage, notify, setStatus, registry, tool, ctx };
  }

  type RealTool = ReturnType<typeof realTool>;

  async function runReal(d: RealTool, command: string) {
    const result = await d.tool.execute("1", { command }, undefined, undefined, d.ctx);
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    return {
      details: result.details as { id: string },
      wake: d.sendUserMessage.mock.calls[0][0] as string,
    };
  }

  it("preserves multi-line output in the tail", async () => {
    const { wake } = await runReal(realTool(), "printf 'one\\ntwo\\nthree\\n'");
    expect(wake).toContain("one\ntwo\nthree");
  }, 15_000);

  it("keeps unicode intact through real pipes", async () => {
    const { wake } = await runReal(realTool(), "printf 'héllo 世界 🎉\\n'");
    expect(wake).toContain("héllo 世界 🎉");
  }, 15_000);

  it("captures stderr-only commands", async () => {
    const { wake } = await runReal(realTool(), "printf 'only-stderr\\n' >&2");
    expect(wake).toContain("only-stderr");
  }, 15_000);

  it("stays header-only for quiet commands", async () => {
    const { wake } = await runReal(realTool(), "true");
    expect(wake).toMatch(/exited 0 — true$/);
    expect(wake).not.toContain("\n"); // no body, no stash pointer
  }, 15_000);

  it("preserves exact exit codes", async () => {
    const d = realTool();
    const { wake } = await runReal(d, "exit 42");
    expect(wake).toContain("exited 42 — exit 42");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 42"), "error");
  }, 15_000);

  it("reports a self-terminated command by its 128+signal exit code, like the bash tool", async () => {
    const { wake } = await runReal(realTool(), "kill -TERM $$");
    expect(wake).toContain("exited 143");
  }, 15_000);

  it("runs pipelines and compound commands through bash -c", async () => {
    const { wake } = await runReal(realTool(), "echo pipeline | tr a-z A-Z && echo compound");
    expect(wake).toContain("PIPELINE");
    expect(wake).toContain("compound");
  }, 15_000);

  it("runs in the session cwd when ctx provides one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-cwd-"));
    const d = realTool();
    // The real ExtensionToolContext carries cwd; the loose lib type accepts it.
    const result = await d.tool.execute("1", { command: "pwd" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
      cwd: dir,
    } as never);
    expect(result.details).toMatchObject({ kind: "bash" });
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain(dir);
  }, 15_000);

  it("replaces invalid UTF-8 bytes instead of corrupting the tail", async () => {
    const { wake } = await runReal(realTool() as never, "printf '\\xff\\xfe\\x80'");
    expect(wake).toContain("\uFFFD");
    expect(wake).toContain("exited 0");
  }, 15_000);

  it("rolls a real large output into the tail and stashes the full output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-big-"));
    const d = realTool(dir);
    const { wake, details } = await runReal(d, "seq 1 5000");
    expect(wake).toContain("full output"); // stash pointer
    expect(wake.length).toBeLessThan(6_000); // capped inline body
    await vi.waitFor(() => {
      const stashed = readFileSync(outputLogPath(dir, details.id), "utf8");
      expect(stashed).toContain("4999\n5000"); // the end survives the roll
      expect(stashed.startsWith("1\n")).toBe(true); // the full output is stashed, start and all
    });
  }, 15_000);

  it("trims whitespace-padded commands before naming and running them", async () => {
    const { wake } = await runReal(realTool(), "   echo trimmed   ");
    expect(wake).toContain("exited 0 — echo trimmed");
    expect(wake).toContain("trimmed");
  }, 15_000);

  it("killing a command with running grandchildren takes the whole process group", async () => {
    const pgrep = (pattern: string) => {
      try {
        return execSync(`pgrep -f ${JSON.stringify(pattern)}`, { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        return ""; // pgrep exits 1 when nothing matches
      }
    };
    const d = realTool();
    const result = await d.tool.execute("1", { command: "sleep 19 & sleep 19 & wait" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    // Grandchildren must be alive before the kill proves anything.
    await vi.waitFor(() => expect(pgrep("sleep 19")).not.toBe(""), { timeout: 10_000 });
    d.registry.kill((result.details as { id: string }).id);
    // Without the group kill, the pipe-holding sleeps would outlive bash by 19s.
    await vi.waitFor(() => expect(pgrep("sleep 19")).toBe(""), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(d.sendUserMessage).not.toHaveBeenCalled(); // killed tasks never wake
  }, 20_000);
});
