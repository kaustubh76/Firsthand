import { bytesToHex, keccak256 } from "@firsthand/core";
import type { BlobRef, BlobStore } from "../ports/BlobStore.js";
import { Recorder } from "./Recorder.js";

export function blobId(bytes: Uint8Array): `0x${string}` {
  return bytesToHex(keccak256(bytes));
}

export function refId(ref: BlobRef | `0x${string}`): `0x${string}` {
  return typeof ref === "string" ? ref : ref.id;
}

export class MemoryBlobStore extends Recorder implements BlobStore {
  readonly kind = "memory";
  readonly #blobs = new Map<`0x${string}`, Uint8Array>();

  async put(bytes: Uint8Array): Promise<BlobRef> {
    this.record("put", bytes.length);
    const id = blobId(bytes);
    this.#blobs.set(id, new Uint8Array(bytes));
    return { id, size: bytes.length };
  }

  async get(ref: BlobRef | `0x${string}`): Promise<Uint8Array | null> {
    this.record("get", refId(ref));
    const found = this.#blobs.get(refId(ref));
    return found ? new Uint8Array(found) : null;
  }

  async has(ref: BlobRef | `0x${string}`): Promise<boolean> {
    this.record("has", refId(ref));
    return this.#blobs.has(refId(ref));
  }

  get size(): number {
    return this.#blobs.size;
  }
}
