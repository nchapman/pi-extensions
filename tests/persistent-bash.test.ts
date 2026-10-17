import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { outputLogPath } from "../lib/superbash";
import {
  IDENTITY_TOLERANCE_MS,
  PERSISTENT_WRAPPER_SCRIPT,
  STATUS_RETRY_BUDGET_MS,
  TASK_COMMAND_VAR,
  TASK_STATUS_VAR,
  type PersistentTaskMeta,
  decideScan,
  isProcessAlive,
  killPersistedTask,
  listPersistedTaskIds,
  matchesStartTime,
  parseBashPersist,
  parseEtime,
  persistentLogPath,
  psEtime,
  readStatusSync,
  readStatusWithRetry,
  readTaskMeta,
  removePersistedArtifacts,
  scanSessionTasks,
  spawnPersistentTask,
  type ScanDeps,
  taskEnv,
  taskMetaPath,
  taskStatusPath,
  verifyTaskIdentity,
  writeTaskMeta,
} from "../lib/persistent-bash";

/** A valid meta with overridable fields. */
const meta = (over: Partial<PersistentTaskMeta> = {}): PersistentTaskMeta => ({
  version: 1,
  id: "t-test",
  command: "npm test",
  pid: 4242,
  startedAt: 0,
  cwd: "/tmp",
  ...over,
});

const exitOf = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => child.once("exit", (code) => resolve(code)));

describe("parseBashPersist", () => {
  it("is off by default and for anything not explicitly truthy", () => {
    expect(parseBashPersist({})).toBe(false);
    for (const off of ["0", "false", "no", "off", "abc", "", "  "]) {
      expect(parseBashPersist({ PI_BG_BASH_PERSIST: off })).toBe(false);
    }
  });

  it("turns on for 1/true/yes/on, case- and space-insensitive", () => {
    for (const on of ["1", "true", "yes", "on", "ON", " yes "]) {
      expect(parseBashPersist({ PI_BG_BASH_PERSIST: on })).toBe(true);
    }
  });
});

describe("paths", () => {
  it("places meta, status, and log side by side under tasks/", () => {
    const dir = "/sess";
    expect(taskMetaPath(dir, "t-a")).toBe("/sess/tasks/t-a.task.json");
    expect(taskStatusPath(dir, "t-a")).toBe("/sess/tasks/t-a.status");
    expect(persistentLogPath(dir, "t-a")).toBe("/sess/tasks/t-a.log");
  });

  it("pins the log path to superbash's outputLogPath (the task tool peeks through it)", () => {
    expect(persistentLogPath("/sess", "t-a")).toBe(outputLogPath("/sess", "t-a"));
  });
});

describe("wrapper script and env", () => {
  it("evals the command from the environment and captures $? before writing it", () => {
    expect(PERSISTENT_WRAPPER_SCRIPT).toBe(
      `eval "$${TASK_COMMAND_VAR}"\ncode=$?\nprintf '%s' "$code" > "$${TASK_STATUS_VAR}"\nexit "$code"`,
    );
  });

  it("taskEnv adds the two task vars without mutating the base", () => {
    const base = { FOO: "bar" };
    const env = taskEnv(base, "echo hi", "/x/t-a.status");
    expect(env).toEqual({ FOO: "bar", [TASK_COMMAND_VAR]: "echo hi", [TASK_STATUS_VAR]: "/x/t-a.status" });
    expect(base).toEqual({ FOO: "bar" });
  });
});

describe("task metadata", () => {
  it("round-trips through write and read", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-meta-"));
    writeTaskMeta(dir, meta());
    expect(readTaskMeta(dir, "t-test")).toEqual(meta());
  });

  it("reads undefined for missing, corrupt, or foreign metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-meta-"));
    mkdirSync(join(dir, "tasks"));
    expect(readTaskMeta(dir, "t-missing")).toBeUndefined();
    writeFileSync(taskMetaPath(dir, "t-a"), "{not json");
    expect(readTaskMeta(dir, "t-a")).toBeUndefined();
    writeFileSync(taskMetaPath(dir, "t-v2"), JSON.stringify({ ...meta(), version: 2 }));
    expect(readTaskMeta(dir, "t-v2")).toBeUndefined();
    writeFileSync(taskMetaPath(dir, "t-nopid"), JSON.stringify({ ...meta(), pid: undefined }));
    expect(readTaskMeta(dir, "t-nopid")).toBeUndefined();
    writeFileSync(taskMetaPath(dir, "t-badto"), JSON.stringify({ ...meta(), timeoutSecs: 0 }));
    expect(readTaskMeta(dir, "t-badto")).toBeUndefined();
    writeFileSync(taskMetaPath(dir, "t-okto"), JSON.stringify({ ...meta(), timeoutSecs: 60 }));
    expect(readTaskMeta(dir, "t-okto")?.timeoutSecs).toBe(60);
  });

  it("lists only .task.json ids, and none when the tasks dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-list-"));
    expect(listPersistedTaskIds(dir)).toEqual([]);
    const tasks = join(dir, "tasks");
    mkdirSync(tasks);
    for (const f of ["t-a.task.json", "t-a.log", "t-a.status", "t-b.task.json", "noise.txt"]) {
      writeFileSync(join(tasks, f), "x");
    }
    expect(listPersistedTaskIds(dir).sort()).toEqual(["t-a", "t-b"]);
  });

  it("removePersistedArtifacts keeps the log by default and removes everything on kill", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-rm-"));
    const touch = () => {
      mkdirSync(join(dir, "tasks"), { recursive: true });
      writeFileSync(taskMetaPath(dir, "t-a"), "{}");
      writeFileSync(taskStatusPath(dir, "t-a"), "0");
      writeFileSync(persistentLogPath(dir, "t-a"), "out");
    };
    touch();
    removePersistedArtifacts(dir, "t-a"); // settle: keep the log
    expect(existsSync(taskMetaPath(dir, "t-a"))).toBe(false);
    expect(existsSync(taskStatusPath(dir, "t-a"))).toBe(false);
    expect(existsSync(persistentLogPath(dir, "t-a"))).toBe(true);
    touch();
    removePersistedArtifacts(dir, "t-a", { keepLog: false }); // kill: remove all
    expect(existsSync(persistentLogPath(dir, "t-a"))).toBe(false);
    expect(() => removePersistedArtifacts(dir, "t-a")).not.toThrow(); // idempotent
  });
});

describe("parseEtime", () => {
  it("parses mm:ss, hh:mm:ss, and dd-hh:mm:ss with padding", () => {
    expect(parseEtime("00:37")).toBe(37);
    expect(parseEtime("  05:00 ")).toBe(300);
    expect(parseEtime("1:00")).toBe(60);
    expect(parseEtime("02:03:04")).toBe(7384);
    expect(parseEtime("1-02:03:04")).toBe(93784);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "abc", "12", "1:2:3:4", "aa:bb", "-1:00", "1-"]) {
      expect(parseEtime(bad)).toBeUndefined();
    }
  });
});

describe("matchesStartTime", () => {
  it("accepts elapsed times within the tolerance, boundary inclusive", () => {
    expect(matchesStartTime(60, 0, 60_000)).toBe(true);
    expect(matchesStartTime(120, 0, 60_000)).toBe(true); // exactly ±60s
    expect(matchesStartTime(121, 0, 60_000)).toBe(false);
    expect(matchesStartTime(60, 0, 60_000, 0)).toBe(true); // exact with no tolerance
  });
});

describe("verifyTaskIdentity", () => {
  it("verifies when ps elapsed matches the recorded start", async () => {
    expect(await verifyTaskIdentity(meta({ startedAt: 0 }), { now: () => 65_000, runPs: async () => 65 })).toBe(true);
    expect(await verifyTaskIdentity(meta({ startedAt: 0 }), { now: () => 65_000, runPs: async () => 10_000 })).toBe(
      false,
    );
  });

  it("is unverifiable when ps cannot answer", async () => {
    expect(await verifyTaskIdentity(meta(), { now: () => 1000, runPs: async () => undefined })).toBe(false);
  });
});

describe("decideScan", () => {
  const now = 100_000;

  it("a usable status file settles everything, zombies included", () => {
    expect(decideScan(meta(), { status: "0", alive: true }, now)).toEqual({ action: "complete", exitCode: 0 });
    expect(decideScan(meta(), { status: "  42\n", alive: false }, now)).toEqual({ action: "complete", exitCode: 42 });
    expect(decideScan(meta(), { status: "garbage", alive: false }, now)).toEqual({
      action: "complete",
      exitCode: null,
    });
  });

  it("a dead leader without a usable status died unknown", () => {
    expect(decideScan(meta(), { status: undefined, alive: false }, now)).toEqual({ action: "finalize-dead" });
    expect(decideScan(meta(), { status: "", alive: false }, now)).toEqual({ action: "finalize-dead" });
  });

  it("an empty status defers to the alive path", () => {
    expect(decideScan(meta(), { status: "", alive: true, identityVerified: true }, now)).toEqual({ action: "adopt" });
  });

  it("a live pid must be identity-verified before adoption or deadline", () => {
    expect(decideScan(meta(), { alive: true, identityVerified: false }, now)).toEqual({ action: "finalize-recycled" });
    expect(decideScan(meta(), { alive: true }, now)).toEqual({ action: "finalize-recycled" });
    // Identity gates the deadline: an unverified expired task is never killed.
    const expired = meta({ timeoutSecs: 1 });
    expect(decideScan(expired, { alive: true, identityVerified: false }, now)).toEqual({
      action: "finalize-recycled",
    });
  });

  it("a verified survivor adopts, or hits its deadline when expired", () => {
    expect(decideScan(meta(), { alive: true, identityVerified: true }, now)).toEqual({ action: "adopt" });
    expect(decideScan(meta({ timeoutSecs: 1000 }), { alive: true, identityVerified: true }, now)).toEqual({
      action: "adopt",
    });
    expect(decideScan(meta({ timeoutSecs: 1 }), { alive: true, identityVerified: true }, now)).toEqual({
      action: "kill-expired",
    });
  });
});

describe("readStatusSync / readStatusWithRetry", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-status-"));

  it("reads the status file or undefined when missing", () => {
    mkdirSync(join(dir, "tasks"));
    expect(readStatusSync(dir, "t-none")).toBeUndefined();
    writeFileSync(taskStatusPath(dir, "t-a"), "7");
    expect(readStatusSync(dir, "t-a")).toBe("7");
  });

  it("returns a usable status without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    expect(await readStatusWithRetry(dir, "t-a", { readStatus: () => "5", sleep, now: () => 0 })).toBe("5");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("re-reads through the truncate-write window until content lands", async () => {
    let t = 1000;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const readStatus = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce("")
      .mockReturnValueOnce(undefined)
      .mockReturnValue("9");
    expect(await readStatusWithRetry(dir, "t-a", { readStatus, sleep, now: () => t })).toBe("9");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the budget when no content ever lands", async () => {
    let t = 1000;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    expect(
      await readStatusWithRetry(dir, "t-a", { readStatus: () => undefined, sleep, now: () => t, budgetMs: 500 }),
    ).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(5); // (1000 → 1500 in 100ms steps)
    expect(STATUS_RETRY_BUDGET_MS).toBe(2_000);
  });
});

describe("scanSessionTasks", () => {
  const makeDeps = (over: Partial<ScanDeps> = {}) => {
    const metas: Record<string, PersistentTaskMeta> = {};
    const statuses: Record<string, string | undefined> = {};
    let t = 100_000;
    const listIds = vi.fn(() => Object.keys(metas));
    const readMeta = vi.fn((_dir: string, id: string): PersistentTaskMeta | undefined => metas[id]);
    const readStatus = vi.fn((_dir: string, id: string): string | undefined => statuses[id]);
    const isAlive = vi.fn((_pid: number) => true);
    const verifyIdentity = vi.fn(async (_meta: PersistentTaskMeta) => true);
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const now = vi.fn(() => t);
    const deps: ScanDeps = { listIds, readMeta, readStatus, isAlive, verifyIdentity, sleep, now, ...over };
    return { deps, metas, statuses, readMeta, readStatus, isAlive, verifyIdentity, sleep, now };
  };

  it("a finished task completes without probing liveness or identity", async () => {
    const { deps, isAlive, verifyIdentity, metas, statuses } = makeDeps();
    metas["t-a"] = meta({ id: "t-a" });
    statuses["t-a"] = "0";
    const outcomes = await scanSessionTasks("/sess", deps);
    expect(outcomes).toEqual([{ id: "t-a", meta: metas["t-a"], decision: { action: "complete", exitCode: 0 } }]);
    expect(isAlive).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it("a dead leader gets the status retry window before concluding", async () => {
    const { deps, readStatus, isAlive, sleep, metas } = makeDeps();
    metas["t-a"] = meta({ id: "t-a" });
    isAlive.mockReturnValue(false);
    // The scan's probe and the retry's first read both miss; the third lands,
    // so exactly one sleep separates them.
    readStatus.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockReturnValue("3");
    const outcomes = await scanSessionTasks("/sess", deps);
    expect(outcomes[0]?.decision).toEqual({ action: "complete", exitCode: 3 });
    expect(sleep).toHaveBeenCalledTimes(1); // it actually waited
  });

  it("a dead leader with no arriving status finalizes as died-unknown", async () => {
    const { deps, readStatus, isAlive, metas } = makeDeps();
    metas["t-a"] = meta({ id: "t-a" });
    isAlive.mockReturnValue(false);
    readStatus.mockReturnValue(undefined);
    const outcomes = await scanSessionTasks("/sess", deps);
    expect(outcomes[0]?.decision).toEqual({ action: "finalize-dead" });
  });

  it("a live unverified pid reads as recycled, never adopted", async () => {
    const { deps, verifyIdentity, metas } = makeDeps();
    metas["t-a"] = meta({ id: "t-a" });
    verifyIdentity.mockResolvedValue(false);
    expect((await scanSessionTasks("/sess", deps))[0]?.decision).toEqual({ action: "finalize-recycled" });
  });

  it("a verified survivor adopts, or is expired when past its deadline", async () => {
    const { deps, metas } = makeDeps();
    metas["t-a"] = meta({ id: "t-a", startedAt: 0, timeoutSecs: 60 }); // deadline 60s < now 100s
    metas["t-b"] = meta({ id: "t-b", timeoutSecs: 1000 });
    const outcomes = await scanSessionTasks("/sess", deps);
    expect(outcomes.map((o) => o.decision)).toEqual([{ action: "kill-expired" }, { action: "adopt" }]);
  });

  it("unreadable metadata is discarded without sinking the rest of the scan", async () => {
    const { deps, readMeta, readStatus, metas, statuses } = makeDeps();
    metas["t-corrupt"] = meta({ id: "t-corrupt" });
    metas["t-throw"] = meta({ id: "t-throw" });
    metas["t-ok"] = meta({ id: "t-ok" });
    statuses["t-ok"] = "1";
    readMeta.mockImplementation((_dir: string, id: string) => (id === "t-corrupt" ? undefined : metas[id]));
    readStatus.mockImplementation((_dir: string, id: string) => {
      if (id === "t-throw") throw new Error("boom");
      return statuses[id];
    });
    const outcomes = await scanSessionTasks("/sess", deps);
    expect(outcomes).toEqual([
      { id: "t-corrupt", meta: undefined, decision: { action: "discard" } },
      { id: "t-throw", meta: undefined, decision: { action: "discard" } },
      { id: "t-ok", meta: metas["t-ok"], decision: { action: "complete", exitCode: 1 } },
    ]);
  });

  it("an empty session dir scans to nothing", async () => {
    const { deps } = makeDeps();
    expect(await scanSessionTasks("/sess", deps)).toEqual([]);
  });
});

describe("killPersistedTask", () => {
  const seedArtifacts = (dir: string, m: PersistentTaskMeta) => {
    writeTaskMeta(dir, m);
    writeFileSync(taskStatusPath(dir, m.id), "0");
    writeFileSync(persistentLogPath(dir, m.id), "out");
  };

  it("never signals an unverified pid and cleans up as already gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-kill-"));
    const m = meta();
    seedArtifacts(dir, m);
    const killGroup = vi.fn(() => true);
    const killed = await killPersistedTask(m, dir, { verifyIdentity: async () => false, killGroup });
    expect(killed).toBe(false);
    expect(killGroup).not.toHaveBeenCalled();
    expect(existsSync(taskMetaPath(dir, m.id))).toBe(false);
    expect(existsSync(persistentLogPath(dir, m.id))).toBe(false); // kill cleanup takes the log too
  });

  it("kills the group by pid after verification and removes everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-kill2-"));
    const m = meta();
    seedArtifacts(dir, m);
    const killGroup = vi.fn(() => true);
    const killed = await killPersistedTask(m, dir, { verifyIdentity: async () => true, killGroup });
    expect(killed).toBe(true);
    expect(killGroup).toHaveBeenCalledWith(m.pid);
    expect(existsSync(taskMetaPath(dir, m.id))).toBe(false);
    expect(existsSync(taskStatusPath(dir, m.id))).toBe(false);
    expect(existsSync(persistentLogPath(dir, m.id))).toBe(false);
  });
});

describe("spawnPersistentTask", () => {
  const bash = existsSync("/bin/bash") ? "/bin/bash" : undefined;

  it("spawns detached with stdio to the log fd, unref'd, creating the log", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-spawn-"));
    const logPath = persistentLogPath(dir, "t-a");
    const unref = vi.fn();
    const fakeChild = { unref } as unknown as ChildProcess;
    const spawnFn = vi.fn(() => fakeChild) as unknown as typeof import("node:child_process").spawn;
    spawnPersistentTask({ shell: "/bin/bash", cwd: dir, env: { X: "1" }, logPath, spawnFn });
    expect(spawnFn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", PERSISTENT_WRAPPER_SCRIPT],
      expect.objectContaining({
        cwd: dir,
        detached: true,
        env: { X: "1" },
        stdio: ["ignore", expect.any(Number), expect.any(Number)],
      }),
    );
    expect(unref).toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(true);
  });

  it("removes the empty log and rethrows when spawn fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-spawnerr-"));
    const logPath = persistentLogPath(dir, "t-a");
    const spawnFn = vi.fn(() => {
      throw new Error("spawn failed");
    }) as unknown as typeof import("node:child_process").spawn;
    expect(() => spawnPersistentTask({ shell: "/bin/bash", cwd: dir, env: {}, logPath, spawnFn })).toThrow(
      "spawn failed",
    );
    expect(existsSync(logPath)).toBe(false);
  });

  it.skipIf(!bash)("runs the command, logs child-side, and writes the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-run-"));
    const id = "t-run";
    const statusPath = taskStatusPath(dir, id);
    const logPath = persistentLogPath(dir, id);
    const child = spawnPersistentTask({
      shell: bash ?? "/bin/bash",
      cwd: dir,
      env: taskEnv({ PATH: process.env.PATH }, "echo hi; echo err 1>&2", statusPath),
      logPath,
    });
    expect(await exitOf(child)).toBe(0);
    expect(readFileSync(statusPath, "utf8")).toBe("0");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("hi");
    expect(log).toContain("err");
  });

  it.skipIf(!bash)(
    "documented degradation: a bare `exit N` skips the status write but the event carries N",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pb-run7-"));
      const id = "t-run7";
      const statusPath = taskStatusPath(dir, id);
      const child = spawnPersistentTask({
        shell: bash ?? "/bin/bash",
        cwd: dir,
        env: taskEnv({ PATH: process.env.PATH }, "exit 7", statusPath),
        logPath: persistentLogPath(dir, id),
      });
      expect(await exitOf(child)).toBe(7);
      expect(existsSync(statusPath)).toBe(false); // `exit` inside eval ends the shell before the wrapper's write
    },
  );

  it.skipIf(!bash)("keeps the wrapper alive through a command syntax error (eval parses at runtime)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-runx-"));
    const id = "t-runx";
    const statusPath = taskStatusPath(dir, id);
    const child = spawnPersistentTask({
      shell: bash ?? "/bin/bash",
      cwd: dir,
      env: taskEnv({ PATH: process.env.PATH }, "(", statusPath),
      logPath: persistentLogPath(dir, id),
    });
    const code = await exitOf(child);
    expect(code).toBeGreaterThan(0); // bash's parse-error status (1 on bash 3.2, 2 on bash 5)
    expect(readFileSync(statusPath, "utf8")).toBe(String(code)); // the wrapper still wrote it
    expect(readFileSync(persistentLogPath(dir, id), "utf8")).toContain("syntax error");
  });
});

describe("ps and liveness", () => {
  it("isProcessAlive sees the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("psEtime reads a live process and returns undefined for an impossible pid", async () => {
    const elapsed = await psEtime(process.pid);
    expect(typeof elapsed).toBe("number");
    expect(elapsed).toBeGreaterThanOrEqual(0); // a fresh worker legitimately reports 00:00
    expect(await psEtime(2 ** 31 - 1)).toBeUndefined();
  });

  it("psEtime's number is within the identity tolerance of the real start", async () => {
    // The smoke-level version of the identity check against this very process.
    const started = Date.now() - 1_000;
    const elapsed = await psEtime(process.pid);
    expect(elapsed).toBeDefined();
    expect(matchesStartTime(elapsed as number, started, Date.now(), IDENTITY_TOLERANCE_MS)).toBe(true);
  });
});
