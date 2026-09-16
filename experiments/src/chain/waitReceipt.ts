import type { Bytes32 } from "@firsthand/core";
import type { Chain, PublicClient, TransactionReceipt, Transport } from "viem";

/**
 * Plain receipt polling. viem's `waitForTransactionReceipt` is a block-number watcher and, under
 * harness-driven mining with a 25 ms cadence, has been observed to miss a receipt that is already
 * on chain (the race harness then hangs for its 180 s timeout). Asking for the receipt directly
 * has no such failure mode.
 */
export async function waitForReceipt(
  publicClient: PublicClient<Transport, Chain>,
  hash: Bytes32,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<TransactionReceipt> {
  // 250 ms keeps a public RPC happy and is still sub-block on Monad (~400 ms); anvil tests override.
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`receipt for ${hash} not seen within ${options.timeoutMs ?? 60_000} ms`);
}
