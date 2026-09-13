import type { Address, Bytes32, Hex } from "@firsthand/core";

/**
 * Writes batch roots to PassportAnchors (README §7.1). `paged` targets the MIP-8 clustered layout,
 * `baseline` the plain-SSTORE deployment — the two H1 arms — and `memory` is the test double.
 */
export type AnchorLayout = "paged" | "baseline" | "memory";

export interface AnchorRequest {
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
  readonly batchRoot: Bytes32;
  readonly termsHash: Bytes32;
  readonly nonce: Bytes32;
  /** The 16 epoch deposit addresses whose hash was attested; `depositKeys[ns]` signed this anchor. */
  readonly depositKeys: readonly Address[];
  /** 65-byte secp256k1 signature over `AuthorityDigests.anchor(...)`. */
  readonly depositSig: Hex;
}

export interface AnchorRef {
  readonly batchRoot: Bytes32;
  readonly batchIndex: number;
  readonly blockNumber: bigint;
  readonly txHash: Bytes32 | null;
  /** Gas used, when the writer can observe it — feeds the H1 metric. */
  readonly gasUsed: bigint | null;
}

export interface AnchorWriter {
  readonly layout: AnchorLayout;
  anchor(request: AnchorRequest): Promise<AnchorRef>;
  isAnchored(batchRoot: Bytes32): Promise<boolean>;
  anchorBlock(batchRoot: Bytes32): Promise<bigint | null>;
}
