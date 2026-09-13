import { loadEnv } from "@firsthand/runtime";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");

/** Gateway configuration — every field documented in .env.example. Validated at boot by `loadEnv`. */
export const GatewayConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8402),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  LOG_JSON: z.coerce.boolean().default(false),

  CHAIN_ID: z.coerce.bigint().default(10143n),
  MONAD_RPC_URL: z.string().url().default("https://testnet-rpc.monad.xyz"),
  /** Optional in tests / dry runs; the gateway is then chain-blind and serves only health + 402s. */
  DEPLOYMENTS_FILE: z.string().optional(),

  X402_MODE: z.enum(["memory", "monad"]).default("memory"),
  X402_FACILITATOR_URL: z.string().url().optional(),
  X402_FACILITATOR_API_KEY: z.string().optional(),
  X402_NETWORK: z.string().default("monad-testnet"),
  USDC_ADDRESS: address.default("0x0000000000000000000000000000000000000dc0"),
  /** Where buyers pay: the RoyaltyRouter (decision #9). */
  PAY_TO: address.default("0x0000000000000000000000000000000000000000"),
  PUBLIC_URL: z.string().url().default("http://localhost:8402"),

  BLOB_STORE: z.enum(["memory", "fs"]).default("memory"),
  BLOB_DIR: z.string().default("./data/blobs"),

  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().nonnegative().default(1),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  return loadEnv(GatewayConfigSchema, source);
}
