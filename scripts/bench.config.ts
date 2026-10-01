// Dedicated config so the benchmarks never run under plain `npm test`
// (they spawn the real embed worker — tests must stay model-free).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/bench-recall.ts"],
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000,
    silent: false,
  },
});
