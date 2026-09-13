import { p256 } from "@noble/curves/nist.js";
import {
  assertBytes32,
  type Bytes32,
  bytesToBigInt,
  bytesToHex,
  concat,
  type Hex,
  hexToBytes,
  isHexOfLength,
  u256be,
} from "../bytes.js";
import { keccak256Hex } from "../hash.js";

/**
 * P-256 (secp256r1) **verification** — the public half of "P256 = human authority" (README §7.3).
 * Signing lives in @firsthand/crypto. On-chain the same check runs through the RIP-7212 precompile
 * (`contracts/src/libraries/P256.sol`), which takes `hash ‖ r ‖ s ‖ x ‖ y`; this module uses the
 * identical 64-byte `r ‖ s` encoding and the same low-s rule so vectors are shared.
 */

export const P256_N: bigint = p256.Point.CURVE().n;
const P256_HALF_N = P256_N >> 1n;

export interface P256PublicKey {
  readonly x: Bytes32;
  readonly y: Bytes32;
}

/** `keccak256(abi.encode(x, y))` — the enrolled `p256KeyCommit`, which doubles as `principalId`. */
export function p256Commitment(publicKey: P256PublicKey): Bytes32 {
  assertBytes32(publicKey.x, "x");
  assertBytes32(publicKey.y, "y");
  return keccak256Hex(concat(hexToBytes(publicKey.x), hexToBytes(publicKey.y)));
}

/** Splits a 65-byte uncompressed SEC1 point into `{x, y}`; throws on any other encoding. */
export function p256PublicKeyFromUncompressed(uncompressed: Uint8Array): P256PublicKey {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new TypeError("expected a 65-byte uncompressed P-256 public key");
  }
  return {
    x: bytesToHex(uncompressed.subarray(1, 33)),
    y: bytesToHex(uncompressed.subarray(33, 65)),
  };
}

export interface P256Signature {
  readonly r: bigint;
  readonly s: bigint;
}

/** Parses 64-byte `r ‖ s`; `null` for wrong length, zero/out-of-range values, or high-s. */
export function parseP256Signature(signature: Hex): P256Signature | null {
  if (!isHexOfLength(signature, 64)) return null;
  const bytes = hexToBytes(signature);
  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  if (r === 0n || r >= P256_N) return null;
  if (s === 0n || s > P256_HALF_N) return null;
  return { r, s };
}

export function encodeP256Signature(signature: P256Signature): Hex {
  return bytesToHex(concat(u256be(signature.r), u256be(signature.s)));
}

/** Pure predicate: never throws; false on malformed input, off-curve key, or high-s. */
export function verifyP256(digest: Bytes32, signature: Hex, publicKey: P256PublicKey): boolean {
  if (!isHexOfLength(digest, 32)) return false;
  const parsed = parseP256Signature(signature);
  if (parsed === null) return false;
  if (!isHexOfLength(publicKey.x, 32) || !isHexOfLength(publicKey.y, 32)) return false;
  try {
    const pub = concat(new Uint8Array([0x04]), hexToBytes(publicKey.x), hexToBytes(publicKey.y));
    if (!p256.utils.isValidPublicKey(pub, false)) return false;
    return p256.verify(hexToBytes(signature), hexToBytes(digest), pub, {
      prehash: false,
      lowS: true,
      format: "compact",
    });
  } catch {
    return false;
  }
}
