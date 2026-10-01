// Dedicated config so the benchmark never runs under plain `npm test`
// (it spawns the real embed worker — tests must stay model-free).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/bench-recall.ts"],
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000,
    silent: false,
  },
});
