import type { Bytes32 } from "@firsthand/core";
import type {
  AnchorView,
  ConsentEvent,
  ConsentLedger,
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

  async receiptsForGrant(grantId: Bytes32): Promise<readonly ReceiptView[]> {
    this.record("receiptsForGrant", grantId);
    return this.receipts.filter((r) => r.grantId === grantId);
  }

  async anchorsFor(principalId: Bytes32, ns: number): Promise<readonly AnchorView[]> {
    this.record("anchorsFor", principalId, ns);
    return this.anchors.filter(
      (a) => a.ns === ns && this.#anchorOwner.get(a.batchRoot) === principalId,
    );
  }

  async consentTimeline(principalId: Bytes32): Promise<readonly ConsentEvent[]> {
    this.record("consentTimeline", principalId);
    return this.events
      .filter((e) => e.principalId === principalId)
      .sort((a, b) => Number(a.blockNumber - b.blockNumber));
  }
}
