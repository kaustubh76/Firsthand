import { TransportError } from "@firsthand/core";
import type {
  PreparedTx,
  TransportCapabilities,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";

export interface BtxTransportOptions {
  readonly rpcUrl: string;
  /** JSON-RPC method name once confirmed by Monad (Phase 0 gate). */
  readonly method?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Monad BTX encrypted-mempool transport (README §8 claim 1). Typed shell: `probe()` asks the node
 * whether the method exists; until it is confirmed, `send` fails with `FH_BTX_UNAVAILABLE` so callers
 * fall back to commit-reveal explicitly rather than silently degrading to the public mempool.
 */
export class BtxTransport implements TxTransport {
  readonly kind = "btx" as const;
  readonly #rpcUrl: string;
  readonly #method: string;
  readonly #fetch: typeof fetch;
  #available: boolean | null = null;

  constructor(options: BtxTransportOptions) {
    this.#rpcUrl = options.rpcUrl;
    this.#method = options.method ?? "eth_sendEncryptedRawTransaction";
    this.#fetch = options.fetch ?? fetch;
  }

  /** Detects support by probing the method with no params; a "method not found" answer means no BTX. */
  async probe(): Promise<TransportCapabilities> {
    try {
      const res = await this.#fetch(this.#rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: this.#method, params: [] }),
      });
      const body = (await res.json()) as { error?: { code?: number; message?: string } };
      const notFound = body.error?.code === -32601;
      this.#available = !notFound;
      return {
        encryptedMempool: this.#available,
        detail: notFound
          ? `${this.#method} not supported by ${this.#rpcUrl}`
          : `${this.#method} available`,
      };
    } catch (cause) {
      this.#available = false;
      return { encryptedMempool: false, detail: `probe failed: ${(cause as Error).message}` };
    }
  }

  capabilities(): Promise<TransportCapabilities> {
    return this.#available === null
      ? this.probe()
      : Promise.resolve({ encryptedMempool: this.#available });
  }

  async send(_tx: PreparedTx): Promise<TxRef> {
    const caps = await this.capabilities();
    // TODO(Phase 4): encrypt + submit once the BTX RPC surface is confirmed.
    throw new TransportError("FH_BTX_UNAVAILABLE", "BTX transport not available", {
      context: { method: this.#method, detail: caps.detail ?? "unconfirmed" },
    });
  }
}
