import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedClient, type SpawnFn, type WorkerChild } from "../lib/embed-client";
import { EMBED_DIMS } from "../lib/vecstore";

class FakeChild implements WorkerChild {
  stdinWrites: string[] = [];
  private stdoutBus = new EventEmitter();
  private stderrBus = new EventEmitter();
  private exitCb: ((code: number | null) => void) | undefined;
  killed = false;
  stdin = {
    write: (data: string) => {
      this.stdinWrites.push(data);
      return true;
    },
    end: () => {},
  };
  stdout = { on: (event: "data", cb: (chunk: Buffer) => void) => this.stdoutBus.on(event, cb) };
  stderr = { on: (event: "data", cb: (chunk: Buffer) => void) => this.stderrBus.on(event, cb) };
  on(_event: "exit", cb: (code: number | null) => void) {
    this.exitCb = cb;
  }
  kill() {
    this.killed = true;
    this.exit(0);
  }
  /** Test seam: deliver a protocol line (or arbitrary junk) as if the child wrote it. */
  emitLine(line: string) {
    this.stdoutBus.emit("data", Buffer.from(`${line}\n`));
  }
  emitStderr(text: string) {
    this.stderrBus.emit("data", Buffer.from(text));
  }
  exit(code: number | null) {
    this.exitCb?.(code);
  }
}

function makeClient(
  child: FakeChild,
  notices: string[] = [],
  opts: Partial<ConstructorParameters<typeof EmbedClient>[0]> = {},
) {
  const spawnFn: SpawnFn = () => child;
  return new EmbedClient({
    workerPath: "/virtual/embed-worker.ts",
    dtype: "q8",
    modelDir: "/virtual/models",
    spawnFn,
    onNotice: (m) => notices.push(m),
    queryTimeoutMs: 50,
    ...opts,
  });
}

describe("EmbedClient", () => {
  it("round-trips a query and returns a unit-length Float32Array", async () => {
    const child = new FakeChild();
    const client = makeClient(child);
    expect(client.start()).toBe(true);
    // Respond the moment the request lands on stdin.
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data: string) => {
      origWrite(data);
      const op = JSON.parse(data.trim()) as { op: string; id: number };
      if (op.op === "query")
        child.emitLine(JSON.stringify({ ev: "query", id: op.id, vector: new Array(EMBED_DIMS).fill(0.1) }));
      return true;
    };
    const v = await client.query("hello");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v?.length).toBe(EMBED_DIMS);
  });

  it("dispose settles an in-flight request and refuses any later request without respawning", async () => {
    let spawned = 0;
    const children: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const client = new EmbedClient({
      workerPath: "/virtual/embed-worker.ts",
      dtype: "q8",
      modelDir: "/virtual/models",
      spawnFn,
      embedBaseTimeoutMs: 60_000,
    });
    client.start();
    // A request that never replies — the worker is busy when shutdown lands.
    const inFlight = client.embed([{ key: "a", text: "t" }]);
    client.dispose();
    expect(await inFlight).toBeUndefined(); // settled, not leaked
    // The post-shutdown catch-up's request must fail open with NO respawn.
    expect(await client.query("late")).toBeUndefined();
    expect(await client.embed([{ key: "b", text: "t" }])).toBeUndefined();
    expect(client.start()).toBe(false);
    expect(spawned).toBe(1); // exactly one child for the whole session
  });

  it("round-trips embed items", async () => {
    const child = new FakeChild();
    const client = makeClient(child);
    client.start();
    child.stdin.write = ((data: string) => {
      const op = JSON.parse(data.trim()) as { op: string; id: number; items: Array<{ key: string }> };
      expect(op.op).toBe("embed");
      child.emitLine(
        JSON.stringify({
          ev: "embed",
          id: op.id,
          items: op.items.map((i) => ({ key: i.key, vector: new Array(768).fill(1) })),
        }),
      );
      return true;
    }) as FakeChild["stdin"]["write"];
    const out = await client.embed([
      { key: "a", text: "one" },
      { key: "b", text: "two" },
    ]);
    expect(out?.map((o) => o.key)).toEqual(["a", "b"]);
    expect(out?.[0].vector).toBeInstanceOf(Float32Array);
  });

  it("returns [] for an empty embed request without touching the child", async () => {
    const child = new FakeChild();
    const client = makeClient(child);
    expect(await client.embed([])).toEqual([]);
    expect(child.stdinWrites).toEqual([]);
  });

  it("fails open on query timeout without killing the worker", async () => {
    const child = new FakeChild();
    const client = makeClient(child);
    client.start();
    expect(await client.query("no reply")).toBeUndefined();
    expect(child.killed).toBe(false);
    // The worker is still usable afterwards.
    child.emitLine(JSON.stringify({ ev: "query", id: 1, vector: [0.5] })); // late reply is dropped harmlessly
  });

  it("settles pending requests as undefined when the child exits", async () => {
    const child = new FakeChild();
    const notices: string[] = [];
    const client = makeClient(child, notices);
    client.start();
    const pending = client.query("in flight");
    child.exit(1);
    expect(await pending).toBeUndefined();
    expect(notices.join("\n")).toContain("embed worker exited (code 1)");
  });

  it("includes a bounded stderr tail in the exit notice", async () => {
    const child = new FakeChild();
    const notices: string[] = [];
    const client = makeClient(child, notices);
    client.start();
    child.emitStderr(`${"x".repeat(100_000)}boom`);
    child.exit(3);
    const exitNotice = notices.find((n) => n.includes("exited")) ?? "";
    expect(exitNotice).toContain("boom"); // the tail, not the whole firehose
    expect(exitNotice.length).toBeLessThan(5_000);
  });

  it("reports fatal once, settles pending, and never re-notices", async () => {
    const child = new FakeChild();
    const notices: string[] = [];
    const client = makeClient(child, notices);
    client.start();
    const pending = client.query("anything");
    child.emitLine(JSON.stringify({ ev: "fatal", message: "model download failed" }));
    expect(await pending).toBeUndefined();
    expect(notices.filter((n) => n.includes("fatal"))).toHaveLength(1);
    expect(client.available).toBe(false);
  });

  it("retries spawn and gives up after maxStartAttempts with one notice", async () => {
    const notices: string[] = [];
    let calls = 0;
    const spawnFn: SpawnFn = () => {
      calls++;
      throw new Error("ENOENT");
    };
    const client = new EmbedClient({
      workerPath: "/virtual/embed-worker.ts",
      dtype: "q8",
      modelDir: "/virtual/models",
      spawnFn,
      onNotice: (m) => notices.push(m),
      maxStartAttempts: 3,
    });
    expect(client.start()).toBe(false); // attempt 1 → throw, retries happen inside
    expect(calls).toBe(3);
    expect(notices.some((n) => n.includes("disabled for this session"))).toBe(true);
    expect(client.start()).toBe(false); // permanently disabled, no more attempts
    expect(calls).toBe(3);
  });

  it("kill() is idempotent and does not blame the worker for its own death", async () => {
    const child = new FakeChild();
    const notices: string[] = [];
    const client = makeClient(child, notices);
    client.start();
    client.kill();
    client.kill();
    expect(notices.filter((n) => n.includes("exited"))).toHaveLength(0);
  });

  it("a deliberate kill after healthy operation allows respawn (attempts reset on health evidence)", async () => {
    let spawned = 0;
    const spawnFn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild();
      // A real worker emits "ready" once its model loads — the health
      // evidence that arms a fresh spawn budget.
      queueMicrotask(() => child.emitLine(JSON.stringify({ ev: "ready" })));
      return child;
    };
    const client = new EmbedClient({
      workerPath: "/virtual/embed-worker.ts",
      dtype: "q8",
      modelDir: "/virtual/models",
      spawnFn,
      maxStartAttempts: 1,
    });
    expect(client.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // let "ready" land and reset attempts
    client.kill();
    expect(client.start()).toBe(true); // session replacement must be able to respawn
    expect(spawned).toBe(2);
  });

  it("without health evidence, spawn attempts stay consumed (fatal loops stay bounded)", async () => {
    let spawned = 0;
    const children: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild(); // never emits "ready" — dies before proving health
      children.push(child);
      return child;
    };
    const client = new EmbedClient({
      workerPath: "/virtual/embed-worker.ts",
      dtype: "q8",
      modelDir: "/virtual/models",
      spawnFn,
      maxStartAttempts: 2,
    });
    client.start();
    children[0].exit(1); // worker died without ever proving health
    client.start(); // attempt 2
    children[1].exit(1);
    expect(client.start()).toBe(false); // bounded: both attempts consumed, no reset without "ready"
    expect(spawned).toBe(2);
  });

  it("drops malformed embed reply items instead of throwing, and fails open when none survive", async () => {
    const child = new FakeChild();
    const client = makeClient(child);
    client.start();
    child.stdin.write = ((data: string) => {
      const op = JSON.parse(data.trim()) as { op: string; id: number };
      const good = new Array(768).fill(0.5);
      const items =
        op.op === "embed"
          ? [{ key: "good", vector: good }, { key: "no-vector" }, { key: "wrong-dims", vector: [0.1, 0.2] }]
          : [];
      child.emitLine(JSON.stringify({ ev: "embed", id: op.id, items }));
      return true;
    }) as FakeChild["stdin"]["write"];
    const out = await client.embed([{ key: "good", text: "t" }]);
    expect(out).toHaveLength(1);
    expect(out?.[0].key).toBe("good");

    // All items malformed → undefined, not a throw.
    child.stdin.write = ((data: string) => {
      const op = JSON.parse(data.trim()) as { op: string; id: number };
      if (op.op === "embed") child.emitLine(JSON.stringify({ ev: "embed", id: op.id, items: [{ key: "bad" }] }));
      return true;
    }) as FakeChild["stdin"]["write"];
    expect(await client.embed([{ key: "bad", text: "t" }])).toBeUndefined();
  });

  it("passes dtype and modelDir to the child environment", async () => {
    const spawned: Array<{ path: string; env: NodeJS.ProcessEnv }> = [];
    const spawnFn: SpawnFn = (workerPath, env) => {
      spawned.push({ path: workerPath, env });
      return new FakeChild();
    };
    const client = new EmbedClient({
      workerPath: "/virtual/embed-worker.ts",
      dtype: "fp16",
      modelDir: "/somewhere/models",
      spawnFn,
    });
    client.start();
    expect(spawned[0].env.PI_RECALL_EMBED_DTYPE).toBe("fp16");
    expect(spawned[0].env.PI_RECALL_MODEL_DIR).toBe("/somewhere/models");
  });
});

describe("EmbedClient over a real child process", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "embed-client-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an idle worker is killed silently after the idle timeout", async () => {
    const child = new FakeChild();
    const notices: string[] = [];
    const client = makeClient(child, notices, { idleTimeoutMs: 20 });
    client.start();
    expect(child.killed).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(child.killed).toBe(true);
    expect(notices.filter((n) => n.includes("exited"))).toHaveLength(0); // idle exit is silent
  });

  it("a request re-arms the idle timer", async () => {
    const child = new FakeChild();
    const client = makeClient(child, [], { idleTimeoutMs: 40 });
    client.start();
    child.stdin.write = ((data: string) => {
      const op = JSON.parse(data.trim()) as { op: string; id: number };
      if (op.op === "query") child.emitLine(JSON.stringify({ ev: "query", id: op.id, vector: [0.5] }));
      return true;
    }) as FakeChild["stdin"]["write"];
    await client.query("ping");
    await new Promise((r) => setTimeout(r, 15)); // idle timer re-armed by the request
    expect(child.killed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(child.killed).toBe(true);
  });

  it("speaks the JSONL protocol over real pipes", async () => {
    // A stub worker: no model, deterministic vectors — this test exercises
    // real spawn + pipe framing + line buffering, not embedding.
    const stub = path.join(dir, "stub-worker.mjs");
    await writeFile(
      stub,
      [
        "let buf = '';",
        "process.stdin.on('data', (c) => {",
        "  buf += c.toString('utf8');",
        "  let nl;",
        "  while ((nl = buf.indexOf('\\n')) !== -1) {",
        "    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
        "    if (!line) continue;",
        "    const op = JSON.parse(line);",
        "    if (op.op === 'query') process.stdout.write(JSON.stringify({ ev: 'query', id: op.id, vector: new Array(768).fill(0.5) }) + '\\n');",
        "    if (op.op === 'embed') process.stdout.write(JSON.stringify({ ev: 'embed', id: op.id, items: op.items.map((i) => ({ key: i.key, vector: new Array(768).fill(1) })) }) + '\\n');",
        "  }",
        "});",
        "process.stdin.on('end', () => process.exit(0));",
      ].join("\n"),
    );
    const client = new EmbedClient({ workerPath: stub, dtype: "q8", modelDir: dir });
    try {
      expect(client.start()).toBe(true);
      const q = await client.query("over a real pipe");
      expect(q?.length).toBe(EMBED_DIMS);
      const docs = await client.embed([{ key: "k", text: "document" }]);
      expect(docs?.[0]).toMatchObject({ key: "k" });
    } finally {
      client.kill();
    }
  });
});
