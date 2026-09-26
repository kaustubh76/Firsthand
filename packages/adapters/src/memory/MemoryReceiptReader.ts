import type { Address, Bytes32 } from "@firsthand/core";
import type { ChainReceipt } from "../receipts/OnchainReceiptReader.js";
import { Recorder } from "./Recorder.js";

/**
 * A receipt ledger with nothing behind it — for proving that a manifest verifier actually asks.
 * `put` is what `RoyaltyRouter.settle` would have done; anything not put reads as null, which is how
 * a manifest claiming a read nobody paid for gets caught.
 */
export class MemoryReceiptReader extends Recorder {
  readonly receipts = new Map<Bytes32, ChainReceipt>();

  put(
    receiptId: Bytes32,
    input: {
      grantId: Bytes32;
      ns: number;
      blockNumber: bigint;
      payer?: Address;
      termsHash?: Bytes32;
      epoch?: bigint;
    },
  ): void {
    this.receipts.set(receiptId, {
      grantId: input.grantId,
      payer: input.payer ?? (`0x${"11".repeat(20)}` as Address),
      ns: input.ns,
      termsHash: input.termsHash ?? (`0x${"00".repeat(32)}` as Bytes32),
      blockNumber: input.blockNumber,
      epoch: input.epoch ?? 0n,
    });
  }

  async receipt(receiptId: Bytes32): Promise<ChainReceipt | null> {
    this.record("receipt", receiptId);
    return this.receipts.get(receiptId) ?? null;
  }
}
