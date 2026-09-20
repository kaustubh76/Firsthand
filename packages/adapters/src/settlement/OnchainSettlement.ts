import {
  GrantManagerAbi,
  MockUSDCAbi,
  ReceiptLedgerAbi,
  RoyaltyRouterAbi,
  SplitMathAbi,
} from "@firsthand/contracts/abi";
import { type Address, type Bytes32, ChainError, GrantError, PaymentError } from "@firsthand/core";
import type { Chain, PublicClient, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { decodeRevert } from "../anchors/OnchainAnchorWriter.js";
import {
  type Settlement,
  type SettleRequest,
  type SettleResult,
  splitSignature,
} from "../ports/Settlement.js";
import { classifySendError, insufficientFundsError, sendWithNonceRetry } from "../tx/send.js";

export interface OnchainSettlementOptions {
  readonly router: Address;
  readonly receiptLedger: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Settlement relayer — pays gas, never a user key. */
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/** Calls RoyaltyRouter.settle with the buyer's EIP-3009 authorization; simulated first so refusals decode. */
export class OnchainSettlement implements Settlement {
  readonly kind = "onchain";
  readonly #o: OnchainSettlementOptions;

  constructor(options: OnchainSettlementOptions) {
    this.#o = options;
  }

  async settle(request: SettleRequest): Promise<SettleResult> {
    const auth = request.payment.payload.authorization;
    const { r, s, v } = splitSignature(request.payment.payload.signature as `0x${string}`);
    const terms = {
      price: request.terms.price,
      licenseId: request.terms.licenseId,
      scope: request.terms.scope,
      ns: request.terms.ns,
      rateLimit: request.terms.rateLimit,
      payees: [...request.terms.payees],
      weights: [...request.terms.weights],
    };
    const authorization = {
      from: auth.from as Address,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Bytes32,
      v,
      r,
      s,
    };
    const wallet = this.#o.walletClient;
    let simulated: Parameters<typeof wallet.writeContract>[0];
    try {
      const sim = await this.#o.publicClient.simulateContract({
        account: wallet.account,
        address: this.#o.router,
        abi: RoyaltyRouterAbi,
        functionName: "settle",
        args: [request.grantId, terms, authorization],
      });
      simulated = sim.request;
    } catch (cause) {
      throw decodeRevert(cause, "settlement refused", [
        ReceiptLedgerAbi,
        MockUSDCAbi,
        SplitMathAbi,
        GrantManagerAbi,
      ]);
    }
    try {
      const hash = await sendWithNonceRetry(() => wallet.writeContract(simulated), {
        account: wallet.account,
        chainId: wallet.chain.id,
      });
      const receipt = await this.#o.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new ChainError("settlement reverted", { context: { hash } });
      const receiptId = await this.#o.publicClient.readContract({
        address: this.#o.receiptLedger,
        abi: ReceiptLedgerAbi,
        functionName: "receiptIdOf",
        args: [request.grantId, authorization.nonce],
      });
      return {
        receiptId,
        payer: auth.from.toLowerCase() as Address,
        txHash: hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (cause) {
      if (cause instanceof ChainError) throw cause;
      if (classifySendError(cause).kind === "funds") {
        throw insufficientFundsError(
          `settlement: the relayer ${wallet.account.address} is out of gas — the operator must top it up`,
          wallet.account.address,
          cause,
        );
      }
      throw new ChainError("settlement failed", { cause, retryable: true });
    }
  }
}

/** Maps decoded contract refusals onto the FIRSTHAND error codes the memory double raises. */
export function toSettlementError(error: ChainError): ChainError | GrantError | PaymentError {
  const reason = String(error.context["reason"] ?? "");
  const context = { ...error.context };
  switch (reason) {
    case "RateLimitExceeded":
      return new GrantError("FH_RATE_LIMITED", "rate limit exceeded for this epoch", {
        retryable: true,
        context,
        cause: error,
      });
    case "GrantNotLive":
      return new GrantError("FH_GRANT_NOT_LIVE", "grant is not live", { context, cause: error });
    case "TermsMismatch":
    case "ValueMismatch":
    case "InvalidSignature":
    case "AuthorizationExpired":
    case "AuthorizationNotYetValid":
    case "AuthorizationAlreadyUsed":
    case "InsufficientBalance":
    case "DuplicateReceipt":
      return new PaymentError("FH_PAYMENT_INVALID", `payment rejected: ${reason}`, {
        context,
        cause: error,
      });
    default:
      return error;
  }
}
