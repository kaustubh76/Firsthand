import { MockUSDCAbi } from "@firsthand/contracts/abi";
import { type Address, normalizeNetwork, sameNetwork } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";
import { recoverTypedDataAddress } from "viem";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";
import { assetDomainFrom, transferWithAuthorizationTypes } from "./typedData.js";

/**
 * The verifier FIRSTHAND owns — ADR-0006's empty fallback column, filled.
 *
 * `MemoryFacilitator` deliberately never checks a signature ("that is the real facilitator's job"),
 * which left the gateway gating paid queries on an unverified authorization and relying on
 * `RoyaltyRouter.settle` to revert. That is safe for money and wrong as a gate, and it made one
 * external endpoint a single point of failure. This checks everything an x402 "exact" verifier is
 * supposed to check, offline: the EIP-3009 signature against the asset's own EIP-712 domain, the
 * recipient, the amount, the validity window, and — when it is given a chain reader — that the
 * authorization has not already been used and that the payer can actually pay.
 *
 * It does not settle. Settlement is `RoyaltyRouter.settle`, because that is what writes the receipt
 * and splits the royalty (ADR-0014); `settle()` says so rather than pretending.
 */
export interface LocalFacilitatorOptions {
  /** The network this verifier answers for; either spelling (ADR-0014). */
  readonly network: string;
  /**
   * Optional chain reader for nonce reuse and balance — without it those two checks are skipped.
   * A thunk, because the gateway builds its verifier before its chain clients exist.
   */
  readonly publicClient?:
    | PublicClient<Transport, Chain>
    | (() => PublicClient<Transport, Chain> | null);
  readonly now?: () => bigint;
}

/** x402-style refusal reasons — the vocabulary a facilitator answers with. */
export type LocalInvalidReason =
  | "unsupported_scheme"
  | "unsupported_network"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_exact_evm_payload_value_mismatch"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_authorization_already_used"
  | "insufficient_funds"
  | "unexpected_verify_error";

const refuse = (invalidReason: LocalInvalidReason): VerifyResponse => ({
  isValid: false,
  invalidReason,
  verifiedBy: "local",
});

export class LocalFacilitator implements X402Facilitator {
  readonly #o: LocalFacilitatorOptions;

  constructor(options: LocalFacilitatorOptions) {
    this.#o = options;
  }

  async supported(): Promise<readonly SupportedKind[]> {
    const { caip2, legacy } = normalizeNetwork(this.#o.network);
    // Both spellings, so a v1 and a v2 client each find themselves in the list.
    return [
      { scheme: "exact", network: caip2, x402Version: 2 },
      { scheme: "exact", network: legacy, x402Version: 1 },
    ];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (payload.scheme !== "exact" || requirements.scheme !== "exact") {
      return refuse("unsupported_scheme");
    }
    if (!sameNetwork(payload.network, requirements.network)) return refuse("unsupported_network");
    if (!sameNetwork(requirements.network, this.#o.network)) return refuse("unsupported_network");

    const auth = payload.payload.authorization;
    const payer = auth.from.toLowerCase() as Address;
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return refuse("invalid_exact_evm_payload_recipient_mismatch");
    }
    if (BigInt(auth.value) !== BigInt(requirements.maxAmountRequired)) {
      return refuse("invalid_exact_evm_payload_value_mismatch");
    }
    const now = (this.#o.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
    if (BigInt(auth.validAfter) > now) {
      return refuse("invalid_exact_evm_payload_authorization_valid_after");
    }
    if (BigInt(auth.validBefore) <= now) {
      return refuse("invalid_exact_evm_payload_authorization_valid_before");
    }

    try {
      const domain = assetDomainFrom(requirements);
      const recovered = await recoverTypedDataAddress({
        domain,
        types: transferWithAuthorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          from: auth.from as Address,
          to: auth.to as Address,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce as `0x${string}`,
        },
        signature: payload.payload.signature as `0x${string}`,
      });
      if (recovered.toLowerCase() !== payer) {
        return refuse("invalid_exact_evm_payload_signature");
      }
    } catch {
      return refuse("invalid_exact_evm_payload_signature");
    }

    const client =
      typeof this.#o.publicClient === "function" ? this.#o.publicClient() : this.#o.publicClient;
    if (client) {
      const asset = requirements.asset.toLowerCase() as Address;
      try {
        // EIP-3009 nonces are per (authorizer, nonce) and consumed on use — the replay defence.
        const used = await client.readContract({
          address: asset,
          abi: MockUSDCAbi,
          functionName: "authorizationState",
          args: [payer, auth.nonce as `0x${string}`],
        });
        if (used === true) return refuse("invalid_exact_evm_payload_authorization_already_used");
        const balance = await client.readContract({
          address: asset,
          abi: MockUSDCAbi,
          functionName: "balanceOf",
          args: [payer],
        });
        if (BigInt(balance as bigint) < BigInt(auth.value)) return refuse("insufficient_funds");
      } catch {
        // A chain read that fails is not a refusal: the signature checks above already passed, and
        // settlement re-checks both on chain. Say so rather than inventing a verdict.
        return { isValid: true, payer, verifiedBy: "local" };
      }
    }
    return { isValid: true, payer, verifiedBy: "local" };
  }

  /** FIRSTHAND settles through `RoyaltyRouter.settle`; a verifier must not pretend to move money. */
  async settle(): Promise<SettleResponse> {
    return {
      success: false,
      network: normalizeNetwork(this.#o.network).caip2,
      errorReason:
        "settlement_not_supported: FIRSTHAND settles through RoyaltyRouter.settle, which writes the receipt and splits the royalty (ADR-0014)",
    };
  }
}
