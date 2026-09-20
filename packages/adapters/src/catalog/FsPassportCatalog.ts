import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Bytes32,
  type PassportSidecar,
  parseSidecar,
  passportId,
  sidecarToWire,
  ValidationError,
} from "@firsthand/core";
import { LIST_LIMIT, type PassportCatalog } from "../ports/PassportCatalog.js";

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
    // The per-principal index: an empty marker per passport, so listing is a directory read.
    const index = this.indexDir(sidecar.principalId);
    await mkdir(index, { recursive: true });
    await writeFile(join(index, id), "");
  }

  async listByPrincipal(principalId: Bytes32, limit = LIST_LIMIT): Promise<Bytes32[]> {
    try {
      const names = await readdir(this.indexDir(principalId));
      return names.filter((n): n is Bytes32 => /^0x[0-9a-f]{64}$/.test(n)).slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private indexDir(principalId: Bytes32): string {
    if (!/^0x[0-9a-f]{64}$/.test(principalId)) {
      throw new ValidationError("principal id must be 32-byte hex");
    }
    return join(this.#root, "by-principal", principalId);
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
