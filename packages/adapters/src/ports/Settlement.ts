import type { Address, Bytes32, Hex, Terms } from "@firsthand/core";
import type { PaymentPayload } from "./X402Facilitator.js";

/** What the router needs: the grant, the terms preimage, and the buyer's signed EIP-3009 authorization. */
export interface SettleRequest {
  readonly grantId: Bytes32;
  readonly terms: Terms;
  readonly payment: PaymentPayload;
}

export interface SettleResult {
  readonly receiptId: Bytes32;
  readonly payer: Address;
  readonly txHash: Bytes32 | null;
  readonly blockNumber: bigint | null;
  readonly gasUsed: bigint | null;
}

/** Settlement path (RoyaltyRouter.settle on chain; an accounting double in memory). */
export interface Settlement {
  readonly kind: string;
  settle(request: SettleRequest): Promise<SettleResult>;
}

/** Splits a 65-byte `r ‖ s ‖ v` signature into the tuple EIP-3009 takes. */
export function splitSignature(signature: Hex): { r: Bytes32; s: Bytes32; v: number } {
  const body = signature.slice(2);
  return {
    r: `0x${body.slice(0, 64)}` as Bytes32,
    s: `0x${body.slice(64, 128)}` as Bytes32,
    v: Number.parseInt(body.slice(128, 130), 16),
  };
}
