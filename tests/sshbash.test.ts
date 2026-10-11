import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskRegistry, publishSharedTaskRegistry } from "../lib/superbash";
import {
  buildSshCommandArgs,
  canonicalTargetKey,
  createSshBashOperations,
  defaultControlDir,
  describeConnection,
  destinationArg,
  parseSshConnectTimeoutSecs,
  parseSshIdleSecs,
  parseSshTarget,
  parseStrictHostKey,
  registerSshBashExtension,
  SSH_TOOL_NAME,
  type SshProcess,
  type SshSpawn,
} from "../extensions/sshbash";

describe("socket directory", () => {
  it("keeps control sockets exclusively under the pi agent dir", () => {
    expect(defaultControlDir()).toMatch(/\/ssh$/);
    expect(defaultControlDir()).toContain(".pi");
  });
});

describe("env knobs", () => {
  it("defaults, accepts, and falls back on invalid values", () => {
    expect(parseSshIdleSecs({})).toBe(600);
    expect(parseSshIdleSecs({ PI_SSH_IDLE_SECS: "60" })).toBe(60);
    expect(parseSshIdleSecs({ PI_SSH_IDLE_SECS: " 120 " })).toBe(120);
    expect(parseSshIdleSecs({ PI_SSH_IDLE_SECS: "nope" })).toBe(600);
    expect(parseSshIdleSecs({ PI_SSH_IDLE_SECS: "-5" })).toBe(600);
    expect(parseSshIdleSecs({ PI_SSH_IDLE_SECS: "999999" })).toBe(600);
    expect(parseSshConnectTimeoutSecs({})).toBe(20);
    expect(parseSshConnectTimeoutSecs({ PI_SSH_CONNECT_TIMEOUT: "5" })).toBe(5);
    expect(parseSshConnectTimeoutSecs({ PI_SSH_CONNECT_TIMEOUT: "0" })).toBe(20); // below the floor of 1
  });

  it("host-key policy defaults to TOFU and only accepts real ssh values", () => {
    expect(parseStrictHostKey({})).toBe("accept-new");
    expect(parseStrictHostKey({ PI_SSH_STRICT_HOST_KEY: "yes" })).toBe("yes");
    expect(parseStrictHostKey({ PI_SSH_STRICT_HOST_KEY: "no" })).toBe("no");
    expect(parseStrictHostKey({ PI_SSH_STRICT_HOST_KEY: "yolo" })).toBe("accept-new");
  });
});

describe("parseSshTarget", () => {
  it("accepts user@host, bare hosts and aliases", () => {
    expect(parseSshTarget("root@213.181.111.138")).toEqual({ target: { user: "root", host: "213.181.111.138" } });
    expect(parseSshTarget("gpu-box")).toEqual({ target: { host: "gpu-box" } });
    expect(parseSshTarget("Host.Example.COM")).toEqual({ target: { host: "Host.Example.COM" } });
  });

  it("parses ssh:// URIs with user and port", () => {
    expect(parseSshTarget("ssh://root@10.0.0.1:2222")).toEqual({
      target: { user: "root", host: "10.0.0.1", port: 2222 },
    });
    expect(parseSshTarget("ssh://10.0.0.1")).toEqual({ target: { host: "10.0.0.1" } });
  });

  it("a port param overrides a URI port and validates", () => {
    expect(parseSshTarget("ssh://root@10.0.0.1:2222", 33)).toEqual({
      target: { user: "root", host: "10.0.0.1", port: 33 },
    });
    expect(parseSshTarget("h", 0)).toMatchObject({ error: expect.stringContaining("port") });
    expect(parseSshTarget("h", 70_000)).toMatchObject({ error: expect.stringContaining("port") });
    expect(parseSshTarget("h", 1.5)).toMatchObject({ error: expect.stringContaining("port") });
  });

  it("accepts an identity file and expands it at argv build, not parse", () => {
    expect(parseSshTarget("root@box", undefined, "~/.ssh/id_ed25519")).toEqual({
      target: { user: "root", host: "box", key: "~/.ssh/id_ed25519" },
    });
    expect(parseSshTarget("root@box", undefined, "  ")).toMatchObject({ error: expect.stringContaining("key") });
  });

  it("rejects garbage targets with actionable errors", () => {
    expect(parseSshTarget("")).toMatchObject({ error: expect.stringContaining("empty") });
    expect(parseSshTarget("   ")).toMatchObject({ error: expect.stringContaining("empty") });
    expect(parseSshTarget("root@box extra")).toMatchObject({ error: expect.stringContaining("whitespace") });
    expect(parseSshTarget("ssh://")).toMatchObject({ error: expect.stringContaining("host") });
    expect(parseSshTarget("root@")).toMatchObject({ error: expect.stringContaining("invalid target") });
    expect(parseSshTarget("root@box;rm -rf")).toMatchObject({ error: expect.stringContaining("whitespace") });
    expect(parseSshTarget("root@box;rm")).toMatchObject({ error: expect.stringContaining("invalid host") });
  });

  it("cannot construct an ssh option from the user or host (no local -o injection)", () => {
    // The whole user@host lands as ONE argv element, and ssh's getopt accepts
    // fused `-oVALUE` options — so `-oProxyCommand=…@host` would execute
    // locally. The charset + no-leading-dash rules must make it unconstructible.
    expect(parseSshTarget("-oProxyCommand=touch@host")).toMatchObject({
      error: expect.stringContaining("invalid user"),
    });
    expect(parseSshTarget("--G@host")).toMatchObject({ error: expect.stringContaining("invalid user") });
    expect(parseSshTarget("-weird-host")).toMatchObject({ error: expect.stringContaining("invalid host") });
    expect(parseSshTarget("good.user-1@host")).toMatchObject({ target: { user: "good.user-1" } });
  });

  it("survives malformed percent-encoding in URI usernames instead of throwing", () => {
    expect(parseSshTarget("ssh://%zz@host")).toMatchObject({ error: expect.stringContaining("invalid username") });
    expect(parseSshTarget("ssh://%E0%A4@host")).toMatchObject({ error: expect.stringContaining("invalid username") });
    // A decoded %40 puts @ in the user — rejected: it would re-split user@host.
    expect(parseSshTarget("ssh://user%40name@host")).toMatchObject({ error: expect.stringContaining("invalid user") });
  });
});

describe("canonicalTargetKey / destinationArg / describeConnection", () => {
  const t = (raw: string, port?: number) => parseSshTarget(raw, port).target!;

  it("keys on user@host:port — the multiplex identity", () => {
    expect(canonicalTargetKey(t("root@Box"))).toBe("root@box:22");
    expect(canonicalTargetKey(t("root@box", 13839))).toBe("root@box:13839");
    expect(canonicalTargetKey(t("box"))).toBe("box:22");
    expect(canonicalTargetKey(t("root@Box"))).toBe(canonicalTargetKey(t("root@box")));
    expect(canonicalTargetKey(t("root@box"))).toBe(canonicalTargetKey(t("root@box", 22))); // explicit default port = same destination
    expect(canonicalTargetKey(t("root@box"))).not.toBe(canonicalTargetKey(t("admin@box")));
  });

  it("renders the destination and connection names", () => {
    expect(destinationArg(t("root@box"))).toBe("root@box");
    expect(destinationArg(t("box"))).toBe("box");
    const conn = { id: "ssh-1", target: t("root@1.2.3.4", 13839), canonical: "x" };
    expect(describeConnection(conn)).toBe("root@1.2.3.4:13839");
    expect(describeConnection({ ...conn, target: { ...conn.target, key: "~/.ssh/k" } })).toBe(
      "root@1.2.3.4:13839 (key ~/.ssh/k)",
    );
  });
});

describe("buildSshCommandArgs", () => {
  const opts = {
    controlDir: "/tmp/cm",
    idleSecs: 600,
    connectTimeoutSecs: 20,
    strictHostKeyChecking: "accept-new" as const,
  };

  it("builds the multiplexing argv with the command as one element", () => {
    const args = buildSshCommandArgs(parseSshTarget("root@1.2.3.4", 13839).target!, "kill -9 5387; sleep 2", opts);
    // Multiplexing + non-interactive auth + bounded connect + TOFU host keys.
    for (const flag of ["BatchMode=yes", "ControlMaster=auto", "ControlPersist=600", "ConnectTimeout=20"]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain(`ControlPath=${opts.controlDir}/cm-%C`);
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("13839");
    // Destination and the whole command as the final two argv elements —
    // argv-spawned, so no local quoting can mangle the command.
    expect(args[args.length - 2]).toBe("root@1.2.3.4");
    expect(args[args.length - 1]).toBe("kill -9 5387; sleep 2");
  });

  it("expands ~ in identity paths (no local shell to do it) and omits absent options", () => {
    const withKey = buildSshCommandArgs(parseSshTarget("box", undefined, "~/keys/id_ed25519").target!, "uptime", opts);
    expect(withKey).toContain("-i");
    expect(withKey[withKey.indexOf("-i") + 1]).toMatch(/^\/.*\/keys\/id_ed25519$/);
    expect(withKey).not.toContain("-p");
    const bare = buildSshCommandArgs(parseSshTarget("box").target!, "uptime", opts);
    expect(bare).not.toContain("-i");
  });

  it("carries the idle and connect-timeout knobs", () => {
    const args = buildSshCommandArgs(parseSshTarget("box").target!, "uptime", {
      ...opts,
      idleSecs: 60,
      connectTimeoutSecs: 5,
    });
    expect(args).toContain("ControlPersist=60");
    expect(args).toContain("ConnectTimeout=5");
  });

  it("carries the host-key policy", () => {
    const strict = buildSshCommandArgs(parseSshTarget("box").target!, "uptime", {
      ...opts,
      strictHostKeyChecking: "yes",
    });
    expect(strict).toContain("StrictHostKeyChecking=yes");
    expect(strict).not.toContain("StrictHostKeyChecking=accept-new");
  });
});

/** Hand-rolled fake of the ssh child boundary: recording handlers, manual events. */
class FakeSshChild implements SshProcess {
  stdoutHandlers: ((chunk: Buffer) => void)[] = [];
  stderrHandlers: ((chunk: Buffer) => void)[] = [];
  closeHandlers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  errorHandlers: ((err: Error) => void)[] = [];
  kills: NodeJS.Signals[] = [];
  stdout = {
    on: (_event: "data", cb: (chunk: Buffer) => void) => {
      this.stdoutHandlers.push(cb);
    },
  };
  stderr = {
    on: (_event: "data", cb: (chunk: Buffer) => void) => {
      this.stderrHandlers.push(cb);
    },
  };
  on(event: "close" | "error", cb: never) {
    (event === "close" ? this.closeHandlers : this.errorHandlers).push(cb);
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
  }
  emitStdout(text: string) {
    for (const h of this.stdoutHandlers) h(Buffer.from(text));
  }
  emitStderr(text: string) {
    for (const h of this.stderrHandlers) h(Buffer.from(text));
  }
  close(code: number | null, signal: NodeJS.Signals | null = null) {
    for (const h of this.closeHandlers) h(code, signal);
  }
}

function fakeSpawn() {
  const children: FakeSshChild[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const spawnFn: SshSpawn = (command, args) => {
    commands.push({ command, args });
    const child = new FakeSshChild();
    children.push(child);
    return child;
  };
  return { children, commands, spawnFn };
}

const OPS = {
  controlDir: "/tmp/cm-test",
  idleSecs: 600,
  connectTimeoutSecs: 20,
  strictHostKeyChecking: "accept-new" as const,
};
const target = parseSshTarget("root@1.2.3.4", 13839).target!;

describe("createSshBashOperations", () => {
  it("spawns multiplexed ssh, merges streams, and resolves the remote exit code", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const chunks: string[] = [];
    const p = ops.exec("date", "/cwd", { onData: (b) => chunks.push(b.toString()) });
    await new Promise((r) => setImmediate(r));
    expect(f.commands[0].command).toBe("ssh");
    expect(f.commands[0].args).toContain("ControlMaster=auto");
    f.children[0].emitStdout("Wed ");
    f.children[0].emitStderr("deprecation notice\n");
    f.children[0].emitStdout("Nov 5\n");
    f.children[0].close(0);
    await expect(p).resolves.toEqual({ exitCode: 0 });
    expect(chunks.join("")).toBe("Wed deprecation notice\nNov 5\n");
  });

  it("reports exit 255 as a connection failure carrying ssh's stderr", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const p = ops.exec("date", "/cwd", { onData: () => {} });
    await new Promise((r) => setImmediate(r));
    f.children[0].emitStderr("ssh: connect to host 1.2.3.4 port 13839: Connection refused\r\n");
    f.children[0].close(255);
    await expect(p).rejects.toThrow("ssh: ssh: connect to host 1.2.3.4 port 13839: Connection refused (root@1.2.3.4)");
  });

  it("rejects aborted on signal and kills the local client", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const controller = new AbortController();
    const p = ops.exec("sleep 100", "/cwd", { onData: () => {}, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    expect(f.children[0].kills).toContain("SIGTERM");
    f.children[0].close(null, "SIGTERM");
    await expect(p).rejects.toThrow("aborted");
  });

  it("rejects timeout:<secs> and kills the local client", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const p = ops.exec("sleep 100", "/cwd", { onData: () => {}, timeout: 0.05 });
    // Wait for the observable condition (the kill), not a wall-clock guess,
    // then simulate the client exiting — a real ssh exits on SIGTERM.
    await vi.waitFor(() => expect(f.children[0].kills).toContain("SIGTERM"), { timeout: 2_000 });
    f.children[0].close(null, "SIGTERM");
    await expect(p).rejects.toThrow("timeout:0.05");
  });

  it("never spawns when the signal is already aborted", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const controller = new AbortController();
    controller.abort();
    await expect(ops.exec("date", "/cwd", { onData: () => {}, signal: controller.signal })).rejects.toThrow("aborted");
    expect(f.children).toHaveLength(0);
  });

  it("escalates to SIGKILL when the client ignores SIGTERM, then reports aborted", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const controller = new AbortController();
    const p = ops.exec("sleep 100", "/cwd", { onData: () => {}, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    expect(f.children[0].kills).toContain("SIGTERM");
    // The fake never closes (a wedged client): the escalation must land.
    await vi.waitFor(() => expect(f.children[0].kills).toContain("SIGKILL"), { timeout: 3_500 });
    f.children[0].close(null, "SIGKILL");
    await expect(p).rejects.toThrow("aborted");
  }, 8_000);

  it("reports exit 255 with no stderr as a bare connection failure", async () => {
    const f = fakeSpawn();
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const p = ops.exec("date", "/cwd", { onData: () => {} });
    await new Promise((r) => setImmediate(r));
    f.children[0].close(255);
    await expect(p).rejects.toThrow(`ssh: connection failed (${destinationArg(target)})`);
  });

  it("surfaces spawn throws and child errors", async () => {
    const boom: SshSpawn = () => {
      throw new Error("no ssh binary");
    };
    const ops = createSshBashOperations(target, { ...OPS, spawnFn: boom });
    await expect(ops.exec("date", "/cwd", { onData: () => {} })).rejects.toThrow("no ssh binary");

    const f = fakeSpawn();
    const ops2 = createSshBashOperations(target, { ...OPS, spawnFn: f.spawnFn });
    const p2 = ops2.exec("date", "/cwd", { onData: () => {} });
    await new Promise((r) => setImmediate(r));
    for (const h of f.children[0].errorHandlers) h(new Error("EACCES"));
    await expect(p2).rejects.toThrow("EACCES");
  });

  it("accepts the real ssh binary parsing our full option set (ssh -G, no network)", async (ctx) => {
    const haveSsh = await new Promise<boolean>((resolve) => {
      const probe = spawn("ssh", ["-V"]);
      probe.on("error", () => resolve(false));
      probe.on("close", () => resolve(true));
    });
    if (!haveSsh) return ctx.skip(); // visible skip, never a silent pass
    const options = buildSshCommandArgs(target, "uptime", OPS).slice(0, -2); // drop dest + command
    const args = ["-G", ...options, "localhost"];
    const result = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn("ssh", args);
      let text = "";
      child.stdout?.on("data", (b) => (text += b.toString()));
      child.on("error", () => resolve({ code: -1, text: "ssh binary vanished" }));
      child.on("close", (code) => resolve({ code, text }));
    });
    expect(result.code).toBe(0);
    expect(result.text).toContain("controlmaster auto");
    expect(result.text).toContain("batchmode yes");
    expect(result.text).toContain("controlpersist 600");
  }, 10_000);
});

function makePi() {
  const tools = new Map<
    string,
    {
      name: string;
      description: string;
      parameters: { properties: Record<string, unknown> };
      promptGuidelines?: string[];
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<unknown>;
    }
  >();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const pi = {
    registerTool: (t: never) => tools.set((t as { name: string }).name, t as never),
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => events.set(event, handler),
  } as unknown as ExtensionAPI;
  return { pi, tools, events };
}

const registryDeps = () => {
  const sendUserMessage = vi.fn();
  const registry = createTaskRegistry({ sendUserMessage });
  return { sendUserMessage, registry };
};

// pi's inline bash definition reads the full session slice (getSessionId/File
// for the PI_* env) — the same shape pi passes in production.
const CTX = {
  sessionManager: { getSessionDir: () => undefined, getSessionId: () => "s1", getSessionFile: () => undefined },
} as never;

describe("registerSshBashExtension", () => {
  it("registers ssh_bash with the target params and remote-use guidance", () => {
    const { pi, tools } = makePi();
    registerSshBashExtension(pi, { spawnFn: fakeSpawn().spawnFn });
    const tool = tools.get(SSH_TOOL_NAME)!;
    expect(Object.keys(tool.parameters.properties)).toEqual(
      expect.arrayContaining(["command", "timeout", "wait", "target", "port", "key"]),
    );
    expect(tool.description).toContain("multiplex");
    expect(tool.description).toContain("non-interactive");
    expect(tool.promptGuidelines?.join("\n")).toContain("ssh-1");
  });

  it("runs inline commands through the ssh ops and names the connection", async () => {
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    const p = tool.execute(
      "1",
      { command: "nvidia-smi", target: "root@1.2.3.4", port: 13839, key: "~/.ssh/id_ed25519" },
      undefined,
      undefined,
      CTX,
    ) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    await new Promise((r) => setImmediate(r));
    f.children[0].emitStdout("GPU 0: 95%\n");
    f.children[0].close(0);
    const result = await p;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("GPU 0: 95%");
    expect(result.content[0].text).toContain("[ssh-1] root@1.2.3.4:13839 (key ~/.ssh/id_ed25519)");
    expect(result.content[0].text).toContain('target: "ssh-1"');
  });

  it("reuses connections by id and by repeated destination, without re-hinting", async () => {
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    const run = (params: Record<string, unknown>) => {
      const exec = tool.execute("1", params, undefined, undefined, CTX) as Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
      return new Promise<{ text: string; child: FakeSshChild }>(async (resolve, reject) => {
        try {
          await new Promise((r) => setImmediate(r));
          const child = f.children[f.children.length - 1];
          child.emitStdout("ok\n");
          child.close(0);
          resolve({ text: (await exec).content[0].text, child });
        } catch (e) {
          reject(e as Error);
        }
      });
    };
    const first = await run({ command: "date", target: "root@box" });
    expect(first.text).toContain("[ssh-1] root@box");
    expect(first.text).toContain('target: "ssh-1"');
    const byId = await run({ command: "date", target: "ssh-1" });
    expect(byId.text).toContain("[ssh-1] root@box");
    expect(byId.text).not.toContain("later calls can pass"); // reuse hint only on first sight
    const byDest = await run({ command: "date", target: "root@box", port: 22 });
    expect(byDest.text).toContain("[ssh-1]"); // same canonical destination, same connection
  });

  it("fails fast on bad targets without spawning", async () => {
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    for (const params of [{ command: "x" }, { command: "x", target: "  " }, { command: "x", target: "ssh-99" }]) {
      const result = (await tool.execute("1", params, undefined, undefined, CTX)) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error:");
    }
    expect(f.children).toHaveLength(0);
  });

  it("adopts background tasks into the shared registry under the connection head", async () => {
    const { sendUserMessage, registry } = registryDeps();
    publishSharedTaskRegistry(registry);
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    const result = (await tool.execute(
      "1",
      { command: "train.py --epochs 40", target: "root@1.2.3.4", port: 13839, wait: "background" },
      undefined,
      undefined,
      CTX,
    )) as { content: Array<{ type: string; text: string }>; details: { id: string } };
    expect(result.content[0].text).toContain("Backgrounded");
    expect(result.content[0].text).toContain("[ssh-1]");
    expect(registry.running()[0]).toMatchObject({ kind: "bash", name: "[ssh-1] train.py --epochs 40" });
    f.children[0].emitStdout("epoch 1 done\n");
    f.children[0].close(0);
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
    const wake = sendUserMessage.mock.calls[0][0] as string;
    expect(wake).toContain("[background] bash (");
    expect(wake).toContain("— [ssh-1] train.py --epochs 40");
    expect(wake).toContain("epoch 1 done");
  });

  it("closes the session's control masters on session_shutdown", () => {
    const { pi, tools, events } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    // Establish a connection so the sweep has something to close.
    void tools
      .get(SSH_TOOL_NAME)!
      .execute("1", { command: "true", target: "root@box", port: 2222 }, undefined, undefined, CTX);
    (events.get("session_shutdown") as (e?: unknown) => unknown)({ type: "session_shutdown" });
    const sweep = f.commands[f.commands.length - 1];
    expect(sweep.args).toContain("-O");
    expect(sweep.args[sweep.args.indexOf("-O") + 1]).toBe("exit");
    expect(sweep.args).toContain(`ControlPath=${OPS.controlDir}/cm-%C`);
    expect(sweep.args).toContain("-p");
    expect(sweep.args[sweep.args.indexOf("-p") + 1]).toBe("2222");
    expect(sweep.args[sweep.args.length - 1]).toBe("root@box");
  });

  /**
   * Run one call against the fake ssh: waits for the spawned child (or the
   * tool error that precedes spawning), drives it to the given outcome, and
   * returns the first text block. Also exposes the child for argv inspection.
   */
  async function runTool(
    tool: {
      execute: (
        id: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<unknown>;
    },
    f: { children: FakeSshChild[] },
    params: Record<string, unknown>,
    outcome: { stdout?: string; code?: number } = {},
  ): Promise<{ text: string; isError?: boolean; child?: FakeSshChild }> {
    const before = f.children.length;
    const exec = tool.execute("1", params, undefined, undefined, CTX) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
    const spawned = vi.waitFor(() => {
      if (f.children.length <= before) throw new Error("not spawned yet");
      return f.children[f.children.length - 1];
    });
    const raced = (await Promise.race([spawned.then((child) => ({ child })), exec.then((result) => ({ result }))])) as {
      child?: FakeSshChild;
      result?: Awaited<typeof exec>;
    };
    if (!raced.child) {
      return { text: raced.result!.content[0].text, isError: raced.result!.isError };
    }
    if (outcome.stdout) raced.child.emitStdout(outcome.stdout);
    raced.child.close(outcome.code ?? 0);
    const result = await exec;
    return { text: result.content[0].text, isError: result.isError, child: raced.child };
  }

  it("reports a failed connection as an error, with the machine line but no reuse hint", async () => {
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const result = await runTool(
      tools.get(SSH_TOOL_NAME)!,
      f,
      {
        command: "uptime",
        target: "root@10.9.9.9",
        port: 22,
      },
      { code: 255 },
    );
    // The fake emits no stderr; close(255) is the bare connection-failure path.
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ssh: connection failed (root@10.9.9.9)");
    expect(result.text).toContain("[ssh-1] root@10.9.9.9"); // the machine line still identifies the host
    expect(result.text).not.toContain("later calls can pass"); // no hint on a failed connection
  });

  it("folds a retry's identity file into the stored connection", async () => {
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    // First attempt without a key fails to authenticate.
    await runTool(tool, f, { command: "uptime", target: "root@box" }, { code: 255 });
    // The retry supplies the key: its argv must carry -i even though the
    // destination is already registered.
    await runTool(tool, f, { command: "uptime", target: "root@box", key: "~/.ssh/id_ed25519" });
    const retryArgs = f.commands[1].args;
    expect(retryArgs).toContain("-i");
    expect(retryArgs[retryArgs.indexOf("-i") + 1]).toMatch(/id_ed25519$/);
  });

  it("adopts into a shared registry published after registration (load order free)", async () => {
    const registryDeps2 = registryDeps();
    const registry = registryDeps2.registry;
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    // The registry appears only AFTER sshbash registered — the per-call read
    // must pick it up regardless of extension load order.
    publishSharedTaskRegistry(registry);
    const exec = tool.execute(
      "1",
      { command: "train.py", target: "root@box", wait: "background" },
      undefined,
      undefined,
      CTX,
    ) as Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    await vi.waitFor(() => expect(registry.running()).toHaveLength(1));
    expect(registry.running()[0]).toMatchObject({ kind: "bash", name: "[ssh-1] train.py" });
    const result = await exec;
    expect(result.content[0].text).toContain("Backgrounded");
  });

  it("fails background modes with an explicit error when no shared registry exists", async () => {
    publishSharedTaskRegistry(undefined as never);
    const { pi, tools } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const result = await runTool(tools.get(SSH_TOOL_NAME)!, f, {
      command: "train.py",
      target: "root@box",
      wait: "background",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('use wait: "inline"');
    expect(f.children).toHaveLength(0); // nothing adopted, nothing spawned
  });

  it("allocates ssh-1/ssh-2 per destination and sweeps every master on shutdown", async () => {
    const { pi, tools, events } = makePi();
    const f = fakeSpawn();
    registerSshBashExtension(pi, { ...OPS, spawnFn: f.spawnFn } as never);
    const tool = tools.get(SSH_TOOL_NAME)!;
    const first = await runTool(tool, f, { command: "date", target: "root@box" }, { stdout: "ok\n" });
    const second = await runTool(tool, f, { command: "date", target: "admin@other", port: 2222 }, { stdout: "ok\n" });
    expect(first.text).toContain("[ssh-1] root@box");
    expect(second.text).toContain("[ssh-2] admin@other:2222");
    expect(f.children).toHaveLength(2);

    (events.get("session_shutdown") as (e?: unknown) => unknown)({ type: "session_shutdown" });
    const sweeps = f.commands.slice(2);
    expect(sweeps).toHaveLength(2);
    const destinations = sweeps.map((s) => s.args[s.args.length - 1]).sort();
    expect(destinations).toEqual(["admin@other", "root@box"]);
    for (const s of sweeps) {
      expect(s.args).toContain("-O");
      expect(s.args).toContain(`ControlPath=${OPS.controlDir}/cm-%C`);
    }
    // Each sweep carries its own port.
    const adminSweep = sweeps.find((s) => s.args[s.args.length - 1] === "admin@other")!;
    expect(adminSweep.args[adminSweep.args.indexOf("-p") + 1]).toBe("2222");
  });
});
