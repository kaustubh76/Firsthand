import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@firsthand/core";
import { blobId, refId } from "../memory/MemoryBlobStore.js";
import type { BlobRef, BlobStore } from "../ports/BlobStore.js";

/** Content-addressed files under a directory: `<root>/<first 2 hex>/<id>.bin`. */
export class FsBlobStore implements BlobStore {
  readonly kind = "fs";
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const id = blobId(bytes);
    const path = this.pathFor(id);
    await mkdir(join(this.#root, id.slice(2, 4)), { recursive: true });
    await writeFile(path, bytes, { flag: "w" });
    return { id, size: bytes.length, locator: path };
  }

  async get(ref: BlobRef | `0x${string}`): Promise<Uint8Array | null> {
    const id = refId(ref);
    try {
      const bytes = new Uint8Array(await readFile(this.pathFor(id)));
      if (blobId(bytes) !== id) {
        throw new ValidationError("blob integrity check failed", { context: { id } });
      }
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(ref: BlobRef | `0x${string}`): Promise<boolean> {
    try {
      await stat(this.pathFor(refId(ref)));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(id: `0x${string}`): string {
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new ValidationError("blob id must be 32-byte hex");
    return join(this.#root, id.slice(2, 4), `${id}.bin`);
  }
}
