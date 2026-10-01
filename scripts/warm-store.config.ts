// Dedicated config so the warmer never runs under plain `npm test`
// (it spawns the real embed worker — tests must stay model-free).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/warm-store.ts"],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
    silent: false,
  },
});
