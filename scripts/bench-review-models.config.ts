// Dedicated config so this model-spawning benchmark never runs under plain
// `npm test` (children hit real endpoints — tests must stay model-free).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/bench-review-models.ts"],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
    silent: false,
  },
});
