import { type Bytes32, bytesToHex } from "@firsthand/core";
import { randomBytes } from "@noble/hashes/utils.js";

/** CSPRNG helpers so downstream packages never import @noble directly. */
export function randomBytes32(): Bytes32 {
  return bytesToHex(randomBytes(32));
}

export function randomNonce(): Bytes32 {
  return randomBytes32();
}
