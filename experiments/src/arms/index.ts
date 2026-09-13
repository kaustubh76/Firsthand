import {
  type AnchorWriter,
  MemoryAnchorWriter,
  MemoryTransport,
  type TxTransport,
} from "@firsthand/adapters";

/**
 * Arms are adapter selections (ADR-0006): same code, different port implementations.
 *
 *   B1 naive-acl        — no passports at all (baseline for verification cost; simulated)
 *   B2 public-mempool   — rescission over the public mempool (observer can race)
 *   btx                 — rescission over Monad's encrypted mempool
 *   commit-reveal       — rescission via Rescissions.commit + reveal
 *   baseline / paged    — PassportAnchors storage layouts (H1)
 */
export const Arms = {
  B1_NAIVE_ACL: "B1-naive-acl",
  B2_PUBLIC_MEMPOOL: "B2-public-mempool",
  BTX: "btx",
  COMMIT_REVEAL: "commit-reveal",
  ANCHORS_BASELINE: "anchors-baseline",
  ANCHORS_PAGED: "anchors-paged",
  MEMORY: "memory",
} as const;
export type Arm = (typeof Arms)[keyof typeof Arms];

export interface ArmAdapters {
  readonly anchors: AnchorWriter;
  readonly transport: TxTransport;
  readonly onChain: boolean;
}

/** Memory-backed arms available today; on-chain arms are built from a deployment file in Phase 2/4. */
export function memoryArm(arm: Arm): ArmAdapters {
  return {
    anchors: new MemoryAnchorWriter(),
    transport: new MemoryTransport({ encryptedMempool: arm === Arms.BTX }),
    onChain: false,
  };
}
