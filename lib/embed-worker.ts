/**
 * Embed worker — the model-isolated half of recall's semantic search.
 *
 * A bare child process, spawned by lib/embed-client.ts and run directly by
 * Node's TypeScript stripping (no relative imports on purpose — the file must
 * execute standalone). It owns whichever ONNX embedding model it is pointed
 * at (default EmbeddingGemma; PI_RECALL_EMBED_MODEL selects any
 * transformers.js-compatible id or local dir): loading costs ~1s warm and
 * running parks ~1.7GB of non-returnable ONNX arena in the process, which is
 * precisely why it is a child — memory is reclaimed on exit and a native
 * crash cannot take pi down. The parent never imports transformers.js.
 *
 * The worker is a pure model runner: it embeds the text it is given, as-is.
 * Model-specific query/document prefixes live client-side
 * (lib/embed-client.ts presetFor) so they stay unit-testable — this file
 * cannot be imported by tests without spawning the stdin listener.
 *
 * Contract (JSONL on stdin/stdout, one message per line):
 *   parent → child:
 *     {"op":"embed","id":N,"items":[{"key","text"},...]}     — document embeddings
 *     {"op":"query","id":N,"text":"..."}                     — query embedding
 *   child → parent:
 *     {"ev":"embed","id":N,"items":[{"key","vector":[...]}]} — unit vectors, model dims
 *     {"ev":"query","id":N,"vector":[...]}
 *     {"ev":"error","id":N,"message":"..."}                  — one request failed; worker lives
 *     {"ev":"fatal","message":"..."}                         — model load failed; worker exits
 *     {"ev":"ready"}                                         — model load completed (also in --warm mode)
 *
 * `node embed-worker.ts --warm` loads the model (downloading on first use)
 * and exits — the fetch path for the postinstall script. The model caches
 * under PI_RECALL_MODEL_DIR (default ~/.pi/agent/models), never inside
 * node_modules where an npm install would wipe it.
 */

const DEFAULT_MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const MODEL_ID = process.env.PI_RECALL_EMBED_MODEL?.trim() || DEFAULT_MODEL_ID;
const MODEL_DIR = process.env.PI_RECALL_MODEL_DIR?.trim() || `${process.env.HOME ?? "~"}/.pi/agent/models`;
/** dtype whitelist mirrors transformers.js' union, narrowed to the EmbeddingGemma builds worth using. */
type Dtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const DTYPES = new Set<Dtype>(["fp32", "fp16", "q8", "q4", "q4f16"]);
const rawDtype = process.env.PI_RECALL_EMBED_DTYPE?.trim() as Dtype | undefined;
const DTYPE: Dtype = rawDtype !== undefined && DTYPES.has(rawDtype) ? rawDtype : "q8";

/** Model output as produced by transformers.js: pooled (sentence_embedding,
 * Gemma-style), per-token (last_hidden_state, LLM-style embedders like
 * Qwen3-Embedding — those pool the LAST token per their model cards), or a
 * single custom-named tensor (community ONNX exports, e.g. jina-code's
 * pre-pooled "embeddings"). */
interface ModelTensor {
  dims: number[];
  data: Float32Array;
}
type ModelOutput = Record<string, ModelTensor | undefined>;

type EmbedOp =
  { op: "embed"; id: number; items: Array<{ key: string; text: string }> } | { op: "query"; id: number; text: string };

let tokenizer: { (text: string, opts: { padding: boolean; truncation: boolean }): unknown } | null = null;
let model: ((inputs: unknown) => Promise<ModelOutput>) | null = null;
let loading: Promise<void> | null = null;

function reply(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function ensureModel(): Promise<void> {
  if (model !== null) return;
  if (loading === null) {
    loading = (async () => {
      const { AutoModel, AutoTokenizer, env, LogLevel } = await import("@huggingface/transformers");
      env.cacheDir = MODEL_DIR;
      env.logLevel = LogLevel.ERROR; // progress/logging would corrupt the JSONL stdout channel
      const [m, t] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE }),
        AutoTokenizer.from_pretrained(MODEL_ID),
      ]);
      model = m as NonNullable<typeof model>;
      tokenizer = t as NonNullable<typeof tokenizer>;
      reply({ ev: "ready" });
    })().catch((err: unknown) => {
      loading = null; // a failed load is retryable by a later op
      throw err;
    });
  }
  return loading;
}

async function embed(text: string): Promise<Float32Array> {
  if (tokenizer === null || model === null) throw new Error("model not loaded");
  const inputs = tokenizer(text, { padding: true, truncation: true });
  const output = await model(inputs);
  const tensor = pickTensor(output);
  if (tensor === undefined) throw new Error("model output has no embedding tensor");
  let raw: Float32Array;
  if (tensor.dims.length === 1 || (tensor.dims.length === 2 && tensor.dims[0] === 1)) {
    raw = tensor.data; // already pooled [D] or [1, D]
  } else if (tensor.dims.length === 2) {
    // [S, D] without a batch dim is ambiguous — per-token output that this
    // embedder can't pool by position. Refuse loudly rather than flatten S·D
    // floats into one meaningless vector.
    throw new Error("rank-2 embedding tensor is [S,D] (no batch dim) — ambiguous, refusing to guess");
  } else if (tensor.dims.length === 3) {
    // Single text per call — no padding — so the last position IS the last
    // token (verified for Qwen3-Embedding-0.6B-ONNX: the tokenizer's
    // post-processor appends <|endoftext|>, so the last position is EOS,
    // exactly the token the card's last-token pooling expects).
    const [, seq, d] = tensor.dims;
    raw = tensor.data.subarray((seq - 1) * d, seq * d);
  } else {
    throw new Error(`unexpected embedding tensor rank ${tensor.dims.length}`);
  }
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
  const norm = Math.sqrt(sum);
  const unit = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) unit[i] = raw[i] / (norm || 1);
  return unit;
}

/** Canonical keys first; otherwise a lone custom-named tensor (community
 * exports) is taken as the embedding — anything else is ambiguous. */
function pickTensor(output: ModelOutput): ModelTensor | undefined {
  const known = output.sentence_embedding ?? output.last_hidden_state;
  if (known !== undefined) return known;
  const tensors = Object.values(output).filter((v): v is ModelTensor => v !== undefined);
  return tensors.length === 1 ? tensors[0] : undefined;
}

async function handle(op: EmbedOp): Promise<void> {
  try {
    await ensureModel();
  } catch (err) {
    reply({ ev: "fatal", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  try {
    if (op.op === "query") {
      reply({ ev: "query", id: op.id, vector: Array.from(await embed(op.text)) });
      return;
    }
    const items: Array<{ key: string; vector: number[] }> = [];
    for (const item of op.items) items.push({ key: item.key, vector: Array.from(await embed(item.text)) });
    reply({ ev: "embed", id: op.id, items });
  } catch (err) {
    reply({
      ev: "error",
      id: (op as { id?: number }).id ?? 0,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

let buffer = "";
let terminated = false;
let inFlight = 0;
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === "") continue;
    let op: EmbedOp;
    try {
      op = JSON.parse(line) as EmbedOp;
    } catch {
      continue; // a torn line can never happen on a pipe, but never crash the worker
    }
    inFlight++;
    void handle(op).finally(() => {
      inFlight--;
    });
  }
});
process.stdin.on("end", () => {
  terminated = true;
});
process.stdin.on("error", () => {
  terminated = true;
});

// --warm: load (downloading if absent), report, exit — the model fetch path.
// The stdin-end exit watcher is installed for server mode only: a warm child
// gets /dev/null stdin (immediate EOF) and would otherwise exit ~250ms in,
// long before the model load finishes.
if (process.argv.includes("--warm")) {
  void ensureModel()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      reply({ ev: "fatal", message: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
} else {
  // Exit when the parent closes stdin, but only once nothing is in flight.
  setInterval(() => {
    if (terminated && buffer.trim() === "" && inFlight === 0) process.exit(0);
  }, 250).unref();
}
