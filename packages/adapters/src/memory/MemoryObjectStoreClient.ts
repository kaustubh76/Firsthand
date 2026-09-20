import type { ObjectStoreClient } from "../ports/ObjectStore.js";

/** A Map standing in for a hosted object store, so the durable adapters are testable offline. */
export class MemoryObjectStoreClient implements ObjectStoreClient {
  readonly kind = "memory-object";
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly #baseUrl: string;

  constructor(baseUrl = "memory://store") {
    this.#baseUrl = baseUrl;
  }

  async put(pathname: string, body: Uint8Array, contentType: string) {
    this.objects.set(pathname, { bytes: new Uint8Array(body), contentType });
    return { url: `${this.#baseUrl}/${pathname}` };
  }

  async get(pathname: string): Promise<Uint8Array | null> {
    const found = this.objects.get(pathname);
    return found ? new Uint8Array(found.bytes) : null;
  }

  async exists(pathname: string): Promise<boolean> {
    return this.objects.has(pathname);
  }

  async list(prefix: string, limit: number): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
  }
}
