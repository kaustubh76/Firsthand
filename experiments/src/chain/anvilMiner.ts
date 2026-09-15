import { jsonRpc } from "./rpc.js";

/**
 * Drives anvil's block cadence for a race window. `evm_setIntervalMining` only takes whole seconds,
 * so a Monad-like 400 ms cadence is produced by turning automine off and calling `evm_mine` on a
 * timer. Automine is always restored — the shared node must be left as it was found, even when the
 * scenario throws.
 */
export class AnvilMiner {
  readonly #rpcUrl: string;

  constructor(rpcUrl: string) {
    this.#rpcUrl = rpcUrl;
  }

  async automine(): Promise<boolean> {
    return jsonRpc<boolean>(this.#rpcUrl, "anvil_getAutomine");
  }

  async withIntervalMining<T>(intervalMs: number, fn: () => Promise<T>): Promise<T> {
    const previous = await this.automine();
    await jsonRpc(this.#rpcUrl, "evm_setAutomine", [false]);
    let mining: Promise<unknown> | null = null;
    const timer = setInterval(() => {
      // Never overlap two mines; a slow node just skips a tick.
      if (mining) return;
      mining = jsonRpc(this.#rpcUrl, "evm_mine")
        .catch(() => undefined)
        .finally(() => {
          mining = null;
        });
    }, intervalMs);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      await mining;
      await jsonRpc(this.#rpcUrl, "evm_setAutomine", [previous]);
    }
  }
}
