import { type Bytes32, ChainError, TransportError, ValidationError } from "@firsthand/core";
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
    this.#fetch = options.fetch ?? fetch;
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
    } | null;
    if (!res.ok) {
      const message =
        body?.detail ?? body?.error ?? `relay rejected the transaction (${res.status})`;
      // 4xx is the caller's problem (bad target, non-zero value, would revert); 5xx is the relay's.
      if (res.status >= 500) {
        throw new TransportError("FH_TRANSPORT", message, { retryable: true });
      }
      throw res.status === 400 || res.status === 404
        ? new ValidationError(message, { context: { status: res.status, to: tx.to } })
        : new ChainError(message, { context: { status: res.status, to: tx.to } });
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
