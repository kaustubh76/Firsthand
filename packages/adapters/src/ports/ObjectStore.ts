/**
 * The narrowest slice of a hosted object store the durable adapters need. Kept as a port so the
 * adapters package carries no vendor SDK: the gateway binds `@vercel/blob` to this shape, tests bind
 * a Map. Pathnames are opaque keys; the adapters derive them from content ids, never from user input.
 */
export interface ObjectStoreClient {
  readonly kind: string;
  /** Idempotent write: the same pathname overwritten with the same bytes is a no-op to readers. */
  put(pathname: string, body: Uint8Array, contentType: string): Promise<{ url: string }>;
  /** `null` when nothing is stored under the pathname. */
  get(pathname: string): Promise<Uint8Array | null>;
  /** Never throws; `false` on any failure to look up. */
  exists(pathname: string): Promise<boolean>;
}
