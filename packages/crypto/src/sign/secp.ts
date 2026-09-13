import { assertBytes32, type Bytes32, bytesToHex, type Hex, hexToBytes } from "@firsthand/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { SecretBytes } from "../zeroize.js";

/**
 * "secp256k1 = machine labor": signs passport digests with the epoch deposit key.
 * Output is Ethereum-style 65-byte `r ‖ s ‖ v` (`v ∈ {27, 28}`), always low-s, deterministic
 * (RFC 6979) so re-signing the same passport yields the same bytes.
 */
export function signPassportDigest(privateKey: SecretBytes, digest: Bytes32): Hex {
  assertBytes32(digest, "digest");
  const recovered = privateKey.use((sk) =>
    secp256k1.sign(hexToBytes(digest), sk, { prehash: false, lowS: true, format: "recovered" }),
  );
  // noble's `recovered` layout is `rec ‖ r ‖ s`; Ethereum wants `r ‖ s ‖ v`.
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1, 65), 0);
  out[64] = 27 + (recovered[0] as number);
  return bytesToHex(out);
}
