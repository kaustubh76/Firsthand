import type { PaymentRequirements, X402Facilitator } from "@firsthand/adapters";
import {
  type BatchProof,
  type Bytes32,
  NotImplementedError,
  type SignedPassport,
} from "@firsthand/core";

/**
 * `query` (README §7.2, §8 claim 4) — buyer side. Phase 3 wires the x402 handshake:
 * GET → 402 + requirements → sign EIP-3009 authorization → retry with X-PAYMENT → data + passport + proof.
 */
export interface QueryRequest {
  readonly gatewayUrl: string;
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
}

export interface QueryResult {
  readonly signed: SignedPassport;
  readonly batchRoot: Bytes32;
  readonly proof: BatchProof;
  /** Ciphertext; the grantee unwraps with the vault key from its grant wrap. */
  readonly blob: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly receiptId: Bytes32;
  readonly paid: { readonly requirements: PaymentRequirements; readonly transaction: Bytes32 };
}

export interface QueryDeps {
  readonly facilitator: X402Facilitator;
  readonly fetch?: typeof fetch;
}

export function query(_request: QueryRequest, _deps: QueryDeps): Promise<QueryResult> {
  return Promise.reject(new NotImplementedError("sdk.query (Phase 3)"));
}
