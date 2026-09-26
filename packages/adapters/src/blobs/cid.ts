import { ValidationError } from "@firsthand/core";

/**
 * The one trick that makes IPFS storage usable behind a keccak-addressed port.
 *
 * `BlobStore` addresses content by `keccak256(bytes)` (ADR-0007), while IPFS addresses it by CID.
 * Normally that needs a side index — and an index is state the store would have to keep, which is
 * exactly what a content-addressed store is supposed to avoid. It does not, because keccak-256 is a
 * registered multihash (code `0x1b`): ask Kubo to add with `hash=keccak-256`, `cid-version=1` and a
 * single raw leaf, and the CID's digest *is* the blob id. So the CID is derivable from the id alone,
 * in both directions, with nothing stored in between.
 *
 * Measured against Kubo 0.43.1: `hello firsthand ipfs` →
 * `bafkrwiabcloyee5du32bpjhd2xocwvqs3my2nmouyhvbxxo2egxt5bb6ca`, which decodes to
 * `01 55 1b 20 ‖ 0x0112dd…3e10`, the keccak256 of those bytes.
 */
const CID_V1 = 0x01;
const CODEC_RAW = 0x55;
const MULTIHASH_KECCAK_256 = 0x1b;
const DIGEST_LENGTH = 32;

/** RFC 4648 base32, lower case, unpadded — multibase prefix `b`. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The CIDv1 a keccak-addressed blob has in IPFS: `b` + base32(01 55 1b 20 ‖ digest). */
export function rawKeccakCid(id: `0x${string}`): string {
  if (!/^0x[0-9a-f]{64}$/.test(id)) {
    throw new ValidationError("blob id must be 32-byte lower-case hex", { context: { id } });
  }
  const digest = new Uint8Array(DIGEST_LENGTH);
  for (let i = 0; i < DIGEST_LENGTH; i++) {
    digest[i] = Number.parseInt(id.slice(2 + i * 2, 4 + i * 2), 16);
  }
  const bytes = new Uint8Array(4 + DIGEST_LENGTH);
  bytes.set([CID_V1, CODEC_RAW, MULTIHASH_KECCAK_256, DIGEST_LENGTH]);
  bytes.set(digest, 4);
  return `b${base32Lower(bytes)}`;
}
