import { type Hex, NotImplementedError } from "@firsthand/core";
import type { BlobRef, BlobStore } from "../ports/BlobStore.js";

export interface IpfsBlobStoreOptions {
  /** Kubo RPC API, e.g. http://127.0.0.1:5001 */
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
}

/** Typed shell for IPFS-hosted blobs (Phase 5). `locator` will carry the CID; `id` stays keccak-based. */
export class IpfsBlobStore implements BlobStore {
  readonly kind = "ipfs";
  readonly #apiUrl: string;

  constructor(options: IpfsBlobStoreOptions) {
    this.#apiUrl = options.apiUrl;
  }

  get apiUrl(): string {
    return this.#apiUrl;
  }

  put(_bytes: Uint8Array): Promise<BlobRef> {
    return Promise.reject(new NotImplementedError("IpfsBlobStore.put"));
  }

  get(_ref: BlobRef | Hex): Promise<Uint8Array | null> {
    return Promise.reject(new NotImplementedError("IpfsBlobStore.get"));
  }

  has(_ref: BlobRef | Hex): Promise<boolean> {
    return Promise.reject(new NotImplementedError("IpfsBlobStore.has"));
  }
}
