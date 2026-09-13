import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { type Bytes32, bytesToHex, utf8 } from "./bytes.js";

/** keccak-256 over raw bytes (the EVM hash). */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccak256Hex(data: Uint8Array): Bytes32 {
  return bytesToHex(keccak_256(data));
}

/** keccak-256 of a UTF-8 string — used for type hashes and string identifiers. */
export function keccak256Utf8(text: string): Bytes32 {
  return keccak256Hex(utf8(text));
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}
