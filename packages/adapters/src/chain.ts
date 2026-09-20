import { MONAD_TESTNET_CHAIN_ID } from "@firsthand/core";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  nonceManager,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/** Monad testnet. Verify id / RPC against the current testnet docs before deployment (decision #16). */
export const monadTestnet: Chain = defineChain({
  id: Number(MONAD_TESTNET_CHAIN_ID),
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } },
  testnet: true,
});

export const anvil: Chain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export interface ChainClientsOptions {
  readonly rpcUrl: string;
  readonly chain?: Chain;
  /** Optional signer; omit for read-only clients (the gateway never signs with user keys). */
  readonly privateKey?: `0x${string}`;
  /** Receipt/pending polling cadence in ms (viem default 4 000). Race harnesses need ~25. */
  readonly pollingInterval?: number;
  /**
   * Retries on a 429 / 5xx from the RPC (viem retries those), with exponential backoff from
   * `retryDelayMs`. Monad's public endpoint enforces a per-second window (measured 2026-09-20:
   * `x-ratelimit-limit: 50;w=1`, and "requests limited to 15/sec" from a hosted function's shared
   * egress), so the default backoff — 300 · 2^n ms, four times — spans the window rather than
   * viem's ~1 s total.
   */
  readonly retryCount?: number;
  readonly retryDelayMs?: number;
}

export interface ChainClients {
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> | null;
  readonly account: PrivateKeyAccount | null;
}

export function createChainClients(options: ChainClientsOptions): ChainClients {
  const chain = options.chain ?? monadTestnet;
  const transport = http(options.rpcUrl, {
    retryCount: options.retryCount ?? 4,
    retryDelay: options.retryDelayMs ?? 300,
  });
  const clientOptions =
    options.pollingInterval === undefined ? {} : { pollingInterval: options.pollingInterval };
  const publicClient = createPublicClient({ chain, transport, ...clientOptions });
  if (options.privateKey === undefined) {
    return { chain, publicClient, walletClient: null, account: null };
  }
  // One key, many senders: the nonce manager hands concurrent sends in this process distinct
  // pending nonces; collisions with *other* processes are retried by `sendWithNonceRetry`.
  const account = privateKeyToAccount(options.privateKey, { nonceManager });
  const walletClient = createWalletClient({ chain, transport, account, ...clientOptions });
  return { chain, publicClient, walletClient, account };
}
