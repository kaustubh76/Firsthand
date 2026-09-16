import { ValidationError } from "@firsthand/core";
import { blobId, refId } from "../memory/MemoryBlobStore.js";
import type { BlobRef, BlobStore } from "../ports/BlobStore.js";
import type { ObjectStoreClient } from "../ports/ObjectStore.js";

export interface ObjectBlobStoreOptions {
  readonly client: ObjectStoreClient;
  /** Key prefix inside the store, so one store can host several gateways. */
  readonly prefix?: string;
}

/**
 * Content-addressed blobs in a hosted object store: `<prefix>/<first 2 hex>/<id>.bin`, the same
 * layout as `FsBlobStore` so an operator can migrate by copying files. Reads re-hash, because the
 * store is outside the trust boundary and the ref is the integrity check (ports/BlobStore.ts).
 */
export class ObjectBlobStore implements BlobStore {
  readonly kind: string;
  readonly #client: ObjectStoreClient;
  readonly #prefix: string;

  constructor(options: ObjectBlobStoreOptions) {
    this.#client = options.client;
    this.#prefix = (options.prefix ?? "blobs").replace(/\/+$/, "");
    this.kind = options.client.kind;
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const id = blobId(bytes);
    const { url } = await this.#client.put(this.keyFor(id), bytes, "application/octet-stream");
    return { id, size: bytes.length, locator: url };
  }

  async get(ref: BlobRef | `0x${string}`): Promise<Uint8Array | null> {
    const id = refId(ref);
    const bytes = await this.#client.get(this.keyFor(id));
    if (bytes === null) return null;
    if (blobId(bytes) !== id) {
      throw new ValidationError("blob integrity check failed", { context: { id } });
    }
    return bytes;
  }

  async has(ref: BlobRef | `0x${string}`): Promise<boolean> {
    try {
      return await this.#client.exists(this.keyFor(refId(ref)));
    } catch {
      return false;
    }
  }

  private keyFor(id: `0x${string}`): string {
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new ValidationError("blob id must be 32-byte hex");
    return `${this.#prefix}/${id.slice(2, 4)}/${id}.bin`;
  }
}
