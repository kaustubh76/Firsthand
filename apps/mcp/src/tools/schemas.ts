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
  attestationClass: z.enum(["unattested", "import", "device_capture"]).default("unattested"),
  sourceTag: z.string().optional().describe("Import source label, e.g. chatgpt-export-v1"),
});

export const QueryInputSchema = z.object({
  gatewayUrl: z.string().url(),
  grantId: hex32,
  passportId: hex32,
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
