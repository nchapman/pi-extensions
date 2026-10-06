// Dedicated config so the eval never runs under plain `npm test`
// (it spawns real pi children and burns real tokens — tests stay model-free).
// The timeout is a full day: a 50-PR run at ~10-15 min/PR is ~10h; results
// flush per PR, so even a kill keeps what was spent.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/eval-review.ts"],
    testTimeout: 24 * 60 * 60_000,
    hookTimeout: 60_000,
    silent: false,
  },
});
