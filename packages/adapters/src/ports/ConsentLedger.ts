import type { Address, Bytes32 } from "@firsthand/core";

/** Read model over receipts, anchors and consent events — served by Envio (README §22) or memory. */
export interface ReceiptView {
  readonly receiptId: Bytes32;
  readonly grantId: Bytes32;
  readonly payer: Address;
  readonly ns: number;
  readonly termsHash: Bytes32;
  readonly epoch: bigint;
  readonly blockNumber: bigint;
  readonly txHash: Bytes32;
}

export interface AnchorView {
  readonly batchRoot: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
  readonly termsHash: Bytes32;
  readonly blockNumber: bigint;
  readonly batchIndex: number;
}

export type ConsentEventKind =
  | "enrolled"
  | "attested"
  | "granted"
  | "rescinded"
  | "frozen"
  | "expired";

export interface ConsentEvent {
  readonly kind: ConsentEventKind;
  readonly principalId: Bytes32;
  readonly grantId: Bytes32 | null;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly txHash: Bytes32 | null;
  /** `granted` only: who was granted, under which namespace and terms — so a viewer can act on it. */
  readonly granteeCard?: Bytes32;
  readonly ns?: number;
  readonly termsHash?: Bytes32;
}

/**
 * Per-call scan bounds. A log-backed ledger can only see a window of blocks per request (Monad's
 * public RPC caps `eth_getLogs` at 100 blocks); a caller that knows where its history starts — the
 * block its principal was enrolled in — passes it here instead of relying on the default lookback.
 */
export interface LedgerScan {
  readonly fromBlock?: bigint;
}

export interface ConsentLedger {
  receiptsForGrant(grantId: Bytes32, scan?: LedgerScan): Promise<readonly ReceiptView[]>;
  anchorsFor(principalId: Bytes32, ns: number, scan?: LedgerScan): Promise<readonly AnchorView[]>;
  consentTimeline(principalId: Bytes32, scan?: LedgerScan): Promise<readonly ConsentEvent[]>;
}
