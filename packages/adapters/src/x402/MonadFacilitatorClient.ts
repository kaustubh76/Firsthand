import { type Address, PaymentError, sameNetwork, TransportError } from "@firsthand/core";
import { type Logger, noopLogger, withRetry } from "@firsthand/runtime";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";
import {
  FACILITATOR_ENVELOPES,
  type FacilitatorEnvelope,
  FacilitatorSettleSchema,
  FacilitatorSupportedSchema,
  FacilitatorVerifySchema,
  facilitatorBody,
} from "./wire.js";

/** Monad's native x402 facilitator, testnet and mainnet (probed 2026-09-23). */
export const MONAD_FACILITATOR_URL = "https://x402-facilitator.molandak.org";

/**
 * Which request envelope Monad's facilitator actually accepts.
 *
 * The x402 specification keeps v1's `{paymentPayload, paymentRequirements}` field names; Monad's
 * own guide shows `{payload, resource, accepted}`. Asked directly (see
 * `test/testnet/x402-facilitator.interop.test.ts`), the spec envelope comes back
 * `unsupported_scheme` and the guide's envelope is understood — it reads the asset and checks the
 * payer's balance on chain. So the default is the measured one, not the documented one.
 */
export const MONAD_FACILITATOR_ENVELOPE: FacilitatorEnvelope = "monad-doc";

/** A 4xx body that carries a verdict rather than a complaint about the request. */
function asVerdict(text: string): unknown | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return "isValid" in body || "success" in body ? body : null;
  } catch {
    return null;
  }
}

export interface MonadFacilitatorClientOptions {
  /** Defaults to Monad's native facilitator (README §8 claim 4). */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  /**
   * Which request envelope to send. Defaults to the one Monad's facilitator was measured to
   * accept (`MONAD_FACILITATOR_ENVELOPE`); set it to `"spec"` for a facilitator that follows the
   * written specification instead. `null` makes the client try each once and remember the winner.
   */
  readonly envelope?: FacilitatorEnvelope | null;
}

export interface FacilitatorProbe {
  readonly reachable: boolean;
  /** True when the facilitator lists the `exact` scheme for this network. */
  readonly supportsExact: boolean;
  readonly kinds: readonly SupportedKind[];
  /** The facilitator's own settlement addresses, when it publishes them. */
  readonly signers: readonly string[];
  readonly detail?: string;
}

/**
 * HTTP client for the x402 facilitator API (`/supported`, `/verify`, `/settle`), speaking **v2** —
 * Monad's facilitator refuses anything older ("Monad Facilitator only supports x402 version 2 and
 * above"), which is why the v1 client this replaced could never have reached it.
 */
export class MonadFacilitatorClient implements X402Facilitator {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  #envelope: FacilitatorEnvelope | undefined;
  #signers: Record<string, string[]> = {};

  constructor(options: MonadFacilitatorClientOptions = {}) {
    this.#base = (options.baseUrl ?? MONAD_FACILITATOR_URL).replace(/\/+$/, "");
    this.#envelope =
      options.envelope === null ? undefined : (options.envelope ?? MONAD_FACILITATOR_ENVELOPE);
    // Stored on the instance, so the global must be bound: `this.#fetch(...)` would otherwise call
    // `window.fetch` with `this` = the transport, which browsers refuse ("Illegal invocation").
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#headers = {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    };
    this.#logger = options.logger ?? noopLogger;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async supported(): Promise<readonly SupportedKind[]> {
    const body = FacilitatorSupportedSchema.parse(await this.request<unknown>("GET", "/supported"));
    this.#signers = body.signers ?? {};
    // `exactOptionalPropertyTypes`: an absent field is absent, never `undefined`.
    return body.kinds.map((k) => ({
      scheme: k.scheme,
      network: k.network,
      ...(k.x402Version === undefined ? {} : { x402Version: k.x402Version }),
      ...(k.extra === undefined ? {} : { extra: k.extra }),
    }));
  }

  /**
   * One question at boot instead of a surprise per request: is the facilitator reachable, and does
   * it list `exact` for this network? The gateway reports the answer in discovery and `/healthz`.
   */
  async probe(network: string): Promise<FacilitatorProbe> {
    try {
      const kinds = await this.supported();
      const supportsExact = kinds.some(
        (k) => k.scheme === "exact" && sameNetwork(k.network, network),
      );
      return {
        reachable: true,
        supportsExact,
        kinds,
        signers: this.#signersFor(network),
        ...(supportsExact ? {} : { detail: `facilitator lists no "exact" scheme for ${network}` }),
      };
    } catch (cause) {
      return {
        reachable: false,
        supportsExact: false,
        kinds: [],
        signers: [],
        detail: (cause as Error).message,
      };
    }
  }

  #signersFor(network: string): readonly string[] {
    for (const [key, addresses] of Object.entries(this.#signers)) {
      if (sameNetwork(key, network)) return addresses;
    }
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = await this.post("/verify", payload, requirements);
    const parsed = FacilitatorVerifySchema.parse(body);
    return {
      isValid: parsed.isValid,
      verifiedBy: "monad",
      ...(parsed.invalidReason ? { invalidReason: parsed.invalidReason } : {}),
      ...(parsed.payer ? { payer: parsed.payer.toLowerCase() as Address } : {}),
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const parsed = FacilitatorSettleSchema.parse(await this.post("/settle", payload, requirements));
    const res: SettleResponse = {
      success: parsed.success,
      network: parsed.network ?? requirements.network,
      ...(parsed.transaction ? { transaction: parsed.transaction as `0x${string}` } : {}),
      ...(parsed.errorReason ? { errorReason: parsed.errorReason } : {}),
      ...(parsed.payer ? { payer: parsed.payer.toLowerCase() as Address } : {}),
    };
    if (!res.success) {
      throw new PaymentError(
        "FH_PAYMENT_INVALID",
        `settlement failed: ${res.errorReason ?? "unknown"}`,
        {
          context: { network: res.network },
        },
      );
    }
    return res;
  }

  /**
   * Sends the pinned envelope; unpinned, tries each published shape once and remembers the one the
   * facilitator understood. A 4xx that is not a verdict is what "wrong envelope" looks like.
   */
  private async post(
    path: "/verify" | "/settle",
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<unknown> {
    const candidates = this.#envelope ? [this.#envelope] : FACILITATOR_ENVELOPES;
    let last: unknown;
    for (const envelope of candidates) {
      try {
        const body = await this.request<unknown>(
          "POST",
          path,
          facilitatorBody(envelope, payload, requirements),
        );
        if (this.#envelope === undefined) {
          this.#envelope = envelope;
          this.#logger.info("facilitator envelope pinned", { envelope, path });
        }
        return body;
      } catch (cause) {
        last = cause;
        const status = (cause as { context?: { status?: number } }).context?.status;
        // Only an envelope-shaped refusal is worth retrying in the other shape.
        if (status !== undefined && status !== 400 && status !== 422) throw cause;
      }
    }
    throw last;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
          const res = await this.#fetch(`${this.#base}${path}`, {
            method,
            headers: this.#headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          });
          const text = await res.text();
          // Monad's facilitator answers a *verdict* with a failure status: `insufficient_funds`
          // comes back 400, and a forged signature comes back 500 because it verifies by
          // simulating `transferWithAuthorization` on chain and the call reverts (both measured
          // 2026-09-23). A body that carries a verdict is the answer whatever the status says —
          // retrying it would be three round trips to reach the same "no".
          const verdict = asVerdict(text);
          if (verdict !== null) return verdict as T;
          if (!res.ok) {
            throw new TransportError(
              "FH_TRANSPORT",
              `facilitator ${path} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
              {
                retryable: res.status >= 500,
                context: { status: res.status, detail: text.slice(0, 300) },
              },
            );
          }
          return JSON.parse(text) as T;
        } catch (cause) {
          if (cause instanceof TransportError) throw cause;
          throw new TransportError("FH_TRANSPORT", `facilitator ${path} unreachable`, {
            cause,
            retryable: true,
          });
        } finally {
          clearTimeout(timer);
        }
      },
      {
        retries: 2,
        onRetry: (error, attempt) =>
          this.#logger.warn("facilitator retry", { path, attempt, error }),
      },
    );
  }
}
