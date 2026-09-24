import {
  type Address,
  type Bytes32,
  bytesToHex,
  keccak256,
  sameNetwork,
  utf8,
} from "@firsthand/core";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";
import { Recorder } from "./Recorder.js";

export interface MemoryFacilitatorOptions {
  readonly network?: string;
}

/**
 * Facilitator double: accepts a payload when scheme/network match, `to == payTo`, `value ==
 * maxAmountRequired` and the nonce is fresh.
 *
 * **It does not check the signature.** That is deliberate — it is a double, not a verifier — but it
 * means this must never face the public: a gateway running it accepts a forged authorization and
 * only finds out when `RoyaltyRouter.settle` reverts. `LocalFacilitator` is the one that actually
 * checks, with no third party involved; use it anywhere real (ADR-0014).
 */
export class MemoryFacilitator extends Recorder implements X402Facilitator {
  readonly #network: string;
  readonly #settledNonces = new Set<string>();
  readonly settlements: SettleResponse[] = [];

  constructor(options: MemoryFacilitatorOptions = {}) {
    super();
    this.#network = options.network ?? "monad-testnet";
  }

  async supported(): Promise<readonly SupportedKind[]> {
    this.record("supported");
    return [{ scheme: "exact", network: this.#network }];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.record("verify", payload, requirements);
    return this.check(payload, requirements);
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.record("settle", payload, requirements);
    const verdict = this.check(payload, requirements);
    if (!verdict.isValid) {
      const failed: SettleResponse = {
        success: false,
        network: this.#network,
        errorReason: verdict.invalidReason ?? "invalid",
      };
      this.settlements.push(failed);
      return failed;
    }
    const nonce = payload.payload.authorization.nonce.toLowerCase();
    this.#settledNonces.add(nonce);
    const tx: Bytes32 = bytesToHex(keccak256(utf8(`memory-settle:${nonce}`)));
    const ok: SettleResponse = {
      success: true,
      network: this.#network,
      transaction: tx,
      payer: verdict.payer as Address,
    };
    this.settlements.push(ok);
    return ok;
  }

  private check(payload: PaymentPayload, requirements: PaymentRequirements): VerifyResponse {
    const auth = payload.payload.authorization;
    // `sameNetwork`, not string equality: an x402 v2 buyer says `eip155:10143` where a v1 gateway
    // says `monad-testnet`, and the two implementations of this port must agree about what a
    // network *is* or the double refuses what the real verifier accepts.
    if (
      payload.scheme !== requirements.scheme ||
      !sameNetwork(payload.network, requirements.network) ||
      !sameNetwork(payload.network, this.#network)
    ) {
      return {
        isValid: false,
        invalidReason: "unsupported_scheme_or_network",
        verifiedBy: "memory",
      };
    }
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { isValid: false, invalidReason: "wrong_pay_to", verifiedBy: "memory" };
    }
    if (BigInt(auth.value) !== BigInt(requirements.maxAmountRequired)) {
      return { isValid: false, invalidReason: "wrong_amount", verifiedBy: "memory" };
    }
    if (this.#settledNonces.has(auth.nonce.toLowerCase())) {
      return { isValid: false, invalidReason: "nonce_already_used", verifiedBy: "memory" };
    }
    return { isValid: true, payer: auth.from.toLowerCase() as Address, verifiedBy: "memory" };
  }
}
