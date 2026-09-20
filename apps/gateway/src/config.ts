import { loadEnv } from "@firsthand/runtime";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex private key");

/**
 * Gateway configuration — every field documented in .env.example. Validated at boot by `loadEnv`.
 * The gateway never holds user keys; RELAYER_PRIVATE_KEY only pays gas for settlements.
 */
export const GatewayConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8402),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  LOG_JSON: z.coerce.boolean().default(false),

  CHAIN_ID: z.coerce.bigint().default(10143n),
  MONAD_RPC_URL: z.string().url().default("https://testnet-rpc.monad.xyz"),
  /** With a deployment file the gateway reads anchors/grants from chain; without it, memory doubles. */
  DEPLOYMENTS_FILE: z.string().optional(),
  /** The same document inline — for hosts with no disk (serverless). Wins over DEPLOYMENTS_FILE. */
  DEPLOYMENT_JSON: z.string().optional(),
  /** Passport EIP-712 verifying contract in memory mode (ignored when DEPLOYMENTS_FILE is set). */
  PASSPORT_ANCHORS: address.default("0x0000000000000000000000000000000000000000"),

  SETTLEMENT_MODE: z.enum(["memory", "onchain"]).default("memory"),
  /**
   * Relay signature-authorised calls (enroll/attest/anchor/grant/rescind) for clients that hold no
   * key — the capture PWA. Off by default: it spends the relayer's gas on request.
   */
  RELAY_ENABLED: z.coerce.boolean().default(false),
  /**
   * Also relay `mint` on the deployment's USDC. Only meaningful where that token is the MockUSDC
   * faucet double (local chains, Monad testnet): it lets a keyless browser fund a demo buyer. Never
   * set this against a real stablecoin — mint would simply revert, but the intent is wrong.
   */
  RELAY_FAUCET_MINT: z.coerce.boolean().default(false),
  /** Largest MockUSDC amount one relayed `mint` may carry (base units; default 1 USDC = 100 queries). */
  RELAY_FAUCET_MAX_UNITS: z.coerce.bigint().positive().default(1_000_000n),
  /** Deployment block: where the Consent Ledger starts scanning logs. Scanning from 0 is slow. */
  LEDGER_FROM_BLOCK: z.coerce.bigint().optional(),
  /** How far back the log-backed ledger scans when LEDGER_FROM_BLOCK is unset. */
  LEDGER_LOOKBACK_BLOCKS: z.coerce.bigint().default(500n),
  /** Max blocks per eth_getLogs call — Monad's public RPC caps this at 100. */
  LEDGER_MAX_RANGE: z.coerce.bigint().default(100n),
  /** Minimum ms between log requests; Monad's public RPC caps throughput at 25/s. */
  LEDGER_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).default(50),
  /** Furthest back a caller's `?fromBlock=` may reach on the audit routes (bounds one request's RPC work). */
  LEDGER_MAX_SCAN_BLOCKS: z.coerce.bigint().default(5_000n),
  /**
   * Wall-clock budget for one audit-route scan. Walked newest-first, so a budget that runs out
   * still answers with the most recent history and a `scan.partial` flag — never a 504.
   */
  LEDGER_SCAN_BUDGET_MS: z.coerce.number().int().positive().default(40_000),
  /** Concurrent eth_getLogs calls; starts stay paced at LEDGER_MIN_REQUEST_INTERVAL_MS. */
  LEDGER_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(4),
  /** Settlement relayer for SETTLEMENT_MODE=onchain. Pays gas; never a user key. */
  RELAYER_PRIVATE_KEY: privateKey.optional(),
  /** /healthz reports `relayer.low` below this many MON — the refill signal. */
  RELAYER_LOW_WATERMARK_MON: z.coerce.number().nonnegative().default(0.5),
  /**
   * ERC-8004: after each paid query from a buyer that identifies as an agent (`?agent=`) and
   * provably owns the grant's card, the relayer gives one unit of `firsthand/paid-query` feedback
   * on the reference Reputation Registry. Costs relayer gas per query; off by default.
   */
  ERC8004_FEEDBACK: z.coerce.boolean().default(false),

  X402_MODE: z.enum(["memory", "monad"]).default("memory"),
  X402_FACILITATOR_URL: z.string().url().optional(),
  X402_FACILITATOR_API_KEY: z.string().optional(),
  X402_NETWORK: z.string().default("monad-testnet"),
  USDC_ADDRESS: address.default("0x0000000000000000000000000000000000000dc0"),
  USDC_NAME: z.string().default("USD Coin"),
  USDC_VERSION: z.string().default("2"),
  /** Where buyers pay: the RoyaltyRouter (decision #9). Overridden by the deployment file. */
  PAY_TO: address.default("0x0000000000000000000000000000000000000000"),
  PUBLIC_URL: z.string().url().default("http://localhost:8402"),
  /**
   * Browser origins allowed to call the gateway (the capture PWA is served from another host).
   * Comma-separated, or `*`. Every route is signature- or payment-authorised, never cookie-based,
   * so a permissive default costs nothing.
   */
  CORS_ORIGINS: z.string().default("*"),
  /** The capture app this gateway serves; linked from the landing page and discovery. */
  CAPTURE_URL: z.string().url().optional(),

  /** `vercel` keeps blobs and passports in Vercel Blob — durable across serverless invocations. */
  BLOB_STORE: z.enum(["memory", "fs", "vercel"]).default("memory"),
  BLOB_DIR: z.string().default("./data/blobs"),
  CATALOG: z.enum(["memory", "fs", "vercel"]).default("memory"),
  CATALOG_DIR: z.string().default("./data/passports"),
  /** Vercel Blob read-write token; the name Vercel injects when a store is connected to the project. */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  /** Key prefix inside the store, so one store can host several gateways. */
  BLOB_PREFIX: z.string().default("firsthand"),
  /** Maximum accepted ciphertext / wrap upload size. */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),

  /** Half-life (s) of the freshness signal (README §7.3); defaults to one epoch. */
  FRESHNESS_HALF_LIFE_S: z.coerce.bigint().positive().optional(),

  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().nonnegative().default(1),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  return loadEnv(GatewayConfigSchema, source);
}
