import { PaymentError, TransportError } from "@firsthand/core";
import { type Logger, noopLogger, withRetry } from "@firsthand/runtime";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
  X402Facilitator,
} from "../ports/X402Facilitator.js";

export interface MonadFacilitatorClientOptions {
  /** e.g. https://x402.monad.xyz — Monad's native facilitator (README §8 claim 4). */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

/** HTTP client for the x402 facilitator API (`/supported`, `/verify`, `/settle`). */
export class MonadFacilitatorClient implements X402Facilitator {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #logger: Logger;
  readonly #timeoutMs: number;

  constructor(options: MonadFacilitatorClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
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
    const body = await this.request<{ kinds: SupportedKind[] }>("GET", "/supported");
    return body.kinds;
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.request<VerifyResponse>("POST", "/verify", {
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const res = await this.request<SettleResponse>("POST", "/settle", {
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
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
          if (res.status >= 500) {
            throw new TransportError("FH_TRANSPORT", `facilitator ${path} returned ${res.status}`, {
              retryable: true,
            });
          }
          if (!res.ok) {
            throw new TransportError("FH_TRANSPORT", `facilitator ${path} returned ${res.status}`, {
              retryable: false,
            });
          }
          return (await res.json()) as T;
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
