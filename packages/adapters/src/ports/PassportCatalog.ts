import type { Bytes32, PassportSidecar } from "@firsthand/core";

/** Public sidecars a gateway hosts. Ingest is verified by the gateway before `put` (ADR-0011). */
export interface PassportCatalog {
  readonly kind: string;
  put(sidecar: PassportSidecar): Promise<void>;
  get(passportId: Bytes32): Promise<PassportSidecar | null>;
  has(passportId: Bytes32): Promise<boolean>;
  /**
   * What a principal has published — how a buyer discovers supply without being handed ids.
   * Ids only (the sidecar is one `get` away); at most `limit` (default 500), no ordering promised.
   */
  listByPrincipal(principalId: Bytes32, limit?: number): Promise<Bytes32[]>;
}

/** The catalog's per-principal index lives beside the sidecars in every backend. */
export const LIST_LIMIT = 500;
