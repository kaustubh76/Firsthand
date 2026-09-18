import { type Bytes32, keccak256Hex } from "@firsthand/core";

/** Without a published limit, assume the self-hosted default (8 MiB) with a clear margin. */
export const DEFAULT_MEDIA_BYTES = 6 * 1024 * 1024;
/** Sealing adds a header, a nonce and an AEAD tag; leave room for them under the gateway's cap. */
const SEAL_OVERHEAD = 4 * 1024;

/** The largest capture this gateway will take: its published limit minus the sealing overhead. */
export function mediaCap(maxUploadBytes: number | null): number {
  return maxUploadBytes === null
    ? DEFAULT_MEDIA_BYTES
    : Math.max(64 * 1024, maxUploadBytes - SEAL_OVERHEAD);
}

export interface MediaMeta {
  readonly mime: string;
  readonly size: number;
  readonly name: string;
}

/** Deterministic JSON with sorted keys — the JCS form the attestation's metaHash commits to. */
export function canonicalJson(value: Record<string, string | number>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

export function metaHashOf(meta: MediaMeta): Bytes32 {
  return keccak256Hex(new TextEncoder().encode(canonicalJson({ ...meta })));
}

export async function readMedia(
  file: File,
  cap: number = DEFAULT_MEDIA_BYTES,
): Promise<{ bytes: Uint8Array; meta: MediaMeta }> {
  if (file.size > cap) {
    throw new Error(
      `${file.name} is ${(file.size / 1_048_576).toFixed(1)} MiB; this gateway takes captures up to ${(cap / 1_048_576).toFixed(1)} MiB so the sealed blob fits`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    meta: { mime: file.type || "application/octet-stream", size: file.size, name: file.name },
  };
}
