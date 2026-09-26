import { type Hex, TransportError, ValidationError } from "@firsthand/core";
import { blobId, refId } from "../memory/MemoryBlobStore.js";
import type { BlobRef, BlobStore } from "../ports/BlobStore.js";
import { rawKeccakCid } from "./cid.js";

export interface IpfsBlobStoreOptions {
  /** Kubo RPC API, e.g. http://127.0.0.1:5001 */
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  /** Per-request budget. A blob store must not be able to hang a served query. */
  readonly timeoutMs?: number;
}

/**
 * Ciphertext in IPFS, addressed by the same keccak id as every other backend (ADR-0007).
 *
 * The CID is not stored anywhere: blobs are added with `hash=keccak-256`, `cid-version=1` and a
 * chunker large enough to force a single raw leaf, so the CID's multihash *is* `keccak256(bytes)`
 * and `cid.ts` derives it from the id alone. That keeps the port's promise — "a ref is also an
 * integrity check" — without the store keeping an index it would have to keep consistent.
 *
 * Reads go through `block/get` with `offline=true` rather than `cat`. `cat` on a CID this node does
 * not hold will go looking for it on the DHT and block; a gateway serving a paid query cannot afford
 * that. Offline, a miss is a miss: measured at 0.02 s against Kubo 0.43.1, versus an open-ended wait.
 */
export class IpfsBlobStore implements BlobStore {
  readonly kind = "ipfs";
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: IpfsBlobStoreOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    // Bound: an unbound `fetch` called as a method throws "Illegal invocation" in a browser.
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  get apiUrl(): string {
    return this.#apiUrl;
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const id = blobId(bytes);
    // One chunk, so the root of the DAG is the raw leaf and its digest is the blob id.
    const chunk = Math.max(bytes.length, 1);
    const query = `hash=keccak-256&cid-version=1&raw-leaves=true&pin=true&chunker=size-${chunk}`;
    const body = new FormData();
    // A freshly allocated ArrayBuffer is a Blob part under every lib setting; a bare Uint8Array
    // needs the DOM lib, which this package deliberately does not pull in, and `bytes.buffer` is
    // typed `ArrayBufferLike` (it could be shared). Copying once makes the narrowing honest.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    body.append("file", new Blob([copy.buffer as ArrayBuffer]), id);
    const res = await this.#call(`add?${query}`, { method: "POST", body });
    const added = (await res.json()) as { Hash?: string; Size?: string };
    const expected = rawKeccakCid(id);
    if (added.Hash !== expected) {
      // The node hashed it differently — a build without keccak-256, or chunking we did not ask for.
      throw new ValidationError("IPFS returned a CID that is not this blob's keccak id", {
        context: { id, expected, got: added.Hash ?? null },
      });
    }
    return { id, size: bytes.length, locator: expected };
  }

  async get(ref: BlobRef | Hex): Promise<Uint8Array | null> {
    const id = refId(ref);
    const res = await this.#call(`block/get?arg=${rawKeccakCid(id)}&offline=true`, {
      method: "POST",
      allowMiss: true,
    });
    if (res === null) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The same check FsBlobStore makes: what came back must be what was asked for.
    if (blobId(bytes) !== id) {
      throw new ValidationError("blob integrity check failed", { context: { id } });
    }
    return bytes;
  }

  async has(ref: BlobRef | Hex): Promise<boolean> {
    const res = await this.#call(`block/stat?arg=${rawKeccakCid(refId(ref))}&offline=true`, {
      method: "POST",
      allowMiss: true,
    });
    return res !== null;
  }

  /** One place for the timeout, the error shape, and "a 4xx/5xx here means the node does not have it". */
  async #call(path: string, init: RequestInit & { allowMiss?: true }): Promise<Response>;
  async #call(path: string, init: RequestInit & { allowMiss: true }): Promise<Response | null>;
  async #call(path: string, init: RequestInit & { allowMiss?: true }): Promise<Response | null> {
    const { allowMiss, ...request } = init;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiUrl}/api/v0/${path}`, {
        ...request,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new TransportError("FH_TRANSPORT", `IPFS node unreachable at ${this.#apiUrl}`, {
        retryable: true,
        cause,
      });
    }
    if (res.ok) return res;
    if (allowMiss) return null;
    throw new TransportError("FH_TRANSPORT", `IPFS ${path.split("?")[0]} failed: ${res.status}`, {
      retryable: res.status >= 500,
      context: { status: res.status },
    });
  }
}
