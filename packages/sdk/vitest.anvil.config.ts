import { defineConfig } from "vitest/config";

/**
 * Integration tier: runs the SDK against a live chain (anvil --odyssey in CI, Monad testnet by hand).
 * Needs ANVIL_RPC_URL, DEPLOYMENTS_FILE and RELAYER_PRIVATE_KEY; tests skip themselves otherwise.
 */
export default defineConfig({
  test: {
    name: "sdk:anvil",
    include: ["test/anvil/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // One relayer account: files must not race each other's nonces.
    fileParallelism: false,
  },
});
