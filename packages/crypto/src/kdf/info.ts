import { concat, u32be, u64be, utf8 } from "@firsthand/core";

/**
 * Byte-exact HKDF `info` encodings (ADR-0005). Labels are NUL-terminated so that
 * `"ns" ‖ ns ‖ e` can never collide with `"dep" ‖ …` or any future label.
 *
 *   info_id    = "id"    ‖ 0x00
 *   info_ns    = "ns"    ‖ 0x00 ‖ u32be(ns) ‖ u64be(e)
 *   info_dep   = "dep"   ‖ 0x00 ‖ u32be(ns) ‖ u64be(e)
 *   info_nonce = "nonce" ‖ 0x00 ‖ u32be(ns) ‖ u64be(e)
 */
export const KDF_SALT: Uint8Array = utf8("FIRSTHAND/kdf/v1");

const NUL = new Uint8Array([0x00]);

export const KdfLabel = {
  ID: "id",
  NS: "ns",
  DEP: "dep",
  NONCE: "nonce",
} as const;
export type KdfLabel = (typeof KdfLabel)[keyof typeof KdfLabel];

export function infoId(): Uint8Array {
  return concat(utf8(KdfLabel.ID), NUL);
}

export function infoNs(ns: number, epoch: bigint): Uint8Array {
  return scoped(KdfLabel.NS, ns, epoch);
}

export function infoDep(ns: number, epoch: bigint): Uint8Array {
  return scoped(KdfLabel.DEP, ns, epoch);
}

export function infoNonce(ns: number, epoch: bigint): Uint8Array {
  return scoped(KdfLabel.NONCE, ns, epoch);
}

function scoped(label: KdfLabel, ns: number, epoch: bigint): Uint8Array {
  return concat(utf8(label), NUL, u32be(ns), u64be(epoch));
}

/** Output lengths per derived key. Scalars take 48 bytes to keep reduction bias ≤ 2^-128. */
export const KDF_LENGTH = {
  SCALAR: 48,
  SYMMETRIC: 32,
} as const;
