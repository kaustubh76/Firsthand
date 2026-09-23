import { TransportError } from "@firsthand/core";
import { type Logger, noopLogger } from "@firsthand/runtime";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifiedBy,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";

/**
 * Monad's facilitator first, FIRSTHAND's own verifier when it cannot answer.
 *
 * The distinction that matters: a facilitator can refuse because it *will not* handle this kind of
 * payment (an asset or network it does not know) or because the payment is *bad* (a forged
 * signature, a wrong amount). Falling back on the first is resilience; falling back on the second
 * would be a bypass dressed up as one. Only capability refusals — and transport failures — reach
 * the fallback; a verdict on the payment itself is final wherever it came from.
 */
export interface FallbackFacilitatorOptions {
  readonly primary: X402Facilitator;
  readonly fallback: X402Facilitator;
  readonly logger?: Logger;
  /**
   * Refusal reasons that mean "not my kind of payment". Configurable because the facilitator's
   * vocabulary is not specified anywhere and may grow (`X402_FALLBACK_REASONS`).
   */
  readonly capabilityReasons?: readonly string[];
  readonly onDecision?: (verifiedBy: VerifiedBy) => void;
}

/** Substrings of an `invalidReason` that mean the facilitator declined the *kind*, not the payment. */
export const CAPABILITY_REASONS: readonly string[] = [
  "unsupported_scheme",
  "unsupported_network",
  "unsupported_asset",
  "unknown_asset",
  "invalid_scheme",
  "invalid_network",
  "unsupported",
  "not_supported",
];

export class FallbackFacilitator implements X402Facilitator {
  readonly #o: FallbackFacilitatorOptions;
  readonly #reasons: readonly string[];
  #lastVerifiedBy: VerifiedBy | null = null;

  constructor(options: FallbackFacilitatorOptions) {
    this.#o = options;
    this.#reasons = options.capabilityReasons ?? CAPABILITY_REASONS;
  }

  /** Which verifier answered last — the gateway publishes it rather than claiming one. */
  get lastVerifiedBy(): VerifiedBy | null {
    return this.#lastVerifiedBy;
  }

  async supported(): Promise<readonly SupportedKind[]> {
    try {
      return await this.#o.primary.supported();
    } catch {
      return this.#o.fallback.supported();
    }
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const logger = this.#o.logger ?? noopLogger;
    try {
      const verdict = await this.#o.primary.verify(payload, requirements);
      if (verdict.isValid || !this.#isCapabilityRefusal(verdict.invalidReason)) {
        return this.#record(verdict, verdict.verifiedBy ?? "monad");
      }
      logger.warn("facilitator declined this kind of payment; verifying locally", {
        invalidReason: verdict.invalidReason,
        asset: requirements.asset,
        network: requirements.network,
      });
    } catch (cause) {
      if (!(cause instanceof TransportError)) throw cause;
      logger.warn("facilitator unreachable; verifying locally", { error: cause.message });
    }
    const verdict = await this.#o.fallback.verify(payload, requirements);
    return this.#record(verdict, verdict.verifiedBy ?? "local");
  }

  /** Settlement never goes to the facilitator (ADR-0014); this exists so the port is honoured. */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.#o.fallback.settle(payload, requirements);
  }

  #isCapabilityRefusal(reason: string | undefined): boolean {
    if (!reason) return false;
    const lower = reason.toLowerCase();
    return this.#reasons.some((r) => lower.includes(r.toLowerCase()));
  }

  #record(verdict: VerifyResponse, verifiedBy: VerifiedBy): VerifyResponse {
    this.#lastVerifiedBy = verifiedBy;
    this.#o.onDecision?.(verifiedBy);
    return { ...verdict, verifiedBy };
  }
}
