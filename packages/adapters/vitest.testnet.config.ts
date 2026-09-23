import { defineConfig } from "vitest/config";

/**
 * Interop against live third-party endpoints. Separate from the default run on purpose: `check:all`
 * must never depend on someone else's uptime, and these tests take seconds of real network.
 * Run with `pnpm --filter @firsthand/adapters test:testnet`.
 */
export default defineConfig({
  test: {
    name: "adapters:testnet",
    include: ["test/testnet/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
