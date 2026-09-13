/**
 * Where sealed envelopes live (README §7.1: "Individual passports live with the encrypted blobs").
 * Content-addressed by keccak256 so a ref is also an integrity check. The store only ever sees
 * ciphertext — plaintext never leaves @firsthand/crypto's callers.
 */
export interface BlobRef {
  /** `keccak256(bytes)` as hex — stable across every backend. */
  readonly id: `0x${string}`;
  readonly size: number;
  /** Backend-specific locator (path, CID, URL) when one exists. */
  readonly locator?: string;
}

export interface BlobStore {
  readonly kind: string;
  put(bytes: Uint8Array): Promise<BlobRef>;
  get(ref: BlobRef | `0x${string}`): Promise<Uint8Array | null>;
  has(ref: BlobRef | `0x${string}`): Promise<boolean>;
}
