import { z } from "zod";
import { MAX_RECIPIENTS } from "../constants.js";
import { AttestationClass } from "../passport/types.js";
import {
  AddressSchema,
  Bytes32Schema,
  Signature64Schema,
  Signature65Schema,
  Uint8Schema,
  Uint32Schema,
  Uint64Schema,
  Uint256Schema,
} from "./primitives.js";

export const TermsSchema = z
  .object({
    price: Uint64Schema,
    licenseId: Bytes32Schema,
    scope: Uint32Schema,
    ns: Uint32Schema,
    rateLimit: Uint32Schema,
    payees: z.array(AddressSchema).min(1).max(MAX_RECIPIENTS),
    weights: z.array(Uint256Schema).min(1).max(MAX_RECIPIENTS),
  })
  .refine((t) => t.payees.length === t.weights.length, "payees and weights must align");

export const AttestationSchema = z.object({
  class: Uint8Schema.refine(
    (c): c is AttestationClass => Object.values(AttestationClass).includes(c as AttestationClass),
    "unknown attestation class",
  ),
  capturedAt: Uint64Schema,
  sourceTag: Bytes32Schema,
  deviceClass: Bytes32Schema,
  metaHash: Bytes32Schema,
});

/**
 * The secure-element witness a class-3 passport carries (ADR-0015). Verified, never trusted: the
 * key commitment must equal `Attestation.deviceClass` and the signature must verify over
 * `hardwareCaptureDigest`, which binds values the passport already commits to.
 */
export const HardwareWitnessSchema = z.object({
  publicKey: z.object({ x: Bytes32Schema, y: Bytes32Schema }),
  signature: Signature64Schema,
});

export const PassportSchema = z.object({
  h: Bytes32Schema,
  origin: AddressSchema,
  attest: Bytes32Schema,
  termsHash: Bytes32Schema,
  epoch: Uint64Schema,
  nonce: Bytes32Schema,
});

export const SignedPassportSchema = z.object({
  passport: PassportSchema,
  signature: Signature65Schema,
});

export const Eip712DomainSchema = z.object({
  chainId: Uint256Schema,
  verifyingContract: AddressSchema,
});

export const BatchProofSchema = z.object({
  index: z.number().int().min(0).max(255),
  siblings: z.array(Bytes32Schema).length(8),
});

export type TermsWire = z.input<typeof TermsSchema>;
export type PassportWire = z.input<typeof PassportSchema>;
export type SignedPassportWire = z.input<typeof SignedPassportSchema>;
