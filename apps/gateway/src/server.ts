import {
  type AnchorWriter,
  anvil,
  type ConsentLedger,
  createChainClients,
  type Erc8004Registry,
  type Erc8004Writer,
  FEEDBACK_TAG1,
  FEEDBACK_TAG2_PAID,
  FsBlobStore,
  FsPassportCatalog,
  type GrantReader,
  type LedgerScan,
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
  ObjectBlobStore,
  ObjectPassportCatalog,
  OnchainAnchorWriter,
  OnchainErc8004Registry,
  OnchainGrantReader,
  OnchainSettlement,
  type PaymentRequirements,
  type Settlement,
  type X402Facilitator,
} from "@firsthand/adapters";
import {
  EpochLibAbi,
  GrantManagerAbi,
  MerkleLibAbi,
  MockUSDCAbi,
  P256Abi,
  PassportAnchorsBaselineAbi,
  PassportAnchorsPagedAbi,
  PassportLibAbi,
  PrincipalRegistryAbi,
  ReceiptLedgerAbi,
  RescissionsAbi,
  RoyaltyRouterAbi,
  SplitMathAbi,
} from "@firsthand/contracts/abi";
import { type Deployment, loadDeployment, parseDeployment } from "@firsthand/contracts/deployments";
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
import { cors } from "hono/cors";
import { decodeFunctionData, toFunctionSelector } from "viem";
import type { GatewayConfig } from "./config.js";
import { problemDetailsHandler } from "./middleware/problemDetails.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { type X402Vars, x402 } from "./middleware/x402.js";
import { Relay } from "./services/Relay.js";
import { createVercelBlobClient } from "./storage/vercelBlob.js";

export { type GatewayConfig, loadConfig } from "./config.js";

/** `mint(address,uint256)` on the MockUSDC faucet double — the only USDC entry point the relay may carry. */
const MOCK_USDC_MINT = toFunctionSelector(
  MockUSDCAbi.find((f) => f.type === "function" && f.name === "mint") as never,
);

/** Every custom error a relayed call can surface, so a simulated revert decodes to its name. */
const DEPLOYMENT_ABIS = [
  PrincipalRegistryAbi,
  PassportAnchorsBaselineAbi,
  PassportAnchorsPagedAbi,
  GrantManagerAbi,
  RescissionsAbi,
  ReceiptLedgerAbi,
  RoyaltyRouterAbi,
  MockUSDCAbi,
  SplitMathAbi,
  MerkleLibAbi,
  PassportLibAbi,
  EpochLibAbi,
  P256Abi,
] as const;

/** The faucet relays a demo's worth of test dollars per call, not a treasury: amount ≤ the cap. */
function faucetMintPolicy(maxUnits: bigint): (data: `0x${string}`) => string | null {
  return (data) => {
    try {
      const { args } = decodeFunctionData({ abi: MockUSDCAbi, data });
      const amount = args?.[1];
      if (typeof amount !== "bigint") return "faucet mint: malformed calldata";
      if (amount > maxUnits)
        return `faucet mint: amount exceeds the relayed cap of ${maxUnits} units`;
      return null;
    } catch {
      return "faucet mint: malformed calldata";
    }
  };
}

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
  let d: Deployment;
  let source: string;
  if (config.DEPLOYMENT_JSON) {
    source = "DEPLOYMENT_JSON";
    let raw: unknown;
    try {
      raw = JSON.parse(config.DEPLOYMENT_JSON);
    } catch (cause) {
      throw new ConfigError("DEPLOYMENT_JSON is not valid JSON", { cause });
    }
    d = parseDeployment(raw, source);
  } else {
    source = "DEPLOYMENTS_FILE";
    d = loadDeployment(config.DEPLOYMENTS_FILE as string);
  }
  if (BigInt(d.chainId) !== config.CHAIN_ID) {
    throw new ConfigError(`${source} is for chain ${d.chainId}, CHAIN_ID is ${config.CHAIN_ID}`);
  }
  return d;
}

/** Durable storage for hosts without a disk; both stores share one client and one token. */
function objectStoreClient(config: GatewayConfig) {
  if (!config.BLOB_READ_WRITE_TOKEN) {
    throw new ConfigError("BLOB_READ_WRITE_TOKEN is required when BLOB_STORE or CATALOG is vercel");
  }
  return createVercelBlobClient({ token: config.BLOB_READ_WRITE_TOKEN });
}

/** Assembles adapters from config. Memory mode needs no network — used by tests and `pnpm dev`. */
export function createGateway(
  config: GatewayConfig,
  overrides: Partial<Pick<GatewayApp, "logger">> & {
    /** Tests: an ERC-8004 double in place of the chain's registries (memory mode has none). */
    erc8004?: Erc8004Registry & Erc8004Writer;
    relayerAddress?: Address;
    /** Serverless hosts: keep post-response work (reputation feedback) alive — Vercel's waitUntil. */
    defer?: (work: Promise<unknown>) => void;
  } = {},
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
  const objects =
    config.BLOB_STORE === "vercel" || config.CATALOG === "vercel"
      ? objectStoreClient(config)
      : null;
  const blobs =
    config.BLOB_STORE === "vercel" && objects
      ? new ObjectBlobStore({ client: objects, prefix: `${config.BLOB_PREFIX}/blobs` })
      : config.BLOB_STORE === "fs"
        ? new FsBlobStore(config.BLOB_DIR)
        : new MemoryBlobStore();
  const catalog =
    config.CATALOG === "vercel" && objects
      ? new ObjectPassportCatalog({ client: objects, prefix: `${config.BLOB_PREFIX}/passports` })
      : config.CATALOG === "fs"
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
  let deployment: Deployment | null = null;
  let ledger: ConsentLedger | null = null;
  let chainHead: (() => Promise<bigint>) | null = null;
  let relayerFloat: (() => Promise<{ address: Address; balanceWei: bigint }>) | null = null;
  let erc8004: (Erc8004Registry & Erc8004Writer) | null = overrides.erc8004 ?? null;
  let relayerAddress: Address | null = overrides.relayerAddress ?? null;

  if (config.DEPLOYMENTS_FILE || config.DEPLOYMENT_JSON) {
    const d = readDeployment(config);
    deployment = d;
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
    chainHead = () => clients.publicClient.getBlockNumber({ cacheTime: 0 });
    if (clients.walletClient) {
      const address = clients.walletClient.account.address.toLowerCase() as Address;
      relayerAddress = address;
      relayerFloat = async () => ({
        address,
        balanceWei: await clients.publicClient.getBalance({ address }),
      });
    }
    // ERC-8004 reference registries, where the chain has them (Monad testnet/mainnet).
    const registries = new OnchainErc8004Registry({
      publicClient: clients.publicClient,
      ...(clients.walletClient ? { walletClient: clients.walletClient } : {}),
    });
    if (registries.addresses) erc8004 = registries;
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
      lookbackBlocks: config.LEDGER_LOOKBACK_BLOCKS,
      maxRange: config.LEDGER_MAX_RANGE,
      minRequestIntervalMs: config.LEDGER_MIN_REQUEST_INTERVAL_MS,
      maxInFlight: config.LEDGER_MAX_IN_FLIGHT,
    });
    if (clients.walletClient && config.RELAY_ENABLED) {
      // Only the four contracts whose entry points authorise by signature rather than msg.sender —
      // plus, on chains where the USDC is the MockUSDC faucet double, its permissionless `mint`, so
      // a keyless browser can fund a demo buyer. Selector-scoped: nothing else on the token relays.
      relay = new Relay({
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        allow: [
          d.PrincipalRegistry.toLowerCase() as Address,
          passportAnchors,
          d.GrantManager.toLowerCase() as Address,
          d.Rescissions.toLowerCase() as Address,
          ...(config.RELAY_FAUCET_MINT ? [{ address: usdc, selectors: [MOCK_USDC_MINT] }] : []),
        ],
        abis: DEPLOYMENT_ABIS,
        policies: config.RELAY_FAUCET_MINT
          ? [
              {
                address: usdc,
                selector: MOCK_USDC_MINT,
                check: faucetMintPolicy(config.RELAY_FAUCET_MAX_UNITS),
              },
            ]
          : [],
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
      throw new ConfigError("SETTLEMENT_MODE=onchain requires DEPLOYMENTS_FILE or DEPLOYMENT_JSON");
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
  const serving = new Serving({
    anchors,
    blobs,
    catalog,
    grants,
    settlement,
    domain,
    logger,
    ...(erc8004 && config.ERC8004_FEEDBACK && relayerAddress
      ? {
          reputation: {
            registry: erc8004,
            publicUrl: config.PUBLIC_URL,
            ...(overrides.defer ? { defer: overrides.defer } : {}),
          },
        }
      : {}),
  });
  const limiter = new MemoryTokenBucketLimiter({
    capacity: config.RATE_LIMIT_CAPACITY,
    refillPerSecond: config.RATE_LIMIT_REFILL_PER_SECOND,
  });
  // The relay spends the relayer's gas on request; its own bucket so a loop on it cannot starve
  // the serving path and vice versa.
  const relayLimiter = new MemoryTokenBucketLimiter({
    capacity: config.RATE_LIMIT_CAPACITY,
    refillPerSecond: config.RATE_LIMIT_REFILL_PER_SECOND,
  });

  const app = new Hono<{ Variables: X402Vars }>();
  app.onError(problemDetailsHandler(logger));
  app.use("*", async (c, next) => {
    c.header("x-firsthand-gateway", "0.1.0");
    await next();
  });
  app.use(
    "*",
    cors({
      origin:
        config.CORS_ORIGINS === "*" ? "*" : config.CORS_ORIGINS.split(",").map((o) => o.trim()),
      allowHeaders: ["content-type", "x-payment", "payment-signature", "authorization"],
      exposeHeaders: ["x-firsthand-gateway", "x-payment-response", "payment-required"],
      maxAge: 86_400,
    }),
  );

  // The relay spends the relayer's float; an operator (or the browser tier) reads it here rather
  // than discovering an empty account from a failed relay.
  const floatOf = async () => {
    if (!relayerFloat) return null;
    try {
      const { address, balanceWei } = await relayerFloat();
      const balanceMon = Number(balanceWei) / 1e18;
      return {
        address,
        balanceWei: balanceWei.toString(),
        balanceMon: Number(balanceMon.toFixed(4)),
        low: balanceMon < config.RELAYER_LOW_WATERMARK_MON,
      };
    } catch {
      return { error: "balance unavailable" };
    }
  };
  app.get("/healthz", async (c) =>
    c.json({
      ok: true,
      x402: config.X402_MODE,
      settlement: settlement.kind,
      blobs: config.BLOB_STORE,
      relayer: await floatOf(),
    }),
  );

  // A JSON-only service that 404s at the root looks broken to anyone who boots it and opens the URL.
  app.get("/", (c) =>
    c.html(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FIRSTHAND gateway</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  .sub { opacity: .7; margin-top: 0; }
  li { margin: .15rem 0; }
  a { color: inherit; }
</style>
<h1>FIRSTHAND gateway</h1>
<p class="sub">Serving path for passkey-rooted data passports — chain ${config.CHAIN_ID}, settlement
<code>${config.SETTLEMENT_MODE}</code>, x402 <code>${config.X402_MODE}</code>.</p>
<p>This host serves <strong>ciphertext and public proofs only</strong>. It holds no key material: it
cannot read what it serves, and it re-runs <code>verify()</code> against the chain on every request.</p>
<h2>Start here</h2>
<ul>${
      config.CAPTURE_URL
        ? `
  <li><a href="${config.CAPTURE_URL}">${config.CAPTURE_URL}</a> — the capture app: passkey → capture → paid query → withdraw consent, and a Verify tab that needs no locker</li>`
        : ""
    }
  <li><a href="/.well-known/firsthand.json">/.well-known/firsthand.json</a> — discovery: addresses, epochs, payment terms, relay, limits</li>
  <li><a href="/healthz">/healthz</a> — liveness</li>
</ul>
<h2>Endpoints</h2>
<ul>
  <li><code>GET /v1/query/:grantId/:passportId</code> — priced per query over x402; returns data only while consent is live</li>
  <li><code>GET /v1/passports/:id</code> · <code>/v1/blobs/:id</code> · <code>/v1/grants/:id/wrap</code> · <code>/v1/anchors/:root</code></li>
  <li><code>GET /v1/principals/:id/timeline</code> — the Consent Ledger: when consent began and ended</li>
  <li><code>POST /v1/passports</code> · <code>/v1/blobs</code> · <code>/v1/grants/:id/wrap</code> — verified ingest</li>
  <li><code>POST /v1/relay</code> — ${relay ? "enabled" : "disabled"}: submits signature-authorised calls for clients holding no key</li>
</ul>
<p>Source and a 15-second end-to-end demo:
<a href="https://github.com/kaustubh76/Firsthand">github.com/kaustubh76/Firsthand</a></p>`),
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
      // A browser has no DEPLOYMENTS_FILE; this document is its substitute, so it carries every
      // address and epoch parameter a client needs to build the same EIP-712 domain we verify under.
      contracts: deployment
        ? {
            PrincipalRegistry: deployment.PrincipalRegistry,
            PassportAnchors: deployment.PassportAnchors,
            GrantManager: deployment.GrantManager,
            Rescissions: deployment.Rescissions,
            ReceiptLedger: deployment.ReceiptLedger,
            RoyaltyRouter: deployment.RoyaltyRouter,
          }
        : null,
      epochs: deployment
        ? { genesis: String(deployment.genesis), length: String(deployment.epochLength) }
        : null,
      anchorsLayout: deployment?.anchorsLayout ?? null,
      rpcUrl: deployment ? config.MONAD_RPC_URL : null,
      relay: relay
        ? { enabled: true, endpoint: "POST /v1/relay", allow: relay.allowList }
        : { enabled: false },
      // Clients size their captures to this: ciphertext (plaintext + AEAD overhead) must fit.
      limits: { maxUploadBytes: config.MAX_UPLOAD_BYTES },
      app: config.CAPTURE_URL ?? null,
      // ERC-8004 (README §5): where the reference registries exist, buyers can be carded agents
      // and paid queries feed their reputation — given by `feedbackBy` (this gateway's relayer).
      erc8004: erc8004?.addresses
        ? {
            ...erc8004.addresses,
            feedbackBy: config.ERC8004_FEEDBACK ? relayerAddress : null,
            agent: "/v1/agents/:agentId",
          }
        : null,
      endpoints: {
        query: "/v1/query/:grantId/:passportId",
        relay: "POST /v1/relay",
        passport: "/v1/passports/:id",
        passports: "/v1/principals/:principalId/passports?ns=",
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
      const agentRaw = c.req.query("agent");
      if (agentRaw !== undefined && !/^\d{1,20}$/.test(agentRaw)) {
        throw new ValidationError("agent must be an ERC-8004 agent id");
      }
      const result = await serving.serve({
        grantId: parseId(c.req.param("grantId"), "grantId"),
        passportId: parseId(c.req.param("passportId"), "passportId"),
        payment: c.get("x402Payload"),
        requirements: c.get("x402Requirements"),
        ...(agentRaw === undefined ? {} : { agentId: BigInt(agentRaw) }),
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

  // Epochs, block numbers and timestamps are bigints; JSON has no such thing. Serialise them as
  // decimal strings rather than letting JSON.stringify throw a 500 on the audit surface.
  const jsonSafe = <T>(value: T): unknown =>
    JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

  /**
   * `?fromBlock=` lets a caller that knows where its history starts (the block its principal was
   * enrolled in) ask for exactly that, instead of the default recent-activity lookback. Bounded by
   * LEDGER_MAX_SCAN_BLOCKS so one request cannot turn into thousands of paced RPC calls.
   */
  /**
   * `?fromBlock=` bounded to the last LEDGER_MAX_SCAN_BLOCKS and given the scan budget; the route
   * says when it clamped, so a viewer can tell "no older events" from "not looked that far back".
   */
  const scanOf = async (
    raw: string | undefined,
  ): Promise<{ scan: LedgerScan | undefined; clamped: boolean; requested: bigint | null }> => {
    const budgetMs = config.LEDGER_SCAN_BUDGET_MS;
    if (raw === undefined) return { scan: { budgetMs }, clamped: false, requested: null };
    if (!/^\d{1,12}$/.test(raw)) throw new ValidationError("fromBlock must be a block number");
    const fromBlock = BigInt(raw);
    if (!chainHead) return { scan: { fromBlock, budgetMs }, clamped: false, requested: fromBlock };
    const head = await chainHead();
    const floor = head > config.LEDGER_MAX_SCAN_BLOCKS ? head - config.LEDGER_MAX_SCAN_BLOCKS : 0n;
    const clamped = fromBlock < floor;
    return {
      scan: { fromBlock: clamped ? floor : fromBlock, budgetMs },
      clamped,
      requested: fromBlock,
    };
  };

  app.get("/v1/grants/:grantId/receipts", async (c) => {
    const grantId = parseId(c.req.param("grantId"), "grantId");
    const { scan } = await scanOf(c.req.query("fromBlock"));
    return c.json(
      jsonSafe({ grantId, receipts: await requireLedger().receiptsForGrant(grantId, scan) }),
    );
  });

  /** Who is asking: an ERC-8004 agent, its bound card, and what this gateway has said about it. */
  app.get("/v1/agents/:agentId", async (c) => {
    if (!erc8004) {
      return c.json({ code: "FH_CONFIG", error: "no ERC-8004 registries on this chain" }, 404);
    }
    const raw = c.req.param("agentId") ?? "";
    if (!/^\d{1,20}$/.test(raw)) throw new ValidationError("agent id must be a decimal integer");
    const agentId = BigInt(raw);
    const view = await erc8004.agent(agentId);
    if (!view)
      return c.json({ code: "FH_NOT_FOUND", error: `agent ${raw} is not registered` }, 404);
    const [paid, all] = await Promise.all([
      relayerAddress
        ? erc8004.summary(agentId, [relayerAddress], FEEDBACK_TAG1, FEEDBACK_TAG2_PAID)
        : Promise.resolve({ count: 0n, value: 0n, decimals: 0 }),
      erc8004.summary(agentId, [], FEEDBACK_TAG1, ""),
    ]);
    return c.json(
      jsonSafe({
        ...view,
        registries: erc8004.addresses,
        reputation: {
          paidQueriesHere: paid.count,
          firsthandFeedbackAll: all.count,
          feedbackBy: relayerAddress,
        },
      }),
    );
  });

  /** Supply, discoverable: what a principal has published, for a buyer that was handed a locker link. */
  app.get("/v1/principals/:principalId/passports", async (c) => {
    const principalId = parseId(c.req.param("principalId"), "principalId");
    const nsRaw = c.req.query("ns");
    const ns = nsRaw === undefined ? undefined : Number(nsRaw);
    if (ns !== undefined && (!Number.isInteger(ns) || ns < 0 || ns > 15)) {
      throw new ValidationError("ns must be 0..15");
    }
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));
    return c.json(
      jsonSafe({
        principalId,
        passports: await serving.passportsOf(principalId, {
          ...(ns === undefined ? {} : { ns }),
          limit,
        }),
      }),
    );
  });

  app.get("/v1/principals/:principalId/anchors", async (c) => {
    const principalId = parseId(c.req.param("principalId"), "principalId");
    const ns = Number(c.req.query("ns") ?? "0");
    if (!Number.isInteger(ns) || ns < 0 || ns > 15) throw new ValidationError("ns must be 0..15");
    const { scan } = await scanOf(c.req.query("fromBlock"));
    return c.json(
      jsonSafe({
        principalId,
        ns,
        anchors: await requireLedger().anchorsFor(principalId, ns, scan),
      }),
    );
  });

  app.get("/v1/principals/:principalId/timeline", async (c) => {
    const principalId = parseId(c.req.param("principalId"), "principalId");
    const { scan, clamped, requested } = await scanOf(c.req.query("fromBlock"));
    const { events, scan: report } = await requireLedger().timeline(principalId, scan);
    return c.json(
      jsonSafe({
        principalId,
        events,
        scan: { ...report, clamped, requestedFromBlock: requested },
      }),
    );
  });

  // ── relay ───────────────────────────────────────────────────────────────────────────────────
  // For clients that hold no key (the capture PWA). Authorisation is inside the calldata — a P-256
  // signature under the contract's own EIP-712 domain — so relaying cannot change what a call means.

  app.get("/v1/relay/capabilities", (c) =>
    relay
      ? c.json(relay.capabilities())
      : c.json({ error: "relay is not enabled on this gateway" }, 404),
  );

  app.post(
    "/v1/relay",
    rateLimit(relayLimiter, (_h, ip) => ip),
    async (c) => {
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
    },
  );

  return { app, logger, shutdown, serving, domain, memory, relay, ledger: requireLedger() };
}
