import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerShortcuts, SHORTCUTS } from "../extensions/shortcuts";

type Cmd = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
type NotifyCall = [string, "info" | "warning" | "error"];

/** Captures commands registered via pi.registerCommand and returns a fake pi. */
function makePi() {
  const commands = new Map<string, Cmd>();
  const pi = {
    registerCommand: (name: string, cmd: Cmd) => {
      commands.set(name, cmd);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

/** A ctx that records which methods were invoked and with what args. */
function makeCtx() {
  const calls: string[] = [];
  const notifyCalls: NotifyCall[] = [];
  const compactCalls: Array<{ customInstructions?: string }> = [];
  const ctx = {
    cwd: "/tmp/workspace",
    shutdown: () => void calls.push("shutdown"),
    compact: (opts?: { customInstructions?: string }) => {
      calls.push("compact");
      compactCalls.push(opts ?? {});
    },
    sessionManager: { getSessionName: () => "my-session" },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 100000 }),
    ui: {
      notify: (msg: string, type?: "info" | "warning" | "error") => void notifyCalls.push([msg, type ?? "info"]),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, calls, notifyCalls, compactCalls };
}

async function fire(commands: Map<string, Cmd>, name: string, ctx: unknown): Promise<void> {
  const cmd = commands.get(name);
  if (!cmd) throw new Error(`no command registered for ${name}`);
  await cmd.handler("", ctx);
}

describe("SHORTCUTS", () => {
  it("contains no empty names or descriptions", () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of SHORTCUTS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("does not collide with known built-in command names", () => {
    const builtins = ["quit", "new", "compact", "name", "session", "tree", "reload", "help"];
    for (const s of SHORTCUTS) {
      expect(builtins).not.toContain(s.name);
    }
  });
});

describe("registerShortcuts", () => {
  it("registers one command per shortcut", () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const names = [...commands.keys()].sort();
    const expected = [...SHORTCUTS].map((s) => s.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(expected);
  });

  it("stores each registered description", () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    for (const s of SHORTCUTS) {
      expect(commands.get(s.name)?.description).toBe(s.description);
    }
  });
});

describe("quit-family shortcuts", () => {
  for (const name of ["exit", "bye", "q", "close"]) {
    it(`${name} shuts down pi`, async () => {
      const { pi, commands } = makePi();
      registerShortcuts(pi);
      const { ctx, calls } = makeCtx();
      await fire(commands, name, ctx);
      expect(calls).toContain("shutdown");
    });
  }
});

describe("compaction shortcuts", () => {
  it("comp runs with default custom instructions", async () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const { ctx, compactCalls } = makeCtx();
    await fire(commands, "comp", ctx);
    expect(compactCalls[0].customInstructions).toContain("Summarize");
  });

  it("summarize runs compaction too", async () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const { ctx, compactCalls } = makeCtx();
    await fire(commands, "summarize", ctx);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].customInstructions).toBeDefined();
  });
});

describe("info shortcut", () => {
  it("reports session name, directory, and context usage", async () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const { ctx, notifyCalls } = makeCtx();
    await fire(commands, "info", ctx);
    const msg = notifyCalls[0][0];
    expect(msg).toContain("my-session");
    expect(msg).toContain("/tmp/workspace");
    expect(msg).toContain("5000/100000");
    expect(notifyCalls[0][1]).toBe("info");
  });

  it("reports unknown context when usage is unavailable", async () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const notifyCalls: string[] = [];
    const ctx = {
      cwd: "/somewhere",
      sessionManager: { getSessionName: () => undefined },
      getContextUsage: () => undefined,
      ui: {
        notify: (m: string) => void notifyCalls.push(m),
      },
    } as unknown as ExtensionCommandContext;
    await fire(commands, "info", ctx);
    expect(notifyCalls[0]).toContain("unnamed");
    expect(notifyCalls[0]).toContain("unknown");
  });
});

describe("time shortcut", () => {
  it("notifies the current date/time string", async () => {
    const { pi, commands } = makePi();
    registerShortcuts(pi);
    const { ctx, notifyCalls } = makeCtx();
    await fire(commands, "time", ctx);
    expect(notifyCalls[0][1]).toBe("info");
    expect(new Date(notifyCalls[0][0]).toString()).toBe(new Date().toString());
  });
});

describe("error handling in handlers", () => {
  it("reports an error instead of throwing when a run function throws", async () => {
    const commands = new Map<string, Cmd>();
    const failingPi = {
      registerCommand: (name: string, cmd: Cmd) => {
        commands.set(name, cmd);
      },
    } as unknown as ExtensionAPI;
    registerShortcuts(failingPi);

    const notifyCalls: string[] = [];
    const throwingCtx = {
      cwd: "/tmp",
      shutdown: () => {
        throw new Error("boom");
      },
      ui: {
        notify: (m: string) => void notifyCalls.push(m),
      },
    } as unknown as ExtensionCommandContext;

    const cmd = commands.get("exit") as Cmd;
    await expect(cmd.handler("", throwingCtx)).resolves.toBeUndefined();
    expect(notifyCalls[0].toLowerCase()).toContain("failed");
    expect(notifyCalls[0].toLowerCase()).toContain("exit");
  });
});
