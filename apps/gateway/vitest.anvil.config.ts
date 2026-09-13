import { defineConfig } from "vitest/config";

/** Live-chain tier for the gateway: needs ANVIL_RPC_URL, DEPLOYMENTS_FILE and RELAYER_PRIVATE_KEY. */
export default defineConfig({
  test: {
    name: "gateway:anvil",
    include: ["test/anvil/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
