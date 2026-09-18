import { type Bytes32, keccak256Hex } from "@firsthand/core";

/** Ciphertext must fit the gateway's 8 MiB upload cap with AEAD overhead; keep a clear margin. */
export const MAX_MEDIA_BYTES = 6 * 1024 * 1024;

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

export async function readMedia(file: File): Promise<{ bytes: Uint8Array; meta: MediaMeta }> {
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1_048_576).toFixed(1)} MiB; captures are capped at ${MAX_MEDIA_BYTES / 1_048_576} MiB so the sealed blob fits the gateway`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    meta: { mime: file.type || "application/octet-stream", size: file.size, name: file.name },
  };
}
