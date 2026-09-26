import type { ReceiptView } from "@firsthand/adapters";
import {
  type Bytes32,
  type Eip712Domain,
  type LineageManifest,
  LineageManifestSchema,
  type LineageManifestWire,
  passportId,
  ValidationError,
} from "@firsthand/core";
import type { AnchoredBatch } from "../batch/Batcher.js";

/**
 * Lineage Manifest export (README §1, §19): one entry per licensed passport with its batch proof and
 * receipt — the buyer's per-asset diligence file, verifiable offline with ≤ 8 hashes per asset (H3).
 */
export interface ExportInput {
  readonly domain: Eip712Domain;
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly batches: readonly AnchoredBatch[];
  /** Receipts keyed by passport id; assets without a receipt are still listed (unpaid lineage). */
  readonly receipts?: ReadonlyMap<Bytes32, ReceiptView>;
  readonly finalityDepth?: number;
  readonly now?: () => bigint;
}

export function exportManifest(input: ExportInput): LineageManifest {
  // One file per corpus (§1, §24): the header names a principal and a namespace, and every batch in
  // it has to belong to them. `manifestFromSidecars` has always enforced this; this path did not,
  // so a ns-3 batch could be exported under a `ns: 0` header and the header would be a fiction.
  for (const batch of input.batches) {
    if (batch.ns !== input.ns) {
      throw new ValidationError("a manifest holds one namespace", {
        context: { header: input.ns, batch: batch.ns, root: batch.root },
      });
    }
  }
  const wire: LineageManifestWire = {
    version: 1,
    domain: {
      chainId: input.domain.chainId.toString(),
      verifyingContract: input.domain.verifyingContract,
    },
    principalId: input.principalId,
    ns: input.ns,
    generatedAt: (input.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))().toString(),
    finalityDepth: input.finalityDepth ?? 2,
    assets: input.batches.flatMap((batch) =>
      batch.passports.map((signed) => {
        const id = passportId(signed.passport);
        const proof = batch.proofs.get(id);
        if (!proof) throw new Error(`batch ${batch.root} has no proof for ${id}`);
        const receipt = input.receipts?.get(id);
        return {
          signed: {
            passport: { ...signed.passport, epoch: signed.passport.epoch.toString() },
            signature: signed.signature,
          },
          batchRoot: batch.root,
          proof: { index: proof.index, siblings: [...proof.siblings] },
          anchorBlock: batch.anchor.blockNumber.toString(),
          ...(receipt
            ? {
                receipt: {
                  receiptId: receipt.receiptId,
                  grantId: receipt.grantId,
                  blockNumber: receipt.blockNumber.toString(),
                  txHash: receipt.txHash,
                },
              }
            : {}),
        };
      }),
    ),
  };
  return LineageManifestSchema.parse(wire);
}

export function serialiseManifest(manifest: LineageManifest): string {
  return JSON.stringify(manifest, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
