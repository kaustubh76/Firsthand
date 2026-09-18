import type { Bytes32 } from "@firsthand/core";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
  LedgerScan,
  ReceiptView,
} from "../ports/ConsentLedger.js";
import { Recorder } from "./Recorder.js";

export class MemoryConsentLedger extends Recorder implements ConsentLedger {
  readonly receipts: ReceiptView[] = [];
  readonly anchors: AnchorView[] = [];
  readonly events: ConsentEvent[] = [];
  readonly #anchorOwner = new Map<Bytes32, Bytes32>();

  addReceipt(r: ReceiptView): void {
    this.receipts.push(r);
  }

  addAnchor(principalId: Bytes32, a: AnchorView): void {
    this.anchors.push(a);
    this.#anchorOwner.set(a.batchRoot, principalId);
  }

  addEvent(e: ConsentEvent): void {
    this.events.push(e);
  }

  /** The memory double honours the same scan bound the log-backed ledger does. */
  #since<T extends { blockNumber: bigint }>(rows: readonly T[], scan?: LedgerScan): T[] {
    const from = scan?.fromBlock;
    return rows.filter((r) => from === undefined || r.blockNumber >= from);
  }

  async receiptsForGrant(grantId: Bytes32, scan?: LedgerScan): Promise<readonly ReceiptView[]> {
    this.record("receiptsForGrant", grantId);
    return this.#since(
      this.receipts.filter((r) => r.grantId === grantId),
      scan,
    );
  }

  async anchorsFor(
    principalId: Bytes32,
    ns: number,
    scan?: LedgerScan,
  ): Promise<readonly AnchorView[]> {
    this.record("anchorsFor", principalId, ns);
    return this.#since(
      this.anchors.filter((a) => a.ns === ns && this.#anchorOwner.get(a.batchRoot) === principalId),
      scan,
    );
  }

  async consentTimeline(principalId: Bytes32, scan?: LedgerScan): Promise<readonly ConsentEvent[]> {
    this.record("consentTimeline", principalId);
    return this.#since(
      this.events.filter((e) => e.principalId === principalId),
      scan,
    ).sort((a, b) => Number(a.blockNumber - b.blockNumber));
  }
}
