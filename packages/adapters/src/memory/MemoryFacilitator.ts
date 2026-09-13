import { type Address, type Bytes32, bytesToHex, keccak256, utf8 } from "@firsthand/core";
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
 * maxAmountRequired` and the nonce is fresh. No signature check — that is the real facilitator's job.
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
    if (
      payload.scheme !== requirements.scheme ||
      payload.network !== requirements.network ||
      payload.network !== this.#network
    ) {
      return { isValid: false, invalidReason: "unsupported_scheme_or_network" };
    }
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { isValid: false, invalidReason: "wrong_pay_to" };
    }
    if (BigInt(auth.value) !== BigInt(requirements.maxAmountRequired)) {
      return { isValid: false, invalidReason: "wrong_amount" };
    }
    if (this.#settledNonces.has(auth.nonce.toLowerCase())) {
      return { isValid: false, invalidReason: "nonce_already_used" };
    }
    return { isValid: true, payer: auth.from.toLowerCase() as Address };
  }
}
