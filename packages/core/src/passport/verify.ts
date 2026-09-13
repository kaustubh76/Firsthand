import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  type Address,
  assertBytes32,
  type Bytes32,
  bytesToBigInt,
  bytesToHex,
  type Hex,
  hexToBytes,
  isHexOfLength,
} from "../bytes.js";
import { keccak256 } from "../hash.js";
import { passportDigest } from "./typed.js";
import type { Eip712Domain, Passport, PassportSignature } from "./types.js";

const SECP_N = secp256k1.Point.CURVE().n;
const SECP_HALF_N = SECP_N >> 1n;

export interface RecoveredSignature {
  readonly r: bigint;
  readonly s: bigint;
  /** 27 or 28. */
  readonly v: number;
}

/**
 * Parses a 65-byte `r ‖ s ‖ v` signature. Returns `null` (never throws) for malformed input,
 * high-s values, or `v ∉ {27, 28}` so that verification is a pure predicate.
 */
export function parseSignature(signature: Hex): RecoveredSignature | null {
  if (!isHexOfLength(signature, 65)) return null;
  const bytes = hexToBytes(signature);
  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  const v = bytes[64] as number;
  if (v !== 27 && v !== 28) return null;
  if (r === 0n || r >= SECP_N) return null;
  if (s === 0n || s > SECP_HALF_N) return null;
  return { r, s, v };
}

/** Ethereum address of an uncompressed (65-byte, `0x04`-prefixed) secp256k1 public key. */
export function addressOfPublicKey(uncompressed: Uint8Array): Address {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new TypeError("expected a 65-byte uncompressed secp256k1 public key");
  }
  return bytesToHex(keccak256(uncompressed.subarray(1)).subarray(12));
}

/** `ecrecover(digest, v, r, s)`; `null` when the signature is malformed or recovery fails. */
export function recoverSigner(digest: Bytes32, signature: Hex): Address | null {
  assertBytes32(digest, "digest");
  const parsed = parseSignature(signature);
  if (parsed === null) return null;
  try {
    const sig = new secp256k1.Signature(parsed.r, parsed.s, parsed.v - 27);
    const point = sig.recoverPublicKey(hexToBytes(digest));
    return addressOfPublicKey(point.toBytes(false));
  } catch {
    return null;
  }
}

/** The one-call origin check: `ecrecover(digest(P)) == P.origin`, low-s enforced. */
export function verifyPassportSignature(
  passport: Passport,
  signature: PassportSignature,
  domain: Eip712Domain,
): boolean {
  const signer = recoverSigner(passportDigest(passport, domain), signature);
  return signer !== null && signer === passport.origin;
}
