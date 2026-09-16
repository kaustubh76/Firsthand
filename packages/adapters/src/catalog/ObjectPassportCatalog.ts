import {
  type Bytes32,
  type PassportSidecar,
  parseSidecar,
  passportId,
  sidecarToWire,
  ValidationError,
} from "@firsthand/core";
import type { ObjectStoreClient } from "../ports/ObjectStore.js";
import type { PassportCatalog } from "../ports/PassportCatalog.js";

export interface ObjectPassportCatalogOptions {
  readonly client: ObjectStoreClient;
  readonly prefix?: string;
}

/** One JSON object per passport under `<prefix>/<first 2 hex>/<id>.json` — `FsPassportCatalog`'s layout, hosted. */
export class ObjectPassportCatalog implements PassportCatalog {
  readonly kind: string;
  readonly #client: ObjectStoreClient;
  readonly #prefix: string;

  constructor(options: ObjectPassportCatalogOptions) {
    this.#client = options.client;
    this.#prefix = (options.prefix ?? "passports").replace(/\/+$/, "");
    this.kind = options.client.kind;
  }

  async put(sidecar: PassportSidecar): Promise<void> {
    const id = passportId(sidecar.signed.passport);
    const body = new TextEncoder().encode(JSON.stringify(sidecarToWire(sidecar)));
    await this.#client.put(this.keyFor(id), body, "application/json");
  }

  async get(id: Bytes32): Promise<PassportSidecar | null> {
    const bytes = await this.#client.get(this.keyFor(id));
    if (bytes === null) return null;
    return parseSidecar(JSON.parse(new TextDecoder().decode(bytes)));
  }

  async has(id: Bytes32): Promise<boolean> {
    try {
      return await this.#client.exists(this.keyFor(id));
    } catch {
      return false;
    }
  }

  private keyFor(id: Bytes32): string {
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new ValidationError("passport id must be 32-byte hex");
    return `${this.#prefix}/${id.slice(2, 4)}/${id}.json`;
  }
}
