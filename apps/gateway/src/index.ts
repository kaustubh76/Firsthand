import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

const config = loadConfig();
const { app, logger, shutdown } = createGateway(config);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info("firsthand-gateway listening", {
    host: info.address,
    port: info.port,
    x402: config.X402_MODE,
  });
});
shutdown.register("http", () => new Promise<void>((resolve) => server.close(() => resolve())));
shutdown.installSignalHandlers();
