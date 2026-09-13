import {
  type Address,
  type Bytes32,
  bytesToHex,
  concat,
  GrantError,
  GrantStatus,
  hashTerms,
  hexToBytes,
  keccak256,
  keccak256Utf8,
  PaymentError,
  split,
} from "@firsthand/core";
import type { ReceiptView } from "../ports/ConsentLedger.js";
import type { Settlement, SettleRequest, SettleResult } from "../ports/Settlement.js";
import type { MemoryConsentLedger } from "./MemoryConsentLedger.js";
import type { MemoryGrantReader } from "./MemoryGrantReader.js";
import { Recorder } from "./Recorder.js";

/**
 * Accounting double of RoyaltyRouter + ReceiptLedger: same checks (live grant, terms hash, value,
 * nonce uniqueness, rate limit), same split, receipts written to a MemoryConsentLedger. No token
 * moves; payouts are tallied for assertions.
 */
export class MemorySettlement extends Recorder implements Settlement {
  readonly kind = "memory";
  readonly payouts = new Map<Address, bigint>();
  readonly #usedNonces = new Set<string>();
  #dust = 0n;
  #block = 1n;

  constructor(
    private readonly grants: MemoryGrantReader,
    private readonly ledger: MemoryConsentLedger,
  ) {
    super();
  }

  get dust(): bigint {
    return this.#dust;
  }

  async settle(request: SettleRequest): Promise<SettleResult> {
    this.record("settle", request.grantId);
    const status = await this.grants.effectiveStatus(request.grantId);
    if (status !== GrantStatus.ACTIVE) {
      throw new GrantError(statusCode(status), `grant ${request.grantId} is not live (${status})`, {
        context: { grantId: request.grantId, status },
      });
    }
    const g = await this.grants.grantState(request.grantId);
    if (!g) throw new GrantError("FH_GRANT_NOT_LIVE", "unknown grant");
    const termsHash = hashTerms(request.terms);
    if (termsHash !== g.termsHash) {
      throw new PaymentError("FH_PAYMENT_INVALID", "terms do not match the grant", {
        context: { expected: g.termsHash, actual: termsHash },
      });
    }
    const auth = request.payment.payload.authorization;
    if (BigInt(auth.value) !== request.terms.price) {
      throw new PaymentError("FH_PAYMENT_INVALID", "authorization value differs from the price", {
        context: { expected: request.terms.price.toString(), actual: auth.value },
      });
    }
    const nonceKey = `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
    if (this.#usedNonces.has(nonceKey)) {
      throw new PaymentError("FH_PAYMENT_INVALID", "authorization already used", {
        context: { nonce: auth.nonce },
      });
    }
    const epoch = await this.grants.currentEpoch();
    const used = await this.grants.queriesThisEpoch(request.grantId, epoch);
    if (request.terms.rateLimit !== 0 && used >= request.terms.rateLimit) {
      throw new GrantError("FH_RATE_LIMITED", "rate limit exceeded for this epoch", {
        retryable: true,
        context: {
          grantId: request.grantId,
          epoch: epoch.toString(),
          limit: request.terms.rateLimit,
        },
      });
    }

    this.#usedNonces.add(nonceKey);
    const { pays, residual } = split(request.terms.price, request.terms.weights);
    pays.forEach((pay, i) => {
      const payee = request.terms.payees[i] as Address;
      this.payouts.set(payee, (this.payouts.get(payee) ?? 0n) + pay);
    });
    this.#dust += residual;
    this.grants.countQuery(request.grantId, epoch);

    const receiptId = receiptIdOf(request.grantId, auth.nonce as Bytes32);
    const payer = auth.from.toLowerCase() as Address;
    const txHash = keccak256Utf8(`memory-settle:${receiptId}`);
    const receipt: ReceiptView = {
      receiptId,
      grantId: request.grantId,
      payer,
      ns: request.terms.ns,
      termsHash,
      epoch,
      blockNumber: this.#block,
      txHash,
    };
    this.ledger.addReceipt(receipt);
    return { receiptId, payer, txHash, blockNumber: this.#block++, gasUsed: null };
  }
}

/** `keccak256(abi.encode(grantId, queryNonce))` — matches ReceiptLedger.receiptIdOf. */
export function receiptIdOf(grantId: Bytes32, queryNonce: Bytes32): Bytes32 {
  return bytesToHex(keccak256(concat(hexToBytes(grantId), hexToBytes(queryNonce))));
}

function statusCode(
  status: GrantStatus,
): "FH_GRANT_RESCINDED" | "FH_GRANT_EXPIRED" | "FH_GRANT_FROZEN" | "FH_GRANT_NOT_LIVE" {
  switch (status) {
    case GrantStatus.RESCINDED:
      return "FH_GRANT_RESCINDED";
    case GrantStatus.EXPIRED:
      return "FH_GRANT_EXPIRED";
    case GrantStatus.FROZEN:
      return "FH_GRANT_FROZEN";
    default:
      return "FH_GRANT_NOT_LIVE";
  }
}
