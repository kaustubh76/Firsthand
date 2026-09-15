import type { Address, Bytes32, Hex } from "@firsthand/core";
import { jsonRpc } from "../chain/rpc.js";

/** What an observer with mempool visibility sees: the pending transaction, calldata included. */
export interface PendingTx {
  readonly hash: Bytes32;
  readonly from: Address;
  readonly to: Address | null;
  readonly input: Hex;
}

export interface MempoolFeed {
  start(onTx: (tx: PendingTx) => void): void;
  stop(): void;
}

interface TxpoolContent {
  pending: Record<
    string,
    Record<string, { hash: Bytes32; from: Address; to: Address | null; input: Hex }>
  >;
}

/**
 * Polls `txpool_content` (anvil, geth-style nodes). Monad has no global mempool (RPC nodes forward
 * to the next leaders), so on testnet this feed is the *upper bound* of what an observer could see —
 * which is what the B2 baseline is meant to measure.
 */
export class TxpoolPollingFeed implements MempoolFeed {
  readonly #rpcUrl: string;
  readonly #intervalMs: number;
  readonly #seen = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight = false;

  constructor(options: { rpcUrl: string; intervalMs?: number }) {
    this.#rpcUrl = options.rpcUrl;
    this.#intervalMs = options.intervalMs ?? 20;
  }

  start(onTx: (tx: PendingTx) => void): void {
    this.stop();
    this.#timer = setInterval(() => {
      if (this.#inFlight) return;
      this.#inFlight = true;
      jsonRpc<TxpoolContent>(this.#rpcUrl, "txpool_content")
        .then((content) => {
          for (const byNonce of Object.values(content.pending ?? {})) {
            for (const tx of Object.values(byNonce)) {
              if (this.#seen.has(tx.hash)) continue;
              this.#seen.add(tx.hash);
              onTx({
                hash: tx.hash,
                from: tx.from.toLowerCase() as Address,
                to: tx.to ? (tx.to.toLowerCase() as Address) : null,
                input: tx.input,
              });
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.#inFlight = false;
        });
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** A feed that never delivers: the observer of an encrypted mempool, or of no mempool at all. */
export class BlindFeed implements MempoolFeed {
  start(): void {}
  stop(): void {}
}
