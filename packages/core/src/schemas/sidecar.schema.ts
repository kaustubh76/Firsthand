import { z } from "zod";
import type { HardwareWitness } from "../attestation/hardwareDigest.js";
import type { Bytes32 } from "../bytes.js";
import type { BatchProof } from "../merkle/merkle.js";
import type { Attestation, SignedPassport, Terms } from "../passport/types.js";
import {
  AttestationSchema,
  BatchProofSchema,
  HardwareWitnessSchema,
  SignedPassportSchema,
  TermsSchema,
} from "./passport.schema.js";
import { Bytes32Schema, Uint32Schema } from "./primitives.js";

/**
 * Passport sidecar: everything public a gateway needs to serve one passport (README §7.1 "passports
 * live with the encrypted blobs"). Contains no plaintext and no keys — only the signed passport, its
 * batch proof, the terms preimage, the attestation preimage, and content-addressed ciphertext
 * locators. The attestation is what "buyers filter by attestation class" (README §13) needs in the
 * open: its hash is committed in the passport, so a gateway checks the preimage at ingest.
 * Optional because sidecars published before it existed carry only the hash.
 */
export const PassportSidecarSchema = z.object({
  signed: SignedPassportSchema,
  principalId: Bytes32Schema,
  ns: Uint32Schema,
  batchRoot: Bytes32Schema,
  proof: BatchProofSchema,
  terms: TermsSchema,
  attestation: AttestationSchema.optional(),
  /** Present on class 3 only; what makes "hardware" a fact rather than a label. */
  hardware: HardwareWitnessSchema.optional(),
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
  /** The preimage of `passport.attest`; absent on sidecars published before it was carried. */
  readonly attestation?: Attestation;
  /** The secure element's signature over this passport; required when `attestation.class` is 3. */
  readonly hardware?: HardwareWitness;
  readonly blobRef: Bytes32;
  readonly wrappedDekRef: Bytes32;
}

export function parseSidecar(input: unknown): PassportSidecar {
  const { attestation, hardware, ...rest } = PassportSidecarSchema.parse(input);
  // `exactOptionalPropertyTypes`: an absent optional is absent, never `undefined`.
  return { ...rest, ...(attestation ? { attestation } : {}), ...(hardware ? { hardware } : {}) };
}

/** Serialises a sidecar to its wire form (bigints → decimal strings). */
export function sidecarToWire(sidecar: PassportSidecar): PassportSidecarWire {
  const { attestation: _attestation, hardware: _hardware, ...rest } = sidecar;
  return {
    ...rest,
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
    ...(sidecar.attestation
      ? {
          attestation: {
            ...sidecar.attestation,
            capturedAt: sidecar.attestation.capturedAt.toString(),
          },
        }
      : {}),
    // No bigints in a witness, so it travels unchanged — but it still has to be spread
    // conditionally, or `exactOptionalPropertyTypes` sees an explicit `undefined`.
    ...(sidecar.hardware ? { hardware: sidecar.hardware } : {}),
    proof: { index: sidecar.proof.index, siblings: [...sidecar.proof.siblings] },
  };
}
