import type { LineageManifest } from "@firsthand/core";
import { MERKLE_DEPTH } from "@firsthand/core";

/** H3 metric helpers: bytes and hashes a verifier must process per asset. */
export function proofBytesPerAsset(): number {
  return 1 + MERKLE_DEPTH * 32; // index byte + 8 siblings
}

export function manifestBytes(manifest: LineageManifest): number {
  return new TextEncoder().encode(
    JSON.stringify(manifest, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ).length;
}
