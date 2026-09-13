import { z } from "zod";
import {
  BatchProofSchema,
  Eip712DomainSchema,
  PassportSchema,
  SignedPassportSchema,
} from "./passport.schema.js";
import { Bytes32Schema, Uint64Schema } from "./primitives.js";

/**
 * Lineage Manifest v1 (README §1, §19): the buyer's per-asset audit file. One entry per licensed
 * passport with its batch proof and the receipt that paid for it. Verifiable offline against
 * anchored roots with ≤ 8 hashes per asset (H3).
 */
export const ManifestReceiptSchema = z.object({
  receiptId: Bytes32Schema,
  grantId: Bytes32Schema,
  /** Block in which the receipt was recorded. */
  blockNumber: Uint64Schema,
  txHash: Bytes32Schema,
});

export const ManifestAssetSchema = z.object({
  signed: SignedPassportSchema,
  batchRoot: Bytes32Schema,
  proof: BatchProofSchema,
  /** Anchor block for `batchRoot`; verifiers require `finalityDepth` confirmations past it. */
  anchorBlock: Uint64Schema,
  receipt: ManifestReceiptSchema.optional(),
});

export const LineageManifestSchema = z.object({
  version: z.literal(1),
  domain: Eip712DomainSchema,
  principalId: Bytes32Schema,
  ns: z.number().int().min(0),
  generatedAt: Uint64Schema,
  finalityDepth: z.number().int().min(0),
  assets: z.array(ManifestAssetSchema),
});

export type LineageManifestWire = z.input<typeof LineageManifestSchema>;
export type LineageManifest = z.output<typeof LineageManifestSchema>;
export type ManifestAsset = z.output<typeof ManifestAssetSchema>;
export { PassportSchema as ManifestPassportSchema };
