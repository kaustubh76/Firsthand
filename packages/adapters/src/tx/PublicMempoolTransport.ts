import { ChainError } from "@firsthand/core";
import type { Chain, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type {
  PreparedTx,
  TransportCapabilities,
  TxRef,
  TxTransport,
} from "../ports/TxTransport.js";
import { classifySendError, insufficientFundsError, sendWithNonceRetry } from "./send.js";

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
    const account = this.#wallet.account;
    try {
      const hash = await sendWithNonceRetry(
        () =>
          this.#wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            ...(tx.value === undefined ? {} : { value: tx.value }),
            ...(tx.gas === undefined ? {} : { gas: tx.gas }),
          }),
        { account, chainId: this.#wallet.chain.id },
      );
      return { hash, transport: "public", submittedAt: this.#now() };
    } catch (cause) {
      const failure = classifySendError(cause);
      if (failure.kind === "funds") {
        throw insufficientFundsError(
          `public transport: the paying key ${account.address} is out of gas`,
          account.address,
          cause,
        );
      }
      throw new ChainError(`public transport: sendTransaction failed (${failure.detail})`, {
        cause,
        retryable: failure.kind !== "revert",
      });
    }
  }

  capabilities(): Promise<TransportCapabilities> {
    return Promise.resolve({ encryptedMempool: false, detail: "eth_sendRawTransaction" });
  }
}
