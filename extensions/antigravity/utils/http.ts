/**
 * Thin fetch wrapper for Antigravity API traffic. Upstream keeps an undici Agent
 * with a 60s keep-alive pool here, but that path is a no-op on Node >= 22 (where
 * built-in fetch already pools connections) — and pi itself requires Node 22+ —
 * so this fork drops the undici dependency and uses the global fetch directly.
 */
import { antigravityEnv } from "./util.js";

const PREWARM_TIMEOUT_MS = 5_000;

let prewarmStarted = false;

/** fetch() bound to this provider (kept as a named export so vendored call sites stay diff-able against upstream). */
export async function antigravityFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, init);
}

/**
 * Open the TLS connection on the first Antigravity request so that turn does not
 * pay the handshake. Not called at extension load: an unauthenticated HEAD to the
 * endpoint can stall Node's event loop until connect timeout and freeze Pi startup.
 * Best-effort: failures are ignored. Subsequent calls are no-ops.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  if (prewarmStarted) return;
  prewarmStarted = true;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      // Release the socket back to the pool even though HEAD carries no body.
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
