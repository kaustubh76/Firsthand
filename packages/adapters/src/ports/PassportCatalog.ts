import type { Bytes32, PassportSidecar } from "@firsthand/core";

/** Public sidecars a gateway hosts. Ingest is verified by the gateway before `put` (ADR-0011). */
export interface PassportCatalog {
  readonly kind: string;
  put(sidecar: PassportSidecar): Promise<void>;
  get(passportId: Bytes32): Promise<PassportSidecar | null>;
  has(passportId: Bytes32): Promise<boolean>;
}
