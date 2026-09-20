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
  /**
   * Wall-clock budget for the scan. A log-backed ledger walks the window newest-first and stops
   * issuing requests once the budget is spent, so what comes back is the most recent history and
   * the report says how far back it reached — a hosted function has a hard deadline of its own.
   */
  readonly budgetMs?: number;
}

/** What a scan actually covered — the caller decides what to say about the rest. */
export interface LedgerScanReport {
  /** Oldest block the scan reached (≥ the requested `fromBlock` when the budget ran out). */
  readonly fromBlock: bigint;
  /** Chain head at scan time (memory: the newest recorded block). */
  readonly toBlock: bigint;
  /** True when the budget ended the scan before `fromBlock` was reached. */
  readonly partial: boolean;
}

export interface ConsentTimeline {
  readonly events: readonly ConsentEvent[];
  readonly scan: LedgerScanReport;
}

export interface ConsentLedger {
  receiptsForGrant(grantId: Bytes32, scan?: LedgerScan): Promise<readonly ReceiptView[]>;
  anchorsFor(principalId: Bytes32, ns: number, scan?: LedgerScan): Promise<readonly AnchorView[]>;
  consentTimeline(principalId: Bytes32, scan?: LedgerScan): Promise<readonly ConsentEvent[]>;
  /** `consentTimeline` plus the scan report — the audit route serves this one. */
  timeline(principalId: Bytes32, scan?: LedgerScan): Promise<ConsentTimeline>;
}
