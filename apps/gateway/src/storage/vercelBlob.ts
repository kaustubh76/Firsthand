import type { ObjectStoreClient } from "@firsthand/adapters";
import { BlobNotFoundError, get, head, list, put } from "@vercel/blob";

export interface VercelBlobClientOptions {
  readonly token: string;
}

/**
 * Binds Vercel Blob to the adapters' object-store port. Objects are public: the gateway only ever
 * stores ciphertext and signed public sidecars, which `/v1/blobs` and `/v1/passports` serve to
 * anyone regardless. Pathnames are fixed (no random suffix) so writes are idempotent per content id.
 */
export function createVercelBlobClient(options: VercelBlobClientOptions): ObjectStoreClient {
  const token = options.token;
  return {
    kind: "vercel-blob",
    async put(pathname, body, contentType) {
      const result = await put(pathname, Buffer.from(body), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        token,
      });
      return { url: result.url };
    },
    async get(pathname) {
      // Bypass the CDN: an overwrite must never be served from a stale copy.
      const result = await get(pathname, { access: "public", useCache: false, token });
      if (result === null || result.stream === null) return null;
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
    },
    async exists(pathname) {
      try {
        await head(pathname, { token });
        return true;
      } catch (error) {
        if (error instanceof BlobNotFoundError) return false;
        throw error;
      }
    },
    async list(prefix, limit) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({
          prefix,
          limit: Math.min(1000, limit - out.length),
          token,
          ...(cursor ? { cursor } : {}),
        });
        for (const b of page.blobs) out.push(b.pathname);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor && out.length < limit);
      return out.slice(0, limit);
    },
  };
}
