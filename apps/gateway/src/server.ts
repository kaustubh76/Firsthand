import {
  type AnchorWriter,
  anvil,
  type ConsentLedger,
  createChainClients,
  FsBlobStore,
  FsPassportCatalog,
  type GrantReader,
  LogsConsentLedger,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryConsentLedger,
  MemoryFacilitator,
  MemoryGrantReader,
  MemoryPassportCatalog,
  MemorySettlement,
  MonadFacilitatorClient,
  monadTestnet,
  OnchainAnchorWriter,
  OnchainGrantReader,
  OnchainSettlement,
  type PaymentRequirements,
  type Settlement,
  type X402Facilitator,
} from "@firsthand/adapters";
import { type Deployment, loadDeployment } from "@firsthand/contracts/deployments";
import {
  type Address,
  Bytes32Schema,
  ConfigError,
  type Eip712Domain,
  parseSidecar,
  ValidationError,
} from "@firsthand/core";
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
import { Relay } from "./services/Relay.js";
import { Serving } from "./services/Serving.js";

export interface GatewayApp {
  readonly app: Hono<{ Variables: X402Vars }>;
  readonly logger: Logger;
  readonly shutdown: ShutdownRegistry;
  readonly serving: Serving;
  readonly domain: Eip712Domain;
  /** Present in chain mode with a relayer: submits signature-authorised calls for keyless clients. */
  readonly relay: Relay | null;
  /** Audit surface: receipts, anchors and the consent timeline. Chain mode reads them from logs. */
  readonly ledger: ConsentLedger;
  /** Present in memory mode so tests and demos can seed grants and inspect receipts. */
  readonly memory: {
    grants: MemoryGrantReader;
    ledger: MemoryConsentLedger;
    anchors: MemoryAnchorWriter;
  } | null;
}

function readDeployment(config: GatewayConfig): Deployment {
  const d = loadDeployment(config.DEPLOYMENTS_FILE as string);
  if (BigInt(d.chainId) !== config.CHAIN_ID) {
    throw new ConfigError(
      `DEPLOYMENTS_FILE is for chain ${d.chainId}, CHAIN_ID is ${config.CHAIN_ID}`,
    );
  }
  return d;
}

/** Assembles adapters from config. Memory mode needs no network — used by tests and `pnpm dev`. */
export function createGateway(
  config: GatewayConfig,
  overrides: Partial<Pick<GatewayApp, "logger">> = {},
): GatewayApp {
  const logger =
    overrides.logger ?? createLogger({ level: config.LOG_LEVEL, json: config.LOG_JSON });
  const shutdown = new ShutdownRegistry({ logger });

  const facilitator: X402Facilitator =
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
  const catalog =
    config.CATALOG === "fs"
      ? new FsPassportCatalog(config.CATALOG_DIR)
      : new MemoryPassportCatalog();

  // Chain-bound adapters (read-only anchors + grants; settlement relayer optional) or memory doubles.
  let anchors: AnchorWriter;
  let grants: GrantReader;
  let settlement: Settlement;
  let memory: GatewayApp["memory"] = null;
  let payTo = config.PAY_TO.toLowerCase() as Address;
  let usdc = config.USDC_ADDRESS.toLowerCase() as Address;
  let passportAnchors = config.PASSPORT_ANCHORS.toLowerCase() as Address;
  let relay: Relay | null = null;
  let ledger: ConsentLedger | null = null;

  if (config.DEPLOYMENTS_FILE) {
    const d = readDeployment(config);
    const chain = d.chainId === 31337 ? anvil : monadTestnet;
    const clients = createChainClients({
      rpcUrl: config.MONAD_RPC_URL,
      chain,
      ...(config.RELAYER_PRIVATE_KEY
        ? { privateKey: config.RELAYER_PRIVATE_KEY as `0x${string}` }
        : {}),
    });
    passportAnchors = d.PassportAnchors.toLowerCase() as Address;
    payTo = d.RoyaltyRouter.toLowerCase() as Address;
    usdc = d.USDC.toLowerCase() as Address;
    anchors = new OnchainAnchorWriter({
      address: passportAnchors,
      layout: d.anchorsLayout,
      publicClient: clients.publicClient,
    });
    grants = new OnchainGrantReader({
      publicClient: clients.publicClient,
      grantManager: d.GrantManager.toLowerCase() as Address,
      principalRegistry: d.PrincipalRegistry.toLowerCase() as Address,
      receiptLedger: d.ReceiptLedger.toLowerCase() as Address,
    });
    // Envio is the indexed path (ADR-0013); logs need only an RPC, so the audit surface is live
    // the moment the contracts are deployed.
    ledger = new LogsConsentLedger({
      publicClient: clients.publicClient,
      principalRegistry: d.PrincipalRegistry.toLowerCase() as Address,
      passportAnchors,
      grantManager: d.GrantManager.toLowerCase() as Address,
      receiptLedger: d.ReceiptLedger.toLowerCase() as Address,
      ...(config.LEDGER_FROM_BLOCK === undefined ? {} : { fromBlock: config.LEDGER_FROM_BLOCK }),
    });
    if (clients.walletClient && config.RELAY_ENABLED) {
      // Only the four contracts whose entry points authorise by signature rather than msg.sender.
      relay = new Relay({
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        allow: [
          d.PrincipalRegistry.toLowerCase() as Address,
          passportAnchors,
          d.GrantManager.toLowerCase() as Address,
          d.Rescissions.toLowerCase() as Address,
        ],
        logger,
      });
    }
    if (config.SETTLEMENT_MODE === "onchain") {
      if (!clients.walletClient)
        throw new ConfigError("RELAYER_PRIVATE_KEY is required when SETTLEMENT_MODE=onchain");
      settlement = new OnchainSettlement({
        router: payTo,
        receiptLedger: d.ReceiptLedger.toLowerCase() as Address,
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
      });
    } else {
      // Chain-read verification with memory accounting: useful for dry runs against a real deployment.
      const mg = new MemoryGrantReader();
      settlement = new MemorySettlement(mg, new MemoryConsentLedger());
    }
  } else {
    if (config.SETTLEMENT_MODE === "onchain")
      throw new ConfigError("SETTLEMENT_MODE=onchain requires DEPLOYMENTS_FILE");
    const mAnchors = new MemoryAnchorWriter();
    const mGrants = new MemoryGrantReader();
    const mLedger = new MemoryConsentLedger();
    anchors = mAnchors;
    grants = mGrants;
    settlement = new MemorySettlement(mGrants, mLedger);
    memory = { grants: mGrants, ledger: mLedger, anchors: mAnchors };
    ledger = mLedger;
  }

  const domain: Eip712Domain = { chainId: config.CHAIN_ID, verifyingContract: passportAnchors };
  const serving = new Serving({ anchors, blobs, catalog, grants, settlement, domain, logger });
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
    c.json({
      ok: true,
      x402: config.X402_MODE,
      settlement: settlement.kind,
      blobs: config.BLOB_STORE,
    }),
  );

  /** Discovery document for buyers, agents and other Metropolis teams (README §4 "open-spec"). */
  app.get("/.well-known/firsthand.json", (c) =>
    c.json({
      protocol: "firsthand",
      version: "0.1.0",
      chainId: config.CHAIN_ID.toString(),
      verbs: ["deposit", "query", "rescind"],
      domain: { chainId: domain.chainId.toString(), verifyingContract: domain.verifyingContract },
      x402: {
        network: config.X402_NETWORK,
        asset: usdc,
        payTo,
        extra: {
          chainId: config.CHAIN_ID.toString(),
          name: config.USDC_NAME,
          version: config.USDC_VERSION,
        },
      },
      endpoints: {
        query: "/v1/query/:grantId/:passportId",
        passport: "/v1/passports/:id",
        blob: "/v1/blobs/:id",
        wrap: "/v1/grants/:grantId/wrap",
        anchors: "/v1/anchors/:root",
        ingest: {
          passport: "POST /v1/passports",
          blob: "POST /v1/blobs",
          wrap: "POST /v1/grants/:grantId/wrap",
        },
      },
    }),
  );

  const parseId = (value: string | undefined, label: string) => {
    const parsed = Bytes32Schema.safeParse(value);
    if (!parsed.success) throw new ValidationError(`${label} must be 32-byte hex`);
    return parsed.data;
  };

  // Both assembly branches set it; this keeps the routes honest without a non-null assertion.
  const requireLedger = (): ConsentLedger => {
    if (!ledger) throw new ConfigError("no consent ledger configured");
    return ledger;
  };

  const parseAddress = (value: string): Address => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
      throw new ValidationError("to must be a 20-byte address");
    return value.toLowerCase() as Address;
  };

  const requirementsFor = async (
    grantId: string,
    passportId: string,
  ): Promise<PaymentRequirements> => {
    const sidecar = await serving.sidecar(parseId(passportId, "passportId"));
    return {
      scheme: "exact",
      network: config.X402_NETWORK,
      maxAmountRequired: sidecar.terms.price.toString(),
      resource: `${config.PUBLIC_URL}/v1/query/${grantId}/${passportId}`,
      description: "FIRSTHAND per-query access under a live grant",
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 60,
      asset: usdc,
      extra: {
        chainId: config.CHAIN_ID.toString(),
        name: config.USDC_NAME,
        version: config.USDC_VERSION,
      },
    };
  };

  // ── serve ───────────────────────────────────────────────────────────────────────────────────

  app.get(
    "/v1/query/:grantId/:passportId",
    rateLimit(limiter, (_h, ip) => ip),
    x402({
      facilitator,
      requirementsFor: (c) =>
        requirementsFor(c.req.param("grantId") ?? "", c.req.param("passportId") ?? ""),
    }),
    async (c) => {
      const result = await serving.serve({
        grantId: parseId(c.req.param("grantId"), "grantId"),
        passportId: parseId(c.req.param("passportId"), "passportId"),
        payment: c.get("x402Payload"),
        requirements: c.get("x402Requirements"),
      });
      return c.json(result);
    },
  );

  app.get("/v1/passports/:id", async (c) => {
    const sidecar = await serving.sidecar(parseId(c.req.param("id"), "passport id"));
    const { sidecarToWire } = await import("@firsthand/core");
    return c.json(sidecarToWire(sidecar));
  });

  app.get("/v1/blobs/:id", async (c) => {
    const bytes = await serving.blob(parseId(c.req.param("id"), "blob id"));
    if (bytes === null) return c.notFound();
    return c.body(bytes.slice().buffer as ArrayBuffer, 200, {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/v1/grants/:grantId/wrap", async (c) => {
    const bytes = await serving.wrapFor(parseId(c.req.param("grantId"), "grantId"));
    return c.body(bytes.slice().buffer as ArrayBuffer, 200, {
      "content-type": "application/octet-stream",
    });
  });

  app.get("/v1/anchors/:root", async (c) => {
    const root = parseId(c.req.param("root"), "root");
    return c.json({ root, anchored: await serving.isAnchored(root) });
  });

  // ── verified ingest ─────────────────────────────────────────────────────────────────────────

  const readBody = async (c: {
    req: { arrayBuffer(): Promise<ArrayBuffer> };
  }): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new ValidationError("empty body");
    if (bytes.length > config.MAX_UPLOAD_BYTES)
      throw new ValidationError(`body exceeds ${config.MAX_UPLOAD_BYTES} bytes`);
    return bytes;
  };

  app.post("/v1/passports", async (c) => {
    let sidecar: ReturnType<typeof parseSidecar>;
    try {
      sidecar = parseSidecar(await c.req.json());
    } catch (cause) {
      throw new ValidationError("invalid sidecar", { cause });
    }
    const id = await serving.ingestPassport(sidecar);
    return c.json({ passportId: id }, 201);
  });

  app.post("/v1/blobs", async (c) => c.json(await serving.ingestBlob(await readBody(c)), 201));

  app.post("/v1/grants/:grantId/wrap", async (c) => {
    const grantId = parseId(c.req.param("grantId"), "grantId");
    const wrapRef = await serving.ingestWrap(grantId, await readBody(c));
    return c.json({ grantId, wrapRef }, 201);
  });

  // ── audit (Consent Ledger) ──────────────────────────────────────────────────────────────────
  // The evidence surface: what was licensed, what was paid for, and when consent ended.

  app.get("/v1/grants/:grantId/receipts", async (c) => {
    const grantId = parseId(c.req.param("grantId"), "grantId");
    return c.json({ grantId, receipts: await requireLedger().receiptsForGrant(grantId) });
  });

  app.get("/v1/principals/:principalId/anchors", async (c) => {
    const principalId = parseId(c.req.param("principalId"), "principalId");
    const ns = Number(c.req.query("ns") ?? "0");
    if (!Number.isInteger(ns) || ns < 0 || ns > 15) throw new ValidationError("ns must be 0..15");
    return c.json({ principalId, ns, anchors: await requireLedger().anchorsFor(principalId, ns) });
  });

  app.get("/v1/principals/:principalId/timeline", async (c) => {
    const principalId = parseId(c.req.param("principalId"), "principalId");
    return c.json({ principalId, events: await requireLedger().consentTimeline(principalId) });
  });

  // ── relay ───────────────────────────────────────────────────────────────────────────────────
  // For clients that hold no key (the capture PWA). Authorisation is inside the calldata — a P-256
  // signature under the contract's own EIP-712 domain — so relaying cannot change what a call means.

  app.get("/v1/relay/capabilities", (c) =>
    relay
      ? c.json(relay.capabilities())
      : c.json({ error: "relay is not enabled on this gateway" }, 404),
  );

  app.post("/v1/relay", async (c) => {
    if (!relay) return c.json({ code: "FH_CONFIG", error: "relay is not enabled" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      to?: string;
      data?: string;
      value?: string;
      gas?: string;
    } | null;
    if (!body?.to || !body.data) throw new ValidationError("relay: to and data are required");
    const ref = await relay.send({
      to: parseAddress(body.to),
      data: body.data as `0x${string}`,
      ...(body.value === undefined ? {} : { value: BigInt(body.value) }),
      ...(body.gas === undefined ? {} : { gas: BigInt(body.gas) }),
    });
    return c.json(ref, 201);
  });

  return { app, logger, shutdown, serving, domain, memory, relay, ledger: requireLedger() };
}
