import { jsonRpc } from "./rpc.js";

/**
 * Drives anvil's block cadence for a race window. `evm_setIntervalMining` only takes whole seconds,
 * so a Monad-like 400 ms cadence is produced by turning automine off and calling `evm_mine` on a
 * timer. Automine is always restored — the shared node must be left as it was found, even when the
 * scenario throws.
 */
export class AnvilMiner {
  readonly #rpcUrl: string;
  readonly #now: () => number;
  /** Wall-clock (ms) at which each block mined by this miner was sealed — the race's time base. */
  readonly blockMinedAt = new Map<bigint, number>();

  constructor(rpcUrl: string, now: () => number = Date.now) {
    this.#rpcUrl = rpcUrl;
    this.#now = now;
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
        .then(async () => {
          const at = this.#now();
          const head = await jsonRpc<string>(this.#rpcUrl, "eth_blockNumber");
          this.blockMinedAt.set(BigInt(head), at);
        })
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
