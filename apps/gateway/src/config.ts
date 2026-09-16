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
  /** Passport EIP-712 verifying contract in memory mode (ignored when DEPLOYMENTS_FILE is set). */
  PASSPORT_ANCHORS: address.default("0x0000000000000000000000000000000000000000"),

  SETTLEMENT_MODE: z.enum(["memory", "onchain"]).default("memory"),
  /**
   * Relay signature-authorised calls (enroll/attest/anchor/grant/rescind) for clients that hold no
   * key — the capture PWA. Off by default: it spends the relayer's gas on request.
   */
  RELAY_ENABLED: z.coerce.boolean().default(false),
  /** Settlement relayer for SETTLEMENT_MODE=onchain. Pays gas; never a user key. */
  RELAYER_PRIVATE_KEY: privateKey.optional(),

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

  BLOB_STORE: z.enum(["memory", "fs"]).default("memory"),
  BLOB_DIR: z.string().default("./data/blobs"),
  CATALOG: z.enum(["memory", "fs"]).default("memory"),
  CATALOG_DIR: z.string().default("./data/passports"),
  /** Maximum accepted ciphertext / wrap upload size. */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),

  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().nonnegative().default(1),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  return loadEnv(GatewayConfigSchema, source);
}
