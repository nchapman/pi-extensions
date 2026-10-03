import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  createTaskRegistry,
  createBashTool,
  createTaskKillTool,
  createTaskRemindTool,
  createTaskTool,
  createTasksCommand,
  DEFAULT_BASH_BG_AFTER_MS,
  NEVER_ADOPT_MS,
  describeReminders,
  formatDuration,
  formatReminderWake,
  formatSubagentWake,
  MAX_TIMEOUT_MS,
  outputLogPath,
  parseBashBgAfterMs,
  parseBgAfterMs,
  parseWakeEnabled,
  piAgentDir,
  stashPath,
  tempOutputLogPath,
  WAKE_TEXT_CAP,
} from "../lib/superbash";

/** First content block of these tools' results is always text. */
const textOf = (r: { content: readonly unknown[] }): string => (r.content[0] as { text: string }).text;

/** Task id from a result that adopted a task (always set once the command has started). */
const idOf = (r: { details: unknown }): string => (r.details as { id: string }).id;

describe("env parsing", () => {
  it("defaults to never adopting and rejects invalid values", () => {
    // Blocking is the norm: adoption only happens when the env knob opts in.
    expect(parseBgAfterMs({})).toBe(NEVER_ADOPT_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "abc" })).toBe(NEVER_ADOPT_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "-5" })).toBe(NEVER_ADOPT_MS);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "" })).toBe(NEVER_ADOPT_MS); // Number("") is 0
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "  " })).toBe(NEVER_ADOPT_MS);
  });

  it("accepts valid thresholds including zero", () => {
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "1500" })).toBe(1500);
    expect(parseBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "0" })).toBe(0);
  });

  it("parseBashBgAfterMs: same rules under PI_BASH_BG_AFTER_MS", () => {
    expect(parseBashBgAfterMs({})).toBe(DEFAULT_BASH_BG_AFTER_MS);
    expect(parseBashBgAfterMs({ PI_BASH_BG_AFTER_MS: "abc" })).toBe(DEFAULT_BASH_BG_AFTER_MS);
    expect(parseBashBgAfterMs({ PI_BASH_BG_AFTER_MS: "-5" })).toBe(DEFAULT_BASH_BG_AFTER_MS);
    expect(parseBashBgAfterMs({ PI_BASH_BG_AFTER_MS: "" })).toBe(DEFAULT_BASH_BG_AFTER_MS); // Number("") is 0
    expect(parseBashBgAfterMs({ PI_BASH_BG_AFTER_MS: "1500" })).toBe(1500);
    expect(parseBashBgAfterMs({ PI_BASH_BG_AFTER_MS: "0" })).toBe(0); // 0 = behave like background
    // The subagent knob must not leak into the bash tool's window.
    expect(parseBashBgAfterMs({ PI_SUBAGENT_BG_AFTER_MS: "1" })).toBe(DEFAULT_BASH_BG_AFTER_MS);
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
    expect(capResultText("short", "/tmp/s", "t-1134z8v")).toEqual({ text: "short" });
  });

  it("stashes over-cap text beside the session and points at the file", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "bg-cap-"));
    const long = "x".repeat(WAKE_TEXT_CAP + 100);
    const { text, resultPath } = capResultText(long, sessionDir, "t-1134z8v");
    expect(resultPath).toBe(stashPath(sessionDir, "t-1134z8v"));
    expect(text.startsWith("x".repeat(WAKE_TEXT_CAP))).toBe(true);
    expect(text).toContain(`full reply: ${resultPath}`);
    expect(readFileSync(resultPath!, "utf8")).toBe(long);
  });

  it("hard-truncates when there is no session dir, saying so", () => {
    const long = "y".repeat(WAKE_TEXT_CAP + 10);
    const { text, resultPath } = capResultText(long, undefined, "t-1134z8v");
    expect(resultPath).toBeUndefined();
    expect(text).toContain("no session dir");
    expect(text.length).toBeLessThanOrEqual(WAKE_TEXT_CAP + 100);
  });

  it("fails open when the stash write fails", () => {
    // A file where a directory is needed: mkdir fails, the text survives.
    const notADir = join(tmpdir(), `bg-notdir-${Date.now()}`);
    writeFileSync(notADir, "occupied");
    const long = "z".repeat(WAKE_TEXT_CAP + 10);
    const { text } = capResultText(long, notADir, "t-1134z8v");
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
    expect(buildBashEnv({}, { provider: "p1", model: "m1", thinkingLevel: "low" })).toMatchObject({
      PI_PROVIDER: "p1",
      PI_MODEL: "m1",
      PI_REASONING_LEVEL: "low",
    });
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
  it("nests command logs under tasks/ beside the session", () => {
    expect(outputLogPath("/sessions/s1", "t-1134z8v")).toBe(join("/sessions/s1", "tasks", "t-1134z8v.log"));
  });

  it("falls back to a temp file named after the task", () => {
    expect(tempOutputLogPath("t-1134z8v")).toBe(join(tmpdir(), "pi-task-t-1134z8v.log"));
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_900_000)).toBe("1h5m");
  });
});

describe("formatSubagentWake", () => {
  it("formats completion with usage and body", () => {
    const text = formatSubagentWake("reviewer", "t-1134z8v", {
      ok: true,
      durationMs: 252_000,
      text: "All clear.",
      usageLine: "105 tokens (100 in / 5 out), $0.120",
    });
    expect(text).toContain('[background] subagent "reviewer" (t-1134z8v, 4m12s) completed');
    expect(text).toContain("105 tokens");
    expect(text).toContain("All clear.");
  });

  it("formats failure with the error message", () => {
    const text = formatSubagentWake("reviewer", "t-1134z9w", { ok: false, durationMs: 5_000, text: "boom happened" });
    expect(text).toContain('[background] subagent "reviewer" (t-1134z9w, 5s) failed');
    expect(text).toContain("boom happened");
  });
});

describe("formatReminderWake", () => {
  const task = { id: "t-1134z8v", name: "npm test", kind: "bash", state: "running", startedAt: 0 } as const;

  it("reports the task, elapsed time, and note", () => {
    expect(formatReminderWake(task, 252_000, "check the build")).toBe(
      "[reminder] t-1134z8v (bash, 4m12s) still running — check the build" +
        "\nNothing here needs action: end your turn unless you'd act differently at a later check-in. A long elapsed time alone is not a reason to kill or restart — the completion wake is automatic; kill only if the result is no longer wanted.",
    );
  });

  it("omits the note when none was given", () => {
    expect(formatReminderWake(task, 30_000)).toBe(
      "[reminder] t-1134z8v (bash, 30s) still running\nNothing here needs action: end your turn unless you'd act differently at a later check-in. A long elapsed time alone is not a reason to kill or restart — the completion wake is automatic; kill only if the result is no longer wanted.",
    );
  });

  it("includes the task's progress line when it has one", () => {
    const withProgress = { ...task, progress: () => "new output since the last look (10B):\nhi" };
    expect(formatReminderWake(withProgress, 30_000)).toContain(
      "still running\nnew output since the last look (10B):\nhi\nNothing here needs action",
    );
  });

  it("falls back to the subagent signal note when there is no progress to report", () => {
    const subagentTask = { ...task, kind: "subagent" } as const;
    expect(formatReminderWake(subagentTask, 30_000)).toContain(
      "subagents stream no output, so elapsed time is the only signal",
    );
  });
});

describe("describeReminders", () => {
  it("is empty when there are no check-ins", () => {
    expect(describeReminders([])).toBe("");
  });

  it("lists check-ins with duration and note", () => {
    expect(describeReminders([{ id: "t-1134z8v", ms: 300_000, note: "check the build" }])).toBe(
      "\nCheck-ins:\n  t-1134z8v in 5m — check the build",
    );
    expect(describeReminders([{ id: "t-1134z9w", ms: 60_000 }])).toBe("\nCheck-ins:\n  t-1134z9w in 1m");
  });
});

describe("createTaskRegistry", () => {
  function makeDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    let tick = 1000;
    const registry = createTaskRegistry({
      sendUserMessage,
      notify,
      setStatus,
      now: () => (tick += 1000),
    });
    return { registry, sendUserMessage, notify, setStatus };
  }

  it("swallows a throwing wake channel instead of surfacing an unhandled rejection", () => {
    const registry = createTaskRegistry({
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

  it("adopts with time-based ids, unique even for same-millisecond tasks", () => {
    const t0 = 1_750_000_000_000;
    let tick = t0;
    const registry = createTaskRegistry({ now: () => tick });
    const a = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    const b = registry.adopt({ name: "b", kind: "subagent", kill: () => undefined });
    // "t-" + base36 ms; same-millisecond adopts advance the clock by 1ms.
    expect(a).toBe(`t-${t0.toString(36)}`);
    expect(b).toBe(`t-${(t0 + 1).toString(36)}`);
    expect(a).not.toBe(b);
    expect(registry.running().map((t) => t.id)).toEqual([a, b]);
    expect(registry.running()[0]).toMatchObject({ id: a, name: "a", kind: "subagent", state: "running" });
  });

  it("lists running tasks oldest first", () => {
    const registry = createTaskRegistry({ now: () => 5_000 });
    const a = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    const b = registry.adopt({ name: "b", kind: "subagent", kill: () => undefined });
    // Same start tick: insertion order is preserved (stable sort).
    expect(registry.running().map((t) => t.id)).toEqual([a, b]);
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

  it("records the status line on the settled task", () => {
    const { registry } = makeDeps();
    const id = registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    registry.complete(id, { ok: true, text: "wake", status: "exited 0" });
    expect(registry.get(id)).toMatchObject({ state: "done", status: "exited 0" });
  });

  it("wake: false records the outcome without messaging", () => {
    const { registry, sendUserMessage, notify } = makeDeps();
    const id = registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    registry.complete(id, { ok: true, text: "exited 0", status: "exited 0", wake: false });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(registry.get(id)?.state).toBe("done");
  });

  it("notifies failures at error level", () => {
    const { registry, notify } = makeDeps();
    const id = registry.adopt({ name: "a", kind: "subagent", kill: () => undefined });
    registry.complete(id, { ok: false, text: "failed wake" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed wake"), "error");
  });

  it("ignores completion for unknown tasks", () => {
    const { registry, sendUserMessage } = makeDeps();
    registry.complete("t-nope", { ok: true, text: "wake" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("suppresses the wake but keeps the notification when wakes are disabled", () => {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage, notify, wakeEnabled: false });
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

  describe("check-ins (remind)", () => {
    function remindDeps() {
      const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
      const sendUserMessage = vi.fn();
      const notify = vi.fn();
      const registry = createTaskRegistry({
        sendUserMessage,
        notify,
        now: () => 1000,
        schedule: (fn, ms) => {
          const t = { fn, ms, cancelled: false };
          timers.push(t);
          return t;
        },
        unschedule: (h) => {
          (h as { cancelled: boolean }).cancelled = true;
        },
      });
      return { registry, sendUserMessage, notify, timers };
    }

    it("arms, re-arms (replacing), and cancels check-ins", () => {
      const d = remindDeps();
      const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
      expect(d.registry.remind(id, 300_000, "first")).toBe(true);
      expect(d.registry.reminderFor(id)).toEqual({ ms: 300_000, note: "first" });
      expect(d.registry.remind(id, 600_000, "second")).toBe(true); // re-arm replaces
      expect(d.registry.reminderFor(id)).toEqual({ ms: 600_000, note: "second" });
      expect(d.timers[0].cancelled).toBe(true); // the first timer was withdrawn
      expect(d.registry.cancelReminder(id)).toBe(true);
      expect(d.registry.reminderFor(id)).toBeUndefined();
      expect(d.registry.cancelReminder(id)).toBe(false);
    });

    it("refuses check-ins for unknown or settled tasks", () => {
      const d = remindDeps();
      expect(d.registry.remind("t-nope", 1000)).toBe(false);
      const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
      d.registry.complete(id, { ok: true, text: "done" });
      expect(d.registry.remind(id, 1000)).toBe(false);
    });

    it("fires exactly one wake when the task is still running", () => {
      const d = remindDeps();
      const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
      d.registry.remind(id, 300_000, "check the build");
      d.timers[0].fn();
      expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(d.sendUserMessage).toHaveBeenCalledWith(
        `[reminder] ${id} (bash, 0s) still running — check the build` +
          "\nNothing here needs action: end your turn unless you'd act differently at a later check-in. A long elapsed time alone is not a reason to kill or restart — the completion wake is automatic; kill only if the result is no longer wanted.",
      );
      d.timers[0].fn(); // fire-once: the second fire is a no-op
      expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("drops the check-in when the task settles first", () => {
      const d = remindDeps();
      const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
      d.registry.remind(id, 300_000, "check the build");
      d.registry.complete(id, { ok: true, text: "done", status: "exited 0" });
      expect(d.registry.reminderFor(id)).toBeUndefined(); // completion withdraws it
      d.timers[0].fn(); // a stray fire after settlement must be silent
      expect(d.sendUserMessage).toHaveBeenCalledTimes(1); // only the completion wake
    });

    it("kills withdraw the pending check-in", () => {
      const d = remindDeps();
      const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
      d.registry.remind(id, 300_000);
      d.registry.kill(id);
      expect(d.registry.reminderFor(id)).toBeUndefined();
      d.timers[0].fn();
      expect(d.sendUserMessage).not.toHaveBeenCalled();
    });
  });
});

describe("stashPath", () => {
  it("nests under tasks/ beside the session", () => {
    expect(stashPath("/sessions/s1", "t-1134z8v")).toBe(join("/sessions/s1", "tasks", "t-1134z8v.txt"));
  });
});

describe("createBashTool", () => {
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
    const registry = createTaskRegistry({ sendUserMessage, notify, setStatus: vi.fn() });
    return { sendUserMessage, notify, registry };
  }

  const CTX = { sessionManager: { getSessionDir: () => undefined } } as never;
  const dirCtx = (dir: string) => ({ sessionManager: { getSessionDir: () => dir } }) as never;

  it("teaches the wait modes and the wake contract in its description and guidelines", () => {
    const d = toolDeps();
    const tool = createBashTool(d.registry, { operations: fakeBashOps() });
    expect(tool.name).toBe("bash");
    expect(tool.description).toContain('wait: "inline" (default)');
    expect(tool.description).toContain('"background" returns a task id immediately');
    expect(tool.description).toContain("even mid-run");
    expect(tool.description).toContain("never sleep or poll");
    expect(tool.description).toContain("end your turn");
    expect(tool.description).toContain("no default");
    expect(tool.promptGuidelines.join("\n")).toMatch(/never sleep or poll/i);
    expect(tool.promptGuidelines.join("\n")).toContain("end your turn");
  });

  it("returns a task id immediately and adopts the still-running command (background)", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "sleep 30", wait: "background" }, undefined, undefined, CTX);
    const id = idOf(result);
    expect(id).toMatch(/^t-/);
    expect(result.details).toMatchObject({ kind: "bash", mode: "background" });
    expect(ops.last?.command).toBe("sleep 30");
    expect(ops.aborted).toBe(false);
    expect(d.registry.running()[0]).toMatchObject({ id, kind: "bash", name: "sleep 30" });
    // The result text carries the delivery contract: the wake steers in as
    // the next message, even mid-run — never sleep or poll for it.
    expect(textOf(result)).toContain("delivered to you automatically");
    expect(textOf(result)).toContain("even mid-run");
    expect(textOf(result)).toContain("Never sleep or poll");
    expect(textOf(result)).toContain("end your turn");
    // The notice must not suggest arming a check-in — task_remind scoped to its own tool only.
    expect(textOf(result)).not.toContain("task_remind");
    expect(result.structuredContent).toEqual({ backgrounded: true, task_id: id });
  });

  it("wakes with exit status and the output tail on a clean exit", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "echo hi", wait: "background" }, undefined, undefined, CTX);
    const id = idOf(result);
    ops.emit("hi\n");
    await ops.exit(0);
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain(`[background] bash (${id}, 0s) exited 0 — echo hi`);
    expect(wake).toContain("hi");
    expect(d.notify).toHaveBeenCalledWith(wake.split("\n")[0], "info");
    expect(d.registry.running()).toHaveLength(0);
  });

  it("marks nonzero exits as failures", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "false", wait: "background" }, undefined, undefined, CTX);
    ops.emit("boom\n");
    await ops.exit(3);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 3 — false");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 3"), "error");
  });

  it("passes the timeout straight through in seconds, and treats 0/omitted as none", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "a", wait: "background", timeout: 30 }, undefined, undefined, CTX);
    expect(ops.last?.timeout).toBe(30); // executor takes seconds
    d.registry.killAll();

    const d2 = toolDeps();
    const ops2 = fakeBashOps();
    const tool2 = createBashTool(d2.registry, { operations: ops2 });
    await tool2.execute("2", { command: "b", wait: "background", timeout: 0 }, undefined, undefined, CTX);
    expect(ops2.last?.timeout).toBeUndefined();
    d2.registry.killAll();

    const d3 = toolDeps();
    const ops3 = fakeBashOps();
    const tool3 = createBashTool(d3.registry, { operations: ops3 });
    await tool3.execute("3", { command: "c", wait: "background" }, undefined, undefined, CTX);
    expect(ops3.last?.timeout).toBeUndefined();
    d3.registry.killAll();
  });

  it("rejects invalid timeouts as a tool error without adopting a task", async () => {
    for (const bad of [-5, 1e10]) {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops });
      const result = await tool.execute(
        "1",
        { command: "x", wait: "background", timeout: bad },
        undefined,
        undefined,
        CTX,
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid timeout");
      expect(ops.last).toBeUndefined();
      expect(d.registry.running()).toHaveLength(0);
      expect(d.sendUserMessage).not.toHaveBeenCalled();
    }
  });

  it("reports timeout rejections in the wake", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "hang", wait: "background", timeout: 15 }, undefined, undefined, CTX);
    await ops.fail("timeout:15");
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("timed out after 15s — hang");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("timed out"), "error");
  });

  it("settles as a failure when the executor throws synchronously", async () => {
    const d = toolDeps();
    const tool = createBashTool(d.registry, {
      operations: {
        exec: () => {
          throw new Error("no bash");
        },
      },
    });
    const result = await tool.execute("1", { command: "x", wait: "background" }, undefined, undefined, CTX);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Failed to start command: no bash");
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
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "x", wait: "background" }, undefined, undefined, {
      cwd: "/no/such/bash-dir",
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Working directory does not exist");
    expect(ops.last).toBeUndefined();
    expect(d.registry.running()).toHaveLength(0);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty command", async () => {
    const d = toolDeps();
    const tool = createBashTool(d.registry, { operations: fakeBashOps() });
    const result = await tool.execute("1", { command: "   " }, undefined, undefined, CTX);
    expect(result.isError).toBe(true);
    expect(d.registry.running()).toHaveLength(0);
  });

  it("exposes the session environment like the built-in bash tool", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "x", wait: "background" }, undefined, undefined, {
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

  it("keeps a rolling tail, caps the wake, and logs the full output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-tool-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "spew", wait: "background" }, undefined, undefined, dirCtx(dir));
    const id = idOf(result);
    ops.emit(`${"x".repeat(50)}HEAD${"x".repeat(BASH_TAIL_CAP)}`);
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake.length).toBeLessThan(BASH_TAIL_CAP); // inline body capped to the wake budget
    expect(wake).toContain("full output"); // log pointer wording
    // The log is written through an async stream; wait for it to flush.
    await vi.waitFor(() => {
      const full = readFileSync(outputLogPath(dir, id), "utf8");
      expect(full).toContain("HEAD"); // the full output is logged, not just the tail
      expect(full).toContain("x".repeat(100));
    });
  });

  it("sends no wake for a task killed by shutdown", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "long", wait: "background" }, undefined, undefined, CTX);
    d.registry.killAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(ops.aborted).toBe(true);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves no orphaned log when a killed task had output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-kill-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "spew", wait: "background" }, undefined, undefined, dirCtx(dir));
    const id = idOf(result);
    ops.emit("x".repeat(BASH_TAIL_CAP));
    // The log is created asynchronously; wait for it before killing so the
    // cleanup path — not async creation timing — is what we're testing.
    await vi.waitFor(() => expect(existsSync(outputLogPath(dir, id))).toBe(true));
    d.registry.killAll(); // marks killed, tears the log down before the abort lands
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(outputLogPath(dir, id))).toBe(false);
  });

  it("does not resurrect the log from a chunk that arrives after a kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-kill2-"));
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const result = await tool.execute("1", { command: "spew", wait: "background" }, undefined, undefined, dirCtx(dir));
    const id = idOf(result);
    ops.emit("x".repeat(BASH_TAIL_CAP)); // opens the log
    await vi.waitFor(() => expect(existsSync(outputLogPath(dir, id))).toBe(true));
    d.registry.killAll(); // marks killed, tears the log down
    ops.emit("more"); // a delayed pipe read would race in here
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(outputLogPath(dir, id))).toBe(false);
  });

  it("does not claim the output was lost when truncation is line-based under the cap", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "lines", wait: "background" }, undefined, undefined, CTX);
    // >2000 lines but <4000 bytes: the line cap truncates the wake, but the
    // full output is in the log, so the wake must not say it was lost.
    ops.emit("\n".repeat(2001));
    await ops.exit(0);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).not.toContain("could not save the full output");
  });

  it("keeps multi-byte UTF-8 intact across chunk boundaries", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "cjk", wait: "background" }, undefined, undefined, CTX);
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
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "both", wait: "background" }, undefined, undefined, CTX);
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
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "enoent", wait: "background" }, undefined, undefined, CTX);
    ops.fail("spawn enoent ENOENT");
    await ops.exit(0); // real error paths are followed by an exit — fire-once absorbs it
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("failed: spawn enoent ENOENT");
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("reports signal kills by their 128+signal exit code, like the bash tool", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "victim", wait: "background" }, undefined, undefined, CTX);
    await ops.exit(143); // SIGTERM: pi's local ops resolve 128 + 15, not a raw signal
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 143 — victim");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 143"), "error");
  });

  it("labels a codeless termination after the executor gives up", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    await tool.execute("1", { command: "zombie", wait: "background" }, undefined, undefined, CTX);
    await ops.exit(null);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("terminated without an exit code");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("terminated"), "error");
  });

  it("aborts the task when the tool call is interrupted", async () => {
    const d = toolDeps();
    const ops = fakeBashOps();
    const tool = createBashTool(d.registry, { operations: ops });
    const ac = new AbortController();
    await tool.execute("1", { command: "long", wait: "background" }, ac.signal, undefined, CTX);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(ops.aborted).toBe(true);
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("aborted");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("aborted"), "error");
  });

  describe("wait: auto", () => {
    it("returns a built-in-style result inline when the command finishes inside the window", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bash-auto-"));
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 1000 });
      const p = tool.execute("1", { command: "echo hi", wait: "auto" }, undefined, undefined, dirCtx(dir));
      ops.emit("hi\n");
      await ops.exit(0);
      const result = await p;
      const id = idOf(result);
      expect(textOf(result)).toBe("hi\n");
      expect(result.isError).toBeUndefined();
      expect(id).toMatch(/^t-/);
      // No duplicate wake: the tool result already carried the output.
      expect(d.sendUserMessage).not.toHaveBeenCalled();
      expect(d.registry.get(id)).toMatchObject({ state: "done", status: "exited 0" });
      expect(result.structuredContent).toMatchObject({ exit_code: 0, truncated: false });
    });

    it("bounds the in-window read: a chatty fast command reads head + tail only", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bash-auto-big-"));
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 1000 });
      const p = tool.execute("1", { command: "spew", wait: "auto" }, undefined, undefined, dirCtx(dir));
      // 2MB in a few milliseconds: only the 1MB head and 50KB tail may ever be
      // read into memory.
      ops.emit("A".repeat(2_000_000 - 2) + "ZZ");
      await ops.exit(0);
      const result = await p;
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain("ZZ"); // the tail survives
      expect(textOf(result)).toContain("[Output truncated — full output:");
      const sc = result.structuredContent as { truncated: boolean; full_output_path?: string; output: string };
      expect(sc.truncated).toBe(true);
      expect(sc.full_output_path).toBeDefined();
      expect(sc.output.length).toBe(1_048_576); // the head cap, not the 2MB file
    });

    it("inline is the default wait mode: a still-running default call never promotes", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      // A gate that holds the inline delegation open past the promote window,
      // so the test observes the call while it is still legitimately running.
      let releaseInline!: () => void;
      const gate = new Promise<void>((res) => {
        releaseInline = res;
      });
      const inline = vi.fn(async (_id: string, _params: { command: string; timeout?: number }) => {
        await gate;
        return {
          content: [{ type: "text" as const, text: "done" }],
          details: { fullOutputPath: "/tmp/full.log" },
          structuredContent: { output: "done", truncated: false, exit_code: 0, wall_time_seconds: 0.1 },
        };
      });
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 20, inline });
      const p = tool.execute("1", { command: "sleep 30" }, undefined, undefined, CTX); // no wait → inline
      await new Promise((r) => setTimeout(r, 40)); // the window (20ms) elapses while still inline
      // Blocking is the norm: nothing is adopted, no wake fires — the call
      // stays a pending tool result, not a background task.
      expect(d.registry.running()).toHaveLength(0);
      expect(d.sendUserMessage).not.toHaveBeenCalled();
      releaseInline();
      const result = await p;
      expect(inline).toHaveBeenCalledTimes(1); // the delegation actually ran
      expect(result.details).toMatchObject({ mode: "inline" });
    });

    it("promotes to the background when the window elapses, then wakes on exit", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 30 });
      const result = await tool.execute("1", { command: "sleep 30", wait: "auto" }, undefined, undefined, CTX);
      const id = idOf(result);
      expect(textOf(result)).toContain(`Backgrounded (${id})`);
      expect(result.structuredContent).toEqual({ backgrounded: true, task_id: id });
      expect(d.registry.running()).toHaveLength(1);
      expect(d.sendUserMessage).not.toHaveBeenCalled(); // not yet
      ops.emit("out\n");
      await ops.exit(0);
      expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
      const wake = d.sendUserMessage.mock.calls[0][0] as string;
      expect(wake).toContain("exited 0 — sleep 30");
      expect(wake).toContain("out");
    });

    it("reports a nonzero exit inline with the built-in wording", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bash-auto-err-"));
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 1000 });
      const p = tool.execute("1", { command: "false", wait: "auto" }, undefined, undefined, dirCtx(dir));
      ops.emit("boom\n");
      await ops.exit(3);
      const result = await p;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("boom");
      expect(textOf(result)).toContain("Command exited with code 3");
      expect(d.sendUserMessage).not.toHaveBeenCalled();
    });

    it("reports a timeout inline", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 1000 });
      const p = tool.execute("1", { command: "hang", wait: "auto", timeout: 5 }, undefined, undefined, CTX);
      await ops.fail("timeout:5");
      const result = await p;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Command timed out after 5 seconds");
    });

    it("reports an aborted tool call inline", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 1000 });
      const ac = new AbortController();
      const p = tool.execute("1", { command: "long", wait: "auto" }, ac.signal, undefined, CTX);
      ac.abort();
      const result = await p;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Command aborted");
    });

    it("streams live output while blocking in the auto window", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 500 });
      const updates: string[] = [];
      const onUpdate = (u: { content: { type: "text"; text: string }[] }) => updates.push(u.content[0]?.text ?? "");
      const p = tool.execute("1", { command: "chatty", wait: "auto" }, undefined, onUpdate as never, CTX);
      ops.emit("line1\n");
      await new Promise((r) => setTimeout(r, 150)); // let the throttle fire
      ops.emit("line2\n");
      await ops.exit(0);
      await p;
      expect(updates.join("")).toContain("line1");
      expect(updates.join("")).toContain("line2");
    });

    it("stops streaming updates once auto promotes to the background", async () => {
      const d = toolDeps();
      const ops = fakeBashOps();
      const tool = createBashTool(d.registry, { operations: ops, waitMs: 30 });
      const updates: string[] = [];
      const onUpdate = (u: { content: { type: "text"; text: string }[] }) => updates.push(u.content[0]?.text ?? "");
      const p = tool.execute("1", { command: "chatty", wait: "auto" }, undefined, onUpdate as never, CTX);
      ops.emit("early\n");
      const result = await p; // promotes after the 30ms window
      expect(textOf(result)).toContain("Backgrounded");
      // The final flush before returning carried everything emitted so far.
      expect(updates.join("")).toContain("early");
      const countAtPromote = updates.length;
      ops.emit("late\n");
      await new Promise((r) => setTimeout(r, 200)); // past the throttle window
      // The tool call has returned: no more updates for a dead panel.
      expect(updates.length).toBe(countAtPromote);
      await ops.exit(0);
      expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("wait: inline", () => {
    function inlineDeps() {
      const d = toolDeps();
      const inline = vi.fn(async (_id: string, params: { command: string; timeout?: number }) => ({
        content: [{ type: "text" as const, text: `inline ran: ${params.command}` }],
        details: { fullOutputPath: "/tmp/full.log" },
        structuredContent: {
          output: `inline ran: ${params.command}`,
          truncated: false,
          exit_code: 0,
          wall_time_seconds: 0.1,
        },
      }));
      const tool = createBashTool(d.registry, { inline, operations: fakeBashOps() });
      return { ...d, inline, tool };
    }

    it("delegates to pi's own bash tool, trimming the command and mapping timeout 0 to none", async () => {
      const d = inlineDeps();
      const result = await d.tool.execute(
        "1",
        { command: "  echo hi  ", wait: "inline", timeout: 0 },
        undefined,
        undefined,
        CTX,
      );
      expect(d.inline).toHaveBeenCalledTimes(1);
      expect(d.inline.mock.calls[0][1]).toEqual({ command: "echo hi", timeout: undefined });
      expect(textOf(result)).toBe("inline ran: echo hi");
      expect(result.details).toMatchObject({ kind: "bash", mode: "inline", fullOutputPath: "/tmp/full.log" });
      expect(result.structuredContent).toMatchObject({ exit_code: 0 });
    });

    it("passes a nonzero timeout through to the inline executor", async () => {
      const d = inlineDeps();
      await d.tool.execute("1", { command: "x", wait: "inline", timeout: 30 }, undefined, undefined, CTX);
      expect(d.inline.mock.calls[0][1]).toEqual({ command: "x", timeout: 30 });
    });

    it("registers no task and sends no wake", async () => {
      const d = inlineDeps();
      await d.tool.execute("1", { command: "x", wait: "inline" }, undefined, undefined, CTX);
      expect(d.registry.running()).toHaveLength(0);
      expect(d.sendUserMessage).not.toHaveBeenCalled();
    });

    it("converts an inline throw into a tool error", async () => {
      const d = inlineDeps();
      d.inline.mockRejectedValueOnce(new Error("Command timed out after 10 seconds"));
      const result = await d.tool.execute("1", { command: "x", wait: "inline" }, undefined, undefined, CTX);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Command timed out after 10 seconds");
    });
  });
});

describe("createTaskTool", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "task-peek-"));
    const ctx = { sessionManager: { getSessionDir: () => dir } } as never;
    const registry = createTaskRegistry({ now: () => 5_000 });
    const id = registry.adopt({ name: "long build", kind: "bash", kill: () => undefined });
    const log = outputLogPath(dir, id);
    const tool = createTaskTool(registry, { now: () => 7_000 });
    return { ctx, registry, id, log, tool };
  }

  it("lists running tasks and pending check-ins", async () => {
    const d = setup();
    d.registry.remind(d.id, 300_000, "check the build");
    const result = await d.tool.execute("1", {}, undefined, undefined, d.ctx);
    const text = textOf(result);
    expect(text).toContain(`${d.id} (bash, 2s) long build`); // 7s now - 5s start
    expect(text).toContain("Check-ins:");
    expect(text).toContain(`${d.id} in 5m — check the build`);
  });

  it("lists an empty registry as such", async () => {
    const registry = createTaskRegistry();
    const tool = createTaskTool(registry);
    const ctx = { sessionManager: { getSessionDir: () => undefined } } as never;
    const result = await tool.execute("1", {}, undefined, undefined, ctx);
    expect(textOf(result)).toBe("No background tasks running.");
  });

  it("errors with the running list for an unknown id", async () => {
    const d = setup();
    const result = await d.tool.execute("1", { id: "t-nope" }, undefined, undefined, d.ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No task t-nope");
    expect(textOf(result)).toContain(`${d.id} (bash,`);
  });

  it("reports a settled task's duration as its run time, not the time since launch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-peek-"));
    const ctx = { sessionManager: { getSessionDir: () => dir } } as never;
    // Start at t=5s, settle at t=5.5s; the agent checks in 20 minutes later —
    // the reported duration must stay 1s (rounded), not 20m.
    let now = 5_000;
    const registry = createTaskRegistry({ now: () => now });
    const id = registry.adopt({ name: "long build", kind: "bash", kill: () => undefined });
    now = 5_500;
    registry.complete(id, { ok: true, text: "ok" });
    now = 1_205_000;
    const tool = createTaskTool(registry, { now: () => now });
    const result = await tool.execute("1", { id }, undefined, undefined, ctx);
    const text = textOf(result);
    expect(text).toContain(", 1s)");
    expect(text).not.toContain("20m");
  });

  it("says no output yet for a running task whose log is empty", async () => {
    const d = setup();
    const result = await d.tool.execute("1", { id: d.id }, undefined, undefined, d.ctx);
    expect(textOf(result)).toContain(`${d.id} (bash, running, 2s) long build`);
    expect(textOf(result)).toContain("(no output yet)");
  });

  it("shows the tail on the first peek, then only new output", async () => {
    const d = setup();
    mkdirSync(join(dirOf(d.log), "tasks"), { recursive: true });
    writeFileSync(d.log, `head-${"x".repeat(6000)}unique-tail`);
    const first = (await d.tool.execute("1", { id: d.id }, undefined, undefined, d.ctx)).content[0].text;
    expect(first).toContain("unique-tail");
    expect(first).not.toContain("head-"); // 4KB tail of a 6KB log
    appendFileSync(d.log, "new-1\nnew-2\n");
    const second = (await d.tool.execute("2", { id: d.id }, undefined, undefined, d.ctx)).content[0].text;
    expect(second).toContain("new-1");
    expect(second).toContain("new-2");
    expect(second).not.toContain("unique-tail"); // only what appeared since the last check
    expect(second).not.toContain("head-");
  });

  it("reports subagent tasks without streaming output", async () => {
    const d = setup();
    const subId = d.registry.adopt({ name: "reviewer", kind: "subagent", kill: () => undefined });
    const result = await d.tool.execute("1", { id: subId }, undefined, undefined, d.ctx);
    expect(textOf(result)).toContain("subagent, running");
    expect(textOf(result)).toContain("stream no output");
  });

  it("reports a settled bash task with its status and full-output path", async () => {
    const d = setup();
    mkdirSync(join(dirOf(d.log), "tasks"), { recursive: true });
    writeFileSync(d.log, "the whole output");
    d.registry.complete(d.id, { ok: true, text: "done", status: "exited 0", wake: false });
    const result = await d.tool.execute("1", { id: d.id }, undefined, undefined, d.ctx);
    const text = textOf(result);
    expect(text).toContain(`${d.id} (bash, done, exited 0, 0s) long build`);
    expect(text).toContain(`Full output: ${d.log}`);
  });

  it("reports a settled task without a log via the completion wake", async () => {
    const d = setup();
    d.registry.complete(d.id, { ok: false, text: "boom", status: "failed: x", wake: false });
    const result = await d.tool.execute("1", { id: d.id }, undefined, undefined, d.ctx);
    expect(textOf(result)).toContain(`${d.id} (bash, failed, failed: x, 0s) long build`);
    expect(textOf(result)).toContain("the completion wake carried its output");
  });

  it("reports killed tasks as discarded", async () => {
    const d = setup();
    d.registry.kill(d.id);
    const result = await d.tool.execute("1", { id: d.id }, undefined, undefined, d.ctx);
    expect(textOf(result)).toContain(`${d.id} (bash, killed, 0s) long build`);
    expect(textOf(result)).toContain("output was discarded");
  });

  /** <sessionDir> for a log path produced by outputLogPath. */
  function dirOf(log: string): string {
    // outputLogPath is <sessionDir>/tasks/<id>.log — drop the last two segments.
    const i = log.lastIndexOf("/tasks/");
    return log.slice(0, i);
  }
});

describe("createTaskRemindTool", () => {
  function remindDeps() {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const sendUserMessage = vi.fn();
    const registry = createTaskRegistry({
      sendUserMessage,
      notify: vi.fn(),
      now: () => 1000,
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return t;
      },
      unschedule: (h) => {
        (h as { cancelled: boolean }).cancelled = true;
      },
    });
    const tool = createTaskRemindTool(registry);
    return { registry, sendUserMessage, timers, tool };
  }

  it("arms a check-in with duration and note", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    const result = await d.tool.execute(
      "1",
      { id, in_ms: 300_000, note: "check the build" },
      undefined,
      undefined,
      undefined,
    );
    expect(textOf(result)).toContain(`Check-in set for ${id} in 5m — check the build`);
    expect(textOf(result)).toContain("not a way to wait");
    expect(result.details).toMatchObject({ kind: "task_remind", in_ms: 300_000 });
    expect(d.registry.reminderFor(id)).toEqual({ ms: 300_000, note: "check the build" });
  });

  it("re-arming replaces the pending check-in and says so", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    const first = await d.tool.execute("1", { id, in_ms: 1000 }, undefined, undefined, undefined);
    expect(textOf(first)).not.toContain("replacing");
    const second = await d.tool.execute("2", { id, in_ms: 2000 }, undefined, undefined, undefined);
    expect(textOf(second)).toContain("replacing the earlier check-in, was in 1s");
    expect(d.timers[0].cancelled).toBe(true);
    expect(d.registry.reminderFor(id)).toEqual({ ms: 2000, note: undefined });
  });

  it("cancels the pending check-in when in_ms is omitted", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    await d.tool.execute("1", { id, in_ms: 1000 }, undefined, undefined, undefined);
    const result = await d.tool.execute("2", { id }, undefined, undefined, undefined);
    expect(textOf(result)).toContain(`Cancelled the pending check-in for ${id}`);
    expect(d.registry.reminderFor(id)).toBeUndefined();
    expect(d.timers[0].cancelled).toBe(true);
  });

  it("errors when there is nothing to cancel", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    const result = await d.tool.execute("1", { id }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`No pending check-in for ${id}`);
  });

  it("refuses unknown ids with the running list", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    const result = await d.tool.execute("1", { id: "t-nope", in_ms: 1000 }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the task is not running");
    expect(textOf(result)).toContain(`${id} (bash,`);
  });

  it("refuses settled tasks", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    d.registry.complete(id, { ok: true, text: "done", wake: false });
    const result = await d.tool.execute("1", { id, in_ms: 1000 }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the task is not running");
  });

  it("rejects invalid in_ms values", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    for (const bad of [0, -5, 1.5, 1e12]) {
      const result = await d.tool.execute("1", { id, in_ms: bad }, undefined, undefined, undefined);
      expect(result.isError, `in_ms=${bad}`).toBe(true);
      expect(textOf(result)).toContain("Invalid in_ms");
    }
    expect(d.registry.reminderFor(id)).toBeUndefined();
  });

  it("fires the wake with the task's status when it is still running", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    await d.tool.execute("1", { id, in_ms: 300_000, note: "check the build" }, undefined, undefined, undefined);
    d.timers[0].fn();
    expect(d.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(d.sendUserMessage).toHaveBeenCalledWith(
      `[reminder] ${id} (bash, 0s) still running — check the build` +
        "\nNothing here needs action: end your turn unless you'd act differently at a later check-in. A long elapsed time alone is not a reason to kill or restart — the completion wake is automatic; kill only if the result is no longer wanted.",
    );
  });

  it("drops the check-in when the task settled first", async () => {
    const d = remindDeps();
    const id = d.registry.adopt({ name: "a", kind: "bash", kill: () => undefined });
    await d.tool.execute("1", { id, in_ms: 300_000 }, undefined, undefined, undefined);
    d.registry.complete(id, { ok: true, text: "done", wake: false });
    d.timers[0].fn(); // stray fire after settlement
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("kill and control surfaces", () => {
  function controlDeps() {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage, notify, setStatus: vi.fn(), now: () => 1_000 });
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
    expect(d.registry.kill("t-nope")).toBe(false); // unknown
  });

  it("task_kill kills a bash task and never wakes it", async () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    const onKilled = vi.fn();
    const bash = createBashTool(d.registry, { operations: child });
    const killTool = createTaskKillTool(d.registry, { onKilled });
    const result = await bash.execute("1", { command: "spin", wait: "background" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const id = idOf(result);
    const kill = await killTool.execute("2", { id }, undefined, undefined, undefined);
    expect(kill.details).toMatchObject({ killed: true, id });
    expect(onKilled).toHaveBeenCalledWith(id);
    await new Promise((r) => setTimeout(r, 10));
    expect(child.aborted).toBe(true);
    expect(d.sendUserMessage).not.toHaveBeenCalled();
  });

  it("task_kill errors with the running list when the id is unknown", async () => {
    const d = controlDeps();
    const child = fakeBashForControl();
    const bash = createBashTool(d.registry, { operations: child });
    const result = await bash.execute("1", { command: "live", wait: "background" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const id = idOf(result);
    const killTool = createTaskKillTool(d.registry);
    const err = await killTool.execute("2", { id: "t-nope" }, undefined, undefined, undefined);
    expect(err.isError).toBe(true);
    const text = err.content[0].text;
    expect(text).toContain("No running task t-nope");
    expect(text).toContain(`${id} (bash,`);
    expect(child.aborted).toBe(false);
  });

  it("/tasks lists, kills by `kill <id>`, kills all, shows check-ins, and teaches its grammar on misuse", async () => {
    const d = controlDeps();
    const childA = fakeBashForControl();
    const childB = fakeBashForControl();
    const bash = createBashTool(d.registry, { operations: childA });
    const bash2 = createBashTool(d.registry, { operations: childB });
    const r1 = await bash.execute("1", { command: "a", wait: "background" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const r2 = await bash2.execute("2", { command: "b", wait: "background" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
    } as never);
    const idA = idOf(r1);
    const idB = idOf(r2);
    const cmd = createTasksCommand(d.registry, { now: () => 4_000 });
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    cmd.handler("", ctx);
    const listing = notify.mock.calls[0][0] as string;
    expect(listing).toContain(`${idA} (bash, 3s) a`);
    expect(listing).toContain(`${idB} (bash, 3s) b`);

    d.registry.remind(idA, 300_000, "check the build");
    notify.mockClear();
    cmd.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Check-ins:"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(`${idA} in 5m — check the build`), "info");

    // Bare id — the old form — now teaches the grammar instead of killing.
    cmd.handler(idA, ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /tasks"), "info");
    expect(childA.aborted).toBe(false);

    cmd.handler("kill t-nope", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No running task t-nope"), "error");

    cmd.handler(`kill ${idA}`, ctx);
    expect(notify).toHaveBeenCalledWith(`Killed ${idA}. Its wake will not arrive.`, "warning");
    expect(childA.aborted).toBe(true);

    cmd.handler("kill all", ctx);
    expect(notify).toHaveBeenCalledWith("Killed 1 task. Their wakes will not arrive.", "warning");
    expect(childB.aborted).toBe(true);

    cmd.handler("kill all", ctx); // nothing left
    expect(notify).toHaveBeenCalledWith("No running tasks.", "info");

    cmd.handler("kill", ctx); // missing target
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /tasks"), "info");
  });

  it("task_kill and /tasks work on adopted subagent tasks too", () => {
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

describe("bash tool with real commands", () => {
  function realTool(sessionDir?: string, waitMs?: number) {
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const registry = createTaskRegistry({ sendUserMessage, notify, setStatus });
    const tool = createBashTool(registry, waitMs !== undefined ? { waitMs } : {});
    const ctx = {
      // getSessionFile is required by the inline delegation to pi's built-in
      // bash tool (temp-file stashing on truncation) — the default wait mode.
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionId: () => "real-test",
        getSessionFile: () => join(tmpdir(), "pi-test-session.jsonl"),
      },
    };
    return { sendUserMessage, notify, setStatus, registry, tool, ctx };
  }

  type RealTool = ReturnType<typeof realTool>;

  async function runRealBackgrounded(d: RealTool, command: string) {
    const result = await d.tool.execute("1", { command, wait: "background" }, undefined, undefined, d.ctx);
    const id = idOf(result);
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    return {
      id,
      wake: d.sendUserMessage.mock.calls[0][0] as string,
    };
  }

  it("inline (default): a fast command returns inline without a wake", async () => {
    const d = realTool(undefined, 10_000);
    const result = await d.tool.execute("1", { command: "echo real-hi" }, undefined, undefined, d.ctx);
    expect(textOf(result)).toContain("real-hi");
    expect(result.isError).toBeUndefined();
    expect(d.sendUserMessage).not.toHaveBeenCalled();
    // The inline delegation bypasses the registry: nothing was adopted, so
    // there is no task record and no wake to deliver.
    expect(d.registry.running()).toHaveLength(0);
  }, 15_000);

  it("background: wakes with the output", async () => {
    const d = realTool();
    const { id, wake } = await runRealBackgrounded(d, "echo real-hi");
    expect(wake).toContain(`exited 0 — echo real-hi`);
    expect(wake).toContain(`(${id},`);
    expect(wake).toContain("real-hi");
  }, 15_000);

  it("preserves multi-line output in the tail", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "printf 'one\\ntwo\\nthree\\n'");
    expect(wake).toContain("one\ntwo\nthree");
  }, 15_000);

  it("keeps unicode intact through real pipes", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "printf 'héllo 世界 🎉\\n'");
    expect(wake).toContain("héllo 世界 🎉");
  }, 15_000);

  it("captures stderr-only commands", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "printf 'only-stderr\\n' >&2");
    expect(wake).toContain("only-stderr");
  }, 15_000);

  it("stays header-only for quiet commands", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "true");
    expect(wake).toMatch(/exited 0 — true$/);
    expect(wake).not.toContain("\n"); // no body, no stash pointer
  }, 15_000);

  it("preserves exact exit codes", async () => {
    const d = realTool();
    const { wake } = await runRealBackgrounded(d, "exit 42");
    expect(wake).toContain("exited 42 — exit 42");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("exited 42"), "error");
  }, 15_000);

  it("reports a self-terminated command by its 128+signal exit code, like the bash tool", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "kill -TERM $$");
    expect(wake).toContain("exited 143");
  }, 15_000);

  it("runs pipelines and compound commands through bash -c", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "echo pipeline | tr a-z A-Z && echo compound");
    expect(wake).toContain("PIPELINE");
    expect(wake).toContain("compound");
  }, 15_000);

  it("runs in the session cwd when ctx provides one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-cwd-"));
    const d = realTool();
    // The real ExtensionToolContext carries cwd; the loose lib type accepts it.
    const result = await d.tool.execute("1", { command: "pwd", wait: "background" }, undefined, undefined, {
      sessionManager: { getSessionDir: () => undefined },
      cwd: dir,
    } as never);
    expect(result.details).toMatchObject({ kind: "bash" });
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain(dir);
  }, 15_000);

  it("replaces invalid UTF-8 bytes instead of corrupting the tail", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "printf '\\xff\\xfe\\x80'");
    expect(wake).toContain("\uFFFD");
    expect(wake).toContain("exited 0");
  }, 15_000);

  it("rolls a real large output into the tail and logs the full output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-big-"));
    const d = realTool(dir);
    const { id, wake } = await runRealBackgrounded(d, "seq 1 5000");
    expect(wake).toContain("full output"); // log pointer
    expect(wake.length).toBeLessThan(6_000); // capped inline body
    await vi.waitFor(() => {
      const full = readFileSync(outputLogPath(dir, id), "utf8");
      expect(full).toContain("4999\n5000"); // the end survives the roll
      expect(full.startsWith("1\n")).toBe(true); // the full output is logged, start and all
    });
  }, 15_000);

  it("auto: a slow command promotes and wakes with the full output logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-big-auto-"));
    const d = realTool(dir, 200);
    const result = await d.tool.execute(
      "1",
      { command: "sleep 0.3 && echo promoted-out", wait: "auto" },
      undefined,
      undefined,
      d.ctx,
    );
    const id = idOf(result);
    expect(textOf(result)).toContain(`Backgrounded (${id})`);
    await vi.waitFor(() => expect(d.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const wake = d.sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("exited 0");
    expect(wake).toContain("promoted-out");
    await vi.waitFor(() => {
      const full = readFileSync(outputLogPath(dir, id), "utf8");
      expect(full).toContain("promoted-out");
    });
  }, 15_000);

  it("trims whitespace-padded commands before naming and running them", async () => {
    const { wake } = await runRealBackgrounded(realTool(), "   echo trimmed   ");
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
    const result = await d.tool.execute(
      "1",
      { command: "sleep 19 & sleep 19 & wait", wait: "background" },
      undefined,
      undefined,
      {
        sessionManager: { getSessionDir: () => undefined },
      } as never,
    );
    // Grandchildren must be alive before the kill proves anything.
    await vi.waitFor(() => expect(pgrep("sleep 19")).not.toBe(""), { timeout: 10_000 });
    d.registry.kill(idOf(result));
    // Without the group kill, the pipe-holding sleeps would outlive bash by 19s.
    await vi.waitFor(() => expect(pgrep("sleep 19")).toBe(""), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(d.sendUserMessage).not.toHaveBeenCalled(); // killed tasks never wake
  }, 20_000);
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
