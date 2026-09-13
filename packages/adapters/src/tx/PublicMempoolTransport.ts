import { ChainError } from "@firsthand/core";
import type { Chain, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type {
  PreparedTx,
  TransportCapabilities,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";

/** Ordinary `eth_sendRawTransaction` — the public-mempool baseline arm (README §15 B2). */
export class PublicMempoolTransport implements TxTransport {
  readonly kind = "public" as const;
  readonly #wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly #now: () => number;

  constructor(
    wallet: WalletClient<Transport, Chain, PrivateKeyAccount>,
    now: () => number = Date.now,
  ) {
    this.#wallet = wallet;
    this.#now = now;
  }

  async send(tx: PreparedTx): Promise<TxRef> {
    try {
      const hash = await this.#wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        ...(tx.value === undefined ? {} : { value: tx.value }),
        ...(tx.gas === undefined ? {} : { gas: tx.gas }),
      });
      return { hash, transport: "public", submittedAt: this.#now() };
    } catch (cause) {
      throw new ChainError("public transport: sendTransaction failed", { cause, retryable: true });
    }
  }

  capabilities(): Promise<TransportCapabilities> {
    return Promise.resolve({ encryptedMempool: false, detail: "eth_sendRawTransaction" });
  }
}
