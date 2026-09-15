import { loadEnv } from "@firsthand/runtime";
import { z } from "zod";

/** MCP server configuration. This process runs on the user's machine and may derive keys. */
export const McpConfigSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  CHAIN_ID: z.coerce.bigint().default(10143n),
  /** PassportAnchors address — the EIP-712 verifyingContract. */
  PASSPORT_ANCHORS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x0000000000000000000000000000000000000000"),
  PRINCIPAL_REGISTRY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x0000000000000000000000000000000000000000"),
  /** JSON-RPC endpoint; with RELAYER_PRIVATE_KEY set, enroll/attest broadcast through it. */
  RPC_URL: z.string().url().optional(),
  /** Relayer wallet that pays gas for relayable verbs. Never a user key. */
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /**
   * BTX submission endpoint. When set (with RELAYER_PRIVATE_KEY) rescissions travel the encrypted
   * mempool; `firsthand_rescind` refuses with FH_BTX_UNAVAILABLE if the node does not know the
   * method. BTX is not deployed on Monad testnet as of 2026-09 — commit-reveal is the fallback.
   */
  BTX_RPC_URL: z.string().url().optional(),
  BTX_METHOD: z.string().min(1).default("eth_sendEncryptedRawTransaction"),
  GRANT_MANAGER: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x0000000000000000000000000000000000000000"),
  RESCISSIONS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x0000000000000000000000000000000000000000"),
  EPOCH_GENESIS: z.coerce.bigint().default(0n),
  EPOCH_LENGTH: z.coerce.bigint().default(604_800n),
  /**
   * PRF source. `static` reads FIRSTHAND_STATIC_PRF_HEX (demo/dev ONLY — not rooted in a passkey).
   * `webauthn` is not possible over stdio; the capture PWA performs the ceremony and hands the
   * session to this server in Phase 5.
   */
  PRF_SOURCE: z.enum(["static"]).default("static"),
  FIRSTHAND_STATIC_PRF_HEX: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  BLOB_DIR: z.string().default("./data/blobs"),
  /** Buyer side (optional): the agent's EVM key (pays + signs terms) and its X25519 seed. */
  BUYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  GRANTEE_SEED_HEX: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): McpConfig {
  return loadEnv(McpConfigSchema, source);
}
