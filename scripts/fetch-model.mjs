/**
 * Postinstall model fetch for recall's semantic search — idempotent and
 * fail-soft by contract: it spawns the real embed worker in --warm mode
 * (which loads the model, downloading it under PI_RECALL_MODEL_DIR on first
 * use), and exits 0 even on failure so an offline `npm install` never breaks.
 * The failure surfaces as a warning; runtime fail-open (BM25-only search)
 * covers the gap until the model is fetched manually:
 *   node scripts/fetch-model.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../lib/embed-worker.ts", import.meta.url));
const env = {
  ...process.env,
  PI_RECALL_MODEL_DIR: process.env.PI_RECALL_MODEL_DIR || `${process.env.HOME}/.pi/agent/models`,
  PI_RECALL_EMBED_DTYPE: process.env.PI_RECALL_EMBED_DTYPE || "q8",
};

const child = spawn(process.execPath, [worker, "--warm"], { env, stdio: ["ignore", "pipe", "pipe"] });
let sawReady = false;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.ev === "ready") sawReady = true;
      if (msg.ev === "fatal") fail(`model load failed: ${msg.message}`);
    } catch {
      /* non-JSON stdout is ignored */
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => {
  if (sawReady && code === 0) {
    console.log("recall: embedding model ready (cached under " + env.PI_RECALL_MODEL_DIR + ")");
    process.exit(0);
  }
  fail(`embed worker exited with code ${code}`);
});

const HARD_TIMEOUT_MS = 10 * 60 * 1000; // a stalled download must not wedge npm install
const timer = setTimeout(() => fail("timed out after 10 minutes"), HARD_TIMEOUT_MS);
timer.unref();

let failed = false;
function fail(reason) {
  if (failed) return;
  failed = true;
  clearTimeout(timer);
  child.kill();
  console.error(`recall: embedding model fetch skipped (${reason}) — semantic search will degrade to lexical-only. Re-run: node scripts/fetch-model.mjs`);
  process.exit(0); // fail-soft: never break npm install
}
