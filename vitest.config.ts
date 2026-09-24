import { defineConfig } from "vitest/config";

/**
 * Root runner: `pnpm vitest` from the repo root executes every package's own
 * vitest.config.ts as a project. Per-package thresholds still apply.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "integrations/*", "experiments"],
  },
});
