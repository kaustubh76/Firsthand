import { bytesToBigInt, CryptoError } from "@firsthand/core";
import { KDF_LENGTH } from "./info.js";

/**
 * Maps 48 bytes of HKDF output to a private scalar in `[1, n-1]`:
 *
 *   d = (int_be(okm) mod (n - 1)) + 1
 *
 * (FIPS 186-5 A.2.1 "extra random bits" style). No rejection loop, no zero, negligible bias.
 */
export function scalarFromOkm(okm: Uint8Array, curveOrder: bigint): bigint {
  if (okm.length !== KDF_LENGTH.SCALAR) {
    throw new CryptoError(`scalarFromOkm: expected ${KDF_LENGTH.SCALAR} bytes`, {
      context: { length: okm.length },
    });
  }
  if (curveOrder <= 2n) throw new CryptoError("scalarFromOkm: invalid curve order");
  return (bytesToBigInt(okm) % (curveOrder - 1n)) + 1n;
}
