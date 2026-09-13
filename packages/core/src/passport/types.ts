import type { Address, Bytes32, Hex } from "../bytes.js";

/**
 * Attestation classes (README §13 "synthetic laundering" mitigation). A passport certifies the
 * origin key and the class of capture — never semantic quality or humanity.
 */
export const AttestationClass = {
  UNATTESTED: 0,
  IMPORT: 1,
  DEVICE_CAPTURE: 2,
} as const;
export type AttestationClass = (typeof AttestationClass)[keyof typeof AttestationClass];

/** License scope bitfield carried in `Terms.scope`. */
export const Scope = {
  TRAIN: 1,
  INFER: 2,
  EVAL: 4,
  REDISTRIBUTE: 8,
} as const;
export type ScopeFlag = (typeof Scope)[keyof typeof Scope];

/** Machine-readable license terms. `payees`/`weights` feed SplitMath. */
export interface Terms {
  /** Price per query in USDC base units (uint64). */
  readonly price: bigint;
  /** `keccak256(utf8("FH-1.0"))`-style license identifier. */
  readonly licenseId: Bytes32;
  /** Bitwise OR of `Scope` flags (uint32). */
  readonly scope: number;
  /** Namespace index within the principal, `0..MAX_NAMESPACES-1` (uint32). */
  readonly ns: number;
  /** Queries per epoch per grant (uint32). */
  readonly rateLimit: number;
  readonly payees: readonly Address[];
  /** WAD-scaled weights, same length as `payees`. */
  readonly weights: readonly bigint[];
}

/** Capture metadata commitment preimage. */
export interface Attestation {
  readonly class: AttestationClass;
  /** Unix seconds (uint64). */
  readonly capturedAt: bigint;
  /** e.g. `keccak256(utf8("chatgpt-export-v1"))`; zero when not applicable. */
  readonly sourceTag: Bytes32;
  /** Coarse device/source class commitment; zero when not applicable. */
  readonly deviceClass: Bytes32;
  /** `keccak256(utf8(JCS(extraMeta)))` or zero. */
  readonly metaHash: Bytes32;
}

/** The Data Passport `P` (README §7.1) as the EIP-712 struct that is anchored and signed. */
export interface Passport {
  /** Content hash `keccak256(canonical(d))`. */
  readonly h: Bytes32;
  /** secp256k1 address of the epoch deposit key `pk_agent(ns, e)`. */
  readonly origin: Address;
  /** `hashAttestation(Attestation)`. */
  readonly attest: Bytes32;
  /** `hashTerms(Terms)`. */
  readonly termsHash: Bytes32;
  /** Epoch of the deposit key (uint64). */
  readonly epoch: bigint;
  /** Deterministic per-content nonce `HMAC(k_nonce(ns,e), h)` (ADR-0005). */
  readonly nonce: Bytes32;
}

export interface Eip712Domain {
  readonly chainId: bigint;
  /** The PassportAnchors deployment. */
  readonly verifyingContract: Address;
}

/** 65-byte `r ‖ s ‖ v` secp256k1 signature, `v ∈ {27, 28}`, low-s. */
export type PassportSignature = Hex;

export interface SignedPassport {
  readonly passport: Passport;
  readonly signature: PassportSignature;
}

/** JSON value as accepted by RFC 8785 canonicalisation. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What gets hashed into `Passport.h`. */
export type Datum =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "json"; readonly value: JsonValue };
