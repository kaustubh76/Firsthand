import {
  assertBytes32,
  type Bytes32,
  bytesToBigInt,
  encodeP256Signature,
  type Hex,
  hexToBytes,
  P256_N,
} from "@firsthand/core";
import { p256 } from "@noble/curves/nist.js";
import type { SecretBytes } from "../zeroize.js";

const HALF_N = P256_N >> 1n;

/**
 * "P256 = human authority": signs enroll / attest / grant / rescind digests with the derived
 * authority scalar. Output is 64-byte `r ‖ s`, low-s, deterministic — exactly the layout the
 * RIP-7212 precompile consumes after `hash` and before `x ‖ y`.
 */
export function signAuthorityDigest(scalar: SecretBytes, digest: Bytes32): Hex {
  assertBytes32(digest, "digest");
  const compact = scalar.use((sk) =>
    p256.sign(hexToBytes(digest), sk, { prehash: false, lowS: true, format: "compact" }),
  );
  const r = bytesToBigInt(compact.subarray(0, 32));
  let s = bytesToBigInt(compact.subarray(32, 64));
  // Belt and braces: noble honours lowS, but the precompile does not enforce it, so we do.
  if (s > HALF_N) s = P256_N - s;
  return encodeP256Signature({ r, s });
}
