import { type P256PublicKey, p256Commitment } from "../authority/p256.js";
import {
  type Address,
  assertAddress,
  assertBytes32,
  type Bytes32,
  bytesToHex,
  concat,
  hexToBytes,
  u64be,
  u256be,
  utf8,
} from "../bytes.js";
import { sha256 } from "../hash.js";

/**
 * The digest a secure element signs for one capture (ADR-0015).
 *
 * The witness needs no slot of its own in the frozen `Attestation` type, because every input here
 * is a value the passport already commits to: `h`, `origin` and `nonce` are fields of `Passport`,
 * and `capturedAt` and `deviceClass` are inside the `attest` commitment. Change any of them and
 * the passport changes with them, so a signature over this digest cannot be lifted onto different
 * bytes, a different locker, or a replayed deposit — which is the whole claim (README §13).
 *
 * `origin` and `nonce` are what make it *transplantation*-resistant rather than merely
 * content-binding: the same photo deposited by a second locker has a different origin key and a
 * different deterministic nonce, so the witness no longer verifies.
 *
 * SHA-256 rather than keccak because that is what a `KeyStore` `Signature` instance produces on
 * Android (`DIGEST_SHA256`) and what `P256.sol` hands the RIP-7212 precompile — one digest, three
 * implementations, no conversion step to get wrong.
 */

/** Domain separator. Bump the version rather than changing the field order. */
export const HARDWARE_CAPTURE_DOMAIN = "FIRSTHAND-HW-CAPTURE-v1";

export interface HardwareCaptureInput {
  /** EVM chain id — a witness minted for one chain must not verify on another. */
  readonly chainId: bigint;
  /** `Passport.origin`, the secp256k1 deposit address for this namespace and epoch. */
  readonly origin: Address;
  /** `Passport.h` — `keccak256(canonical(datum))`. */
  readonly contentHash: Bytes32;
  /** `Attestation.capturedAt`, unix seconds. Unverifiable device clock; bound, not trusted. */
  readonly capturedAt: bigint;
  /** `Passport.nonce`. */
  readonly nonce: Bytes32;
  /** `Attestation.deviceClass` — for class 3, `deviceKeyCommitment(hardwareKey)`. */
  readonly deviceClass: Bytes32;
}

/** `sha256(domain ‖ chainId ‖ origin ‖ h ‖ capturedAt ‖ nonce ‖ deviceClass)`. */
export function hardwareCaptureDigest(input: HardwareCaptureInput): Bytes32 {
  assertAddress(input.origin, "origin");
  assertBytes32(input.contentHash, "contentHash");
  assertBytes32(input.nonce, "nonce");
  assertBytes32(input.deviceClass, "deviceClass");

  return bytesToHex(
    sha256(
      concat(
        utf8(HARDWARE_CAPTURE_DOMAIN),
        u256be(input.chainId),
        hexToBytes(input.origin),
        hexToBytes(input.contentHash),
        u64be(input.capturedAt),
        hexToBytes(input.nonce),
        hexToBytes(input.deviceClass),
      ),
    ),
  );
}

/**
 * `keccak256(abi.encode(x, y))` of the secure element's public key — what a class-3 passport puts
 * in `Attestation.deviceClass` and what `HardwareDeviceRegistry` keys its records by.
 *
 * The same commitment function the principal's authority key already uses, so the registry and
 * `PrincipalRegistry` agree on what naming a P-256 key means.
 */
export function deviceKeyCommitment(publicKey: P256PublicKey): Bytes32 {
  return p256Commitment(publicKey);
}
