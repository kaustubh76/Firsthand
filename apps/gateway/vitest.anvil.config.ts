import { defineConfig } from "vitest/config";

/** Live-chain tier for the gateway: needs ANVIL_RPC_URL, DEPLOYMENTS_FILE and RELAYER_PRIVATE_KEY. */
export default defineConfig({
  test: {
    name: "gateway:anvil",
    include: ["test/anvil/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
