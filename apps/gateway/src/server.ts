import { readFileSync } from "node:fs";
import {
  type AnchorWriter,
  anvil,
  createChainClients,
  FsBlobStore,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MonadFacilitatorClient,
  monadTestnet,
  OnchainAnchorWriter,
  type PaymentRequirements,
} from "@firsthand/adapters";
import { type Address, Bytes32Schema, ConfigError, ValidationError } from "@firsthand/core";
import {
  createLogger,
  type Logger,
  MemoryTokenBucketLimiter,
  ShutdownRegistry,
} from "@firsthand/runtime";
import { Hono } from "hono";
import type { GatewayConfig } from "./config.js";
import { problemDetailsHandler } from "./middleware/problemDetails.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { type X402Vars, x402 } from "./middleware/x402.js";
import { Serving } from "./services/Serving.js";

function onchainAnchors(config: GatewayConfig): AnchorWriter {
  const deployment = JSON.parse(readFileSync(config.DEPLOYMENTS_FILE as string, "utf8")) as {
    chainId: number;
    PassportAnchors: string;
    anchorsLayout: "baseline" | "paged";
  };
  if (BigInt(deployment.chainId) !== config.CHAIN_ID) {
    throw new ConfigError(
      `DEPLOYMENTS_FILE is for chain ${deployment.chainId}, CHAIN_ID is ${config.CHAIN_ID}`,
    );
  }
  const { publicClient } = createChainClients({
    rpcUrl: config.MONAD_RPC_URL,
    chain: deployment.chainId === 31337 ? anvil : monadTestnet,
  });
  return new OnchainAnchorWriter({
    address: deployment.PassportAnchors.toLowerCase() as Address,
    layout: deployment.anchorsLayout,
    publicClient,
  });
}

export interface GatewayApp {
  readonly app: Hono<{ Variables: X402Vars }>;
  readonly logger: Logger;
  readonly shutdown: ShutdownRegistry;
  readonly serving: Serving;
}

/** Assembles adapters from config. Memory mode needs no network — used by tests and `pnpm dev`. */
export function createGateway(
  config: GatewayConfig,
  overrides: Partial<Pick<GatewayApp, "logger">> = {},
): GatewayApp {
  const logger =
    overrides.logger ?? createLogger({ level: config.LOG_LEVEL, json: config.LOG_JSON });
  const shutdown = new ShutdownRegistry({ logger });

  const facilitator =
    config.X402_MODE === "memory"
      ? new MemoryFacilitator({ network: config.X402_NETWORK })
      : (() => {
          if (!config.X402_FACILITATOR_URL)
            throw new ConfigError("X402_FACILITATOR_URL is required when X402_MODE=monad");
          return new MonadFacilitatorClient({
            baseUrl: config.X402_FACILITATOR_URL,
            ...(config.X402_FACILITATOR_API_KEY ? { apiKey: config.X402_FACILITATOR_API_KEY } : {}),
            logger,
          });
        })();
  const blobs =
    config.BLOB_STORE === "fs" ? new FsBlobStore(config.BLOB_DIR) : new MemoryBlobStore();
  // With a deployment file the gateway reads anchors from chain (read-only: it never signs); the memory
  // double stays for tests and dry runs.
  const anchors = config.DEPLOYMENTS_FILE ? onchainAnchors(config) : new MemoryAnchorWriter();
  const serving = new Serving({ anchors, blobs, facilitator, logger });
  const limiter = new MemoryTokenBucketLimiter({
    capacity: config.RATE_LIMIT_CAPACITY,
    refillPerSecond: config.RATE_LIMIT_REFILL_PER_SECOND,
  });

  const app = new Hono<{ Variables: X402Vars }>();
  app.onError(problemDetailsHandler(logger));
  app.use("*", async (c, next) => {
    c.header("x-firsthand-gateway", "0.1.0");
    await next();
  });

  app.get("/healthz", (c) =>
    c.json({ ok: true, x402: config.X402_MODE, blobs: config.BLOB_STORE }),
  );

  /** Discovery document for buyers, agents and other Metropolis teams (README §4 "open-spec"). */
  app.get("/.well-known/firsthand.json", (c) =>
    c.json({
      protocol: "firsthand",
      version: "0.1.0",
      chainId: config.CHAIN_ID.toString(),
      verbs: ["deposit", "query", "rescind"],
      x402: { network: config.X402_NETWORK, asset: config.USDC_ADDRESS, payTo: config.PAY_TO },
      endpoints: {
        query: "/v1/query/:grantId/:passportId",
        blob: "/v1/blobs/:id",
        verify: "/v1/verify",
      },
    }),
  );

  const requirementsFor = (grantId: string): PaymentRequirements => ({
    scheme: "exact",
    network: config.X402_NETWORK,
    // Phase 3: price comes from the grant's terms; a floor of 1 unit keeps receipts non-degenerate.
    maxAmountRequired: "1",
    resource: `${config.PUBLIC_URL}/v1/query/${grantId}`,
    description: "FIRSTHAND per-query access under a live grant",
    mimeType: "application/json",
    payTo: config.PAY_TO,
    maxTimeoutSeconds: 60,
    asset: config.USDC_ADDRESS,
  });

  app.get(
    "/v1/query/:grantId/:passportId",
    rateLimit(limiter, (_h, ip) => ip),
    x402({ facilitator, requirementsFor: (c) => requirementsFor(c.req.param("grantId") ?? "") }),
    async (c) => {
      const grantId = Bytes32Schema.safeParse(c.req.param("grantId"));
      const passportId = Bytes32Schema.safeParse(c.req.param("passportId"));
      if (!grantId.success || !passportId.success)
        throw new ValidationError("grantId and passportId must be 32-byte hex");
      const result = await serving.serve({
        grantId: grantId.data,
        passportId: passportId.data,
        payment: c.get("x402Payload"),
        requirements: c.get("x402Requirements"),
      });
      return c.json(result);
    },
  );

  app.get("/v1/blobs/:id", async (c) => {
    const id = Bytes32Schema.safeParse(c.req.param("id"));
    if (!id.success) throw new ValidationError("blob id must be 32-byte hex");
    const bytes = await serving.blob(id.data);
    if (bytes === null) return c.notFound();
    return c.body(bytes.slice().buffer as ArrayBuffer, 200, {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/v1/anchors/:root", async (c) => {
    const root = Bytes32Schema.safeParse(c.req.param("root"));
    if (!root.success) throw new ValidationError("root must be 32-byte hex");
    return c.json({ root: root.data, anchored: await serving.isAnchored(root.data) });
  });

  return { app, logger, shutdown, serving };
}
