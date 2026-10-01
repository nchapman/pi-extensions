// Dedicated config so the MRL experiment never runs under plain `npm test`
// (it spawns the real embed worker — tests must stay model-free).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/bench-mrl.ts"],
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    silent: false,
  },
});
