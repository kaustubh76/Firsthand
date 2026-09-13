import type { Bytes32, PassportSidecar } from "@firsthand/core";
import { passportId } from "@firsthand/core";
import type { PassportCatalog } from "../ports/PassportCatalog.js";
import { Recorder } from "./Recorder.js";

export class MemoryPassportCatalog extends Recorder implements PassportCatalog {
  readonly kind = "memory";
  readonly #items = new Map<Bytes32, PassportSidecar>();

  async put(sidecar: PassportSidecar): Promise<void> {
    this.record("put", sidecar.batchRoot);
    this.#items.set(passportId(sidecar.signed.passport), sidecar);
  }

  async get(id: Bytes32): Promise<PassportSidecar | null> {
    this.record("get", id);
    return this.#items.get(id) ?? null;
  }

  async has(id: Bytes32): Promise<boolean> {
    this.record("has", id);
    return this.#items.has(id);
  }

  get size(): number {
    return this.#items.size;
  }
}
