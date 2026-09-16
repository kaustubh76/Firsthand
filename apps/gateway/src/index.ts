import { loadDotenv } from "@firsthand/runtime/node";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

// Before config: otherwise every value in .env is silently ignored and the gateway runs on defaults.
const env = loadDotenv();
const config = loadConfig();
const { app, logger, shutdown } = createGateway(config);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info("firsthand-gateway listening", {
    host: info.address,
    port: info.port,
    x402: config.X402_MODE,
    settlement: config.SETTLEMENT_MODE,
    chainId: String(config.CHAIN_ID),
    envFile: env.path ?? `none (${env.reason})`,
  });
});
shutdown.register("http", () => new Promise<void>((resolve) => server.close(() => resolve())));
shutdown.installSignalHandlers();
