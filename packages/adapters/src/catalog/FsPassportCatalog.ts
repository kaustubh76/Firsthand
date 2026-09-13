import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Bytes32,
  type PassportSidecar,
  parseSidecar,
  passportId,
  sidecarToWire,
  ValidationError,
} from "@firsthand/core";
import type { PassportCatalog } from "../ports/PassportCatalog.js";

/** One JSON file per passport under `<root>/<first 2 hex>/<id>.json`. */
export class FsPassportCatalog implements PassportCatalog {
  readonly kind = "fs";
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(sidecar: PassportSidecar): Promise<void> {
    const id = passportId(sidecar.signed.passport);
    await mkdir(join(this.#root, id.slice(2, 4)), { recursive: true });
    await writeFile(this.pathFor(id), JSON.stringify(sidecarToWire(sidecar), null, 2));
  }

  async get(id: Bytes32): Promise<PassportSidecar | null> {
    try {
      const text = await readFile(this.pathFor(id), "utf8");
      return parseSidecar(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(id: Bytes32): Promise<boolean> {
    try {
      await stat(this.pathFor(id));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(id: Bytes32): string {
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new ValidationError("passport id must be 32-byte hex");
    return join(this.#root, id.slice(2, 4), `${id}.json`);
  }
}
