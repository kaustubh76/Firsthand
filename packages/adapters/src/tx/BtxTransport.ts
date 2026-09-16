import { type Bytes32, type Hex, hexToBytes, keccak256Hex, TransportError } from "@firsthand/core";
import type { Chain, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type {
  PreparedTx,
  TransportCapabilities,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";

export interface BtxTransportOptions {
  /** The BTX submission endpoint (JSON-RPC). */
  readonly rpcUrl: string;
  /** Signs the transaction locally; the raw bytes are what gets sealed and posted. */
  readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** JSON-RPC method name once confirmed by Monad. Default is a guess (README §16 Phase 0 gate). */
  readonly method?: string;
  /**
   * Seals the signed raw transaction for the encrypted mempool. Identity by default — Monad's BTX
   * (Category Labs' batched threshold encryption) has no public surface as of 2026-09, so the
   * threshold-encryption step is a hook, not an implementation. Never called when unavailable.
   */
  readonly seal?: (raw: Hex) => Promise<Hex>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Monad BTX encrypted-mempool transport (README §8 claim 1, ADR-0006/0012). Sign → seal → post.
 * `probe()` asks the node whether the method exists; while it does not, `send` fails with
 * `FH_BTX_UNAVAILABLE` so callers fall back to commit-reveal explicitly rather than silently
 * degrading to the public mempool.
 */
export class BtxTransport implements TxTransport {
  readonly kind = "btx" as const;
  readonly #rpcUrl: string;
  readonly #wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly #method: string;
  readonly #seal: (raw: Hex) => Promise<Hex>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #available: boolean | null = null;
  #id = 1;

  constructor(options: BtxTransportOptions) {
    this.#rpcUrl = options.rpcUrl;
    this.#wallet = options.wallet;
    this.#method = options.method ?? "eth_sendEncryptedRawTransaction";
    this.#seal = options.seal ?? (async (raw) => raw);
    // Stored on the instance, so the global must be bound: `this.#fetch(...)` would otherwise call
    // `window.fetch` with `this` = the transport, which browsers refuse ("Illegal invocation").
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  get method(): string {
    return this.#method;
  }

  /** Detects support by probing the method with no params; a "method not found" answer means no BTX. */
  async probe(): Promise<TransportCapabilities> {
    try {
      const body = await this.#rpc([]);
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

  async send(tx: PreparedTx): Promise<TxRef> {
    const caps = await this.capabilities();
    if (!caps.encryptedMempool) {
      throw new TransportError("FH_BTX_UNAVAILABLE", "BTX transport not available", {
        context: { method: this.#method, detail: caps.detail ?? "unconfirmed" },
      });
    }
    const request = await this.#wallet.prepareTransactionRequest({
      to: tx.to,
      data: tx.data,
      ...(tx.value === undefined ? {} : { value: tx.value }),
      ...(tx.gas === undefined ? {} : { gas: tx.gas }),
    });
    const raw = await this.#wallet.signTransaction(request);
    const sealed = await this.#seal(raw);
    const body = await this.#rpc([sealed]);
    if (body.error) {
      throw new TransportError(
        "FH_TRANSPORT",
        `${this.#method}: ${body.error.message ?? "error"}`,
        {
          context: { code: body.error.code ?? null },
          retryable: true,
        },
      );
    }
    // A conforming node echoes the transaction hash; a sealed submission may return an opaque
    // ticket instead, in which case the hash of the signed bytes still identifies the tx on chain.
    const result = typeof body.result === "string" ? body.result : "";
    const hash: Bytes32 = /^0x[0-9a-fA-F]{64}$/.test(result)
      ? (result.toLowerCase() as Bytes32)
      : keccak256Hex(hexToBytes(raw));
    return { hash, transport: "btx", submittedAt: this.#now() };
  }

  async #rpc(
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { code?: number; message?: string } }> {
    const res = await this.#fetch(this.#rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method: this.#method, params }),
    });
    return (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  }
}
