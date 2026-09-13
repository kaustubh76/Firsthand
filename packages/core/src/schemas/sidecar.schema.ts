import { z } from "zod";
import type { Bytes32 } from "../bytes.js";
import type { BatchProof } from "../merkle/merkle.js";
import type { SignedPassport, Terms } from "../passport/types.js";
import { BatchProofSchema, SignedPassportSchema, TermsSchema } from "./passport.schema.js";
import { Bytes32Schema, Uint32Schema } from "./primitives.js";

/**
 * Passport sidecar: everything public a gateway needs to serve one passport (README §7.1 "passports
 * live with the encrypted blobs"). Contains no plaintext and no keys — only the signed passport, its
 * batch proof, the terms preimage, and content-addressed ciphertext locators.
 */
export const PassportSidecarSchema = z.object({
  signed: SignedPassportSchema,
  principalId: Bytes32Schema,
  ns: Uint32Schema,
  batchRoot: Bytes32Schema,
  proof: BatchProofSchema,
  terms: TermsSchema,
  /** `keccak256(blob)` — id in the BlobStore. */
  blobRef: Bytes32Schema,
  wrappedDekRef: Bytes32Schema,
});

export type PassportSidecarWire = z.input<typeof PassportSidecarSchema>;

/** In-memory sidecar with the core's readonly types; `parseSidecar` produces one from the wire form. */
export interface PassportSidecar {
  readonly signed: SignedPassport;
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly batchRoot: Bytes32;
  readonly proof: BatchProof;
  readonly terms: Terms;
  readonly blobRef: Bytes32;
  readonly wrappedDekRef: Bytes32;
}

export function parseSidecar(input: unknown): PassportSidecar {
  return PassportSidecarSchema.parse(input);
}

/** Serialises a sidecar to its wire form (bigints → decimal strings). */
export function sidecarToWire(sidecar: PassportSidecar): PassportSidecarWire {
  return {
    ...sidecar,
    signed: {
      passport: { ...sidecar.signed.passport, epoch: sidecar.signed.passport.epoch.toString() },
      signature: sidecar.signed.signature,
    },
    terms: {
      ...sidecar.terms,
      price: sidecar.terms.price.toString(),
      weights: sidecar.terms.weights.map((w) => w.toString()),
      payees: [...sidecar.terms.payees],
    },
    proof: { index: sidecar.proof.index, siblings: [...sidecar.proof.siblings] },
  };
}
