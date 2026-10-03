import { z } from "zod";

/** Tool input schemas — zod here becomes the JSON Schema agents see. */
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "32-byte lowercase hex");
const address = z.string().regex(/^0x[0-9a-f]{40}$/, "20-byte lowercase hex address");

export const DepositInputSchema = z.object({
  ns: z.number().int().min(0).max(15).describe("Namespace index within the locker (0..15)"),
  text: z
    .string()
    .min(1)
    .describe("Plaintext to deposit. Sealed client-side; the gateway never sees it."),
  priceUnits: z
    .string()
    .regex(/^\d+$/)
    .default("1")
    .describe("Price per query in USDC base units (6 decimals)"),
  payee: address.describe("Address that receives royalties"),
  attestationClass: z
    .enum(["unattested", "import", "device_capture", "hardware"])
    .default("unattested"),
  sourceTag: z.string().optional().describe("Import source label, e.g. chatgpt-export-v1"),
  publish: z
    .boolean()
    .default(true)
    .describe(
      "Anchor the batch on chain and publish ciphertext + sidecar to the gateway, so a buyer can query it. Requires DEPLOYMENTS_FILE and GATEWAY_URL; without them the deposit stays local.",
    ),
});

export const ImportInputSchema = z.object({
  source: z.enum(["chatgpt", "claude"]).describe("Which export format the file is in"),
  path: z.string().min(1).describe("Path to the export file on this machine"),
  ns: z.number().int().min(0).max(15).default(0),
  priceUnits: z.string().regex(/^\d+$/).default("1"),
  payee: address.describe("Address that receives royalties"),
  limit: z.number().int().min(1).max(500).default(25).describe("Maximum conversations to deposit"),
  publish: z.boolean().default(true),
});

export const RegisterCardInputSchema = z.object({});

export const AcceptTermsInputSchema = z.object({
  principalId: hex32.describe("Principal whose terms are being accepted"),
  ns: z.number().int().min(0).max(15).default(0),
  priceUnits: z.string().regex(/^\d+$/).default("1"),
  payee: address.describe("Address the principal's terms pay out to"),
  rateLimit: z.number().int().min(0).default(100),
});

const agentId = z
  .string()
  .regex(/^\d{1,20}$/)
  .optional()
  .describe(
    "ERC-8004 agent id; defaults to BUYER_AGENT_ID. Paid queries then feed its reputation.",
  );

export const QueryInputSchema = z.object({
  gatewayUrl: z.string().url(),
  grantId: hex32,
  passportId: hex32,
  agentId,
});

export const RegisterAgentInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(280).default("FIRSTHAND buyer agent"),
});

export const AgentReputationInputSchema = z.object({
  agentId: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional()
    .describe("defaults to BUYER_AGENT_ID"),
});

export const RequestAccessInputSchema = z.object({
  passportId: hex32
    .optional()
    .describe("A passport the gateway hosts — its sidecar names the principal and terms"),
  principalId: hex32
    .optional()
    .describe("Or a principal (from a shared locker link): the newest passport sets the terms"),
  ns: z
    .number()
    .int()
    .min(0)
    .max(15)
    .optional()
    .describe("With principalId: restrict to a namespace"),
  agentId,
  label: z.string().max(64).default("an agent").describe("How the human will see this buyer"),
  appUrl: z
    .string()
    .url()
    .default("https://firsthand-capture.vercel.app")
    .describe("The capture app the human uses; the approval link opens there"),
});

export const ListPassportsInputSchema = z.object({
  principalId: hex32.describe("The principal whose published passports to list"),
  ns: z.number().int().min(0).max(15).optional(),
  class: z
    .enum(["unattested", "import", "device_capture", "hardware"])
    .optional()
    .describe("Only passports of this attestation class (README §13: buyers filter by class)"),
  limit: z.number().int().min(1).max(100).default(50),
});

export const ExportManifestInputSchema = z.object({
  gatewayUrl: z.string().url(),
  grantId: hex32,
  passportIds: z.array(hex32).min(1).max(64),
  agentId,
});

export const ExportLockerInputSchema = z.object({
  gatewayUrl: z.string().url().optional().describe("Defaults to GATEWAY_URL"),
  principalId: hex32
    .optional()
    .describe("Whose locker to read; defaults to this server's own locker (the PRF session)"),
  grantIds: z
    .array(hex32)
    .max(256)
    .default([])
    .describe("Grants whose wrap bytes should travel with the bundle"),
  path: z.string().min(1).describe("Where to write the bundle file on this machine"),
});

export const ImportLockerInputSchema = z.object({
  gatewayUrl: z.string().url().optional().describe("Defaults to GATEWAY_URL"),
  path: z
    .string()
    .min(1)
    .describe("A locker bundle written by firsthand_export_locker (or the app)"),
});

export const RescindInputSchema = z.object({
  grantId: hex32,
  path: z
    .enum(["btx", "commit-reveal", "public"])
    .optional()
    .describe(
      "Transport path; defaults to what the configured transport can honour (btx when BTX_RPC_URL is set, else public). btx is un-front-runnable, commit-reveal is the fallback that works everywhere",
    ),
  salt: hex32.optional().describe("For commit-reveal step 2: the salt returned by the commit call"),
});

export const EnrollInputSchema = z.object({
  epoch: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Epoch to enrol at; defaults to the current epoch"),
});

export const AttestInputSchema = z.object({
  epoch: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Epoch to attest; defaults to the current epoch"),
});

export const GrantInputSchema = z.object({
  granteeCard: hex32.describe("The buyer's card id (keccak(owner, x25519PubKey))"),
  granteeEncryptionPubKey: hex32.describe(
    "The buyer's X25519 public key, as registered in the card",
  ),
  ns: z.number().int().min(0).max(15),
  termsHash: hex32.describe("Terms the buyer accepted for this namespace"),
  term: z.string().regex(/^\d+$/).default("4").describe("Grant term in epochs (≤ 8)"),
  gatewayUrl: z.string().url().optional().describe("Where to publish the wrap bytes for the buyer"),
});

export const StatusInputSchema = z.object({});
