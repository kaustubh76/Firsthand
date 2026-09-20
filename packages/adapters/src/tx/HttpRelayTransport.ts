import {
  type Bytes32,
  ChainError,
  GrantError,
  TransportError,
  ValidationError,
} from "@firsthand/core";
import type {
  PreparedTx,
  TransportCapabilities,
  TransportKind,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";

export interface HttpRelayTransportOptions {
  /** Gateway base URL, e.g. https://gateway.example — `/v1/relay` is appended. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Submits signature-authorised calls through a gateway's relay, for clients that hold no key and no
 * native balance — the capture PWA. Fetch only: no node built-ins, no wallet, browser-safe.
 *
 * `kind` reports `"public"` because that is what the relay's mempool actually is. It is deliberately
 * not configurable: `assertPathTransport` (ADR-0012) compares a rescission plan's path against the
 * transport kind precisely so a `btx` plan cannot be silently downgraded, and a relay that claimed to
 * be BTX would defeat that check. A relay that gains an encrypted path must say so through
 * `capabilities()` and this class must be taught about it explicitly.
 */
export class HttpRelayTransport implements TxTransport {
  readonly kind: TransportKind = "public";
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: HttpRelayTransportOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    // Stored on the instance, so the global must be bound: `this.#fetch(...)` would otherwise call
    // `window.fetch` with `this` = the transport, which browsers refuse ("Illegal invocation").
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  async send(tx: PreparedTx): Promise<TxRef> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/v1/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: tx.to,
          data: tx.data,
          ...(tx.value === undefined ? {} : { value: tx.value.toString() }),
          ...(tx.gas === undefined ? {} : { gas: tx.gas.toString() }),
        }),
      });
    } catch (cause) {
      throw new TransportError("FH_TRANSPORT", "relay unreachable", { cause, retryable: true });
    }
    const body = (await res.json().catch(() => null)) as {
      hash?: string;
      submittedAt?: number;
      code?: string;
      error?: string;
      detail?: string;
      retryable?: boolean;
    } | null;
    if (!res.ok) {
      const message =
        body?.detail ?? body?.error ?? `relay rejected the transaction (${res.status})`;
      const context = { status: res.status, code: body?.code, to: tx.to };
      // The gateway's problem body names what happened; keep that name so a screen can act on it.
      switch (body?.code) {
        case "FH_INSUFFICIENT_FUNDS":
          throw new ChainError(message, { code: "FH_INSUFFICIENT_FUNDS", context });
        case "FH_RATE_LIMITED": {
          const retryAfter = Number(res.headers.get("retry-after"));
          throw new GrantError(
            "FH_RATE_LIMITED",
            `the gateway is rate-limiting this network — retry in ${
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : "a few"
            } s`,
            { retryable: true, context: { ...context, retryAfter } },
          );
        }
        case "FH_CHAIN":
          // A decoded revert ("would revert: EpochNotAttested(…)") or a busy RPC — the body says which.
          throw new ChainError(message, { retryable: body?.retryable ?? false, context });
        default:
          break;
      }
      // 4xx is the caller's problem (bad target, non-zero value); 5xx is the relay's.
      if (res.status >= 500) {
        throw new TransportError("FH_TRANSPORT", message, { retryable: true, context });
      }
      throw res.status === 400 || res.status === 404
        ? new ValidationError(message, { context })
        : new ChainError(message, { context });
    }
    if (typeof body?.hash !== "string") {
      throw new ChainError("relay returned no transaction hash", { context: { to: tx.to } });
    }
    return {
      hash: body.hash as Bytes32,
      transport: this.kind,
      submittedAt: body.submittedAt ?? this.#now(),
    };
  }

  async capabilities(): Promise<TransportCapabilities> {
    try {
      const res = await this.#fetch(`${this.#base}/v1/relay/capabilities`);
      if (!res.ok) return { encryptedMempool: false, detail: `relay unavailable (${res.status})` };
      const body = (await res.json()) as { relayer?: string };
      return { encryptedMempool: false, detail: `relayed by ${body.relayer ?? "gateway"}` };
    } catch (cause) {
      return { encryptedMempool: false, detail: `relay probe failed: ${(cause as Error).message}` };
    }
  }
}
