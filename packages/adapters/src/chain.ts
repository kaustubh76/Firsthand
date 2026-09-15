import { MONAD_TESTNET_CHAIN_ID } from "@firsthand/core";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
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
}

export interface ChainClients {
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> | null;
  readonly account: PrivateKeyAccount | null;
}

export function createChainClients(options: ChainClientsOptions): ChainClients {
  const chain = options.chain ?? monadTestnet;
  const transport = http(options.rpcUrl);
  const clientOptions =
    options.pollingInterval === undefined ? {} : { pollingInterval: options.pollingInterval };
  const publicClient = createPublicClient({ chain, transport, ...clientOptions });
  if (options.privateKey === undefined) {
    return { chain, publicClient, walletClient: null, account: null };
  }
  const account = privateKeyToAccount(options.privateKey);
  const walletClient = createWalletClient({ chain, transport, account, ...clientOptions });
  return { chain, publicClient, walletClient, account };
}
