import type { PaymentRequirements, TxTransport } from "@firsthand/adapters";
import type { Address, Bytes32, Terms } from "@firsthand/core";
import { BuyerSession, createBuyerKeys, type Locker, planGrant, sendGrant } from "@firsthand/sdk";
import { type Chain, type PublicClient, parseAbi, type Transport, type WalletClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { waitForReceipt } from "../chain/waitReceipt.js";

/** The demand side every buyer scenario shares (S2, S3): one funded EVM key, cards, terms, grants. */
export const BUYER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const; // anvil #2
export const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

export const buyerAccount = (): PrivateKeyAccount => privateKeyToAccount(BUYER_KEY);
export const buyerSeed = (): Uint8Array => new Uint8Array(Buffer.from(BUYER_KEY.slice(2), "hex"));

export async function mintUsdc(
  wallet: WalletClient<Transport, Chain, PrivateKeyAccount>,
  publicClient: PublicClient<Transport, Chain>,
  usdc: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const hash = await wallet.writeContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "mint",
    args: [to, amount],
  });
  await waitForReceipt(publicClient, hash);
}

/** A buyer with a fresh X25519 key → a fresh card id even for the same owner (grantId depends on it). */
export function newBuyer(options: {
  grantManager: Address;
  chainId: bigint;
  transport: TxTransport;
  granteeSeed?: Uint8Array;
}): BuyerSession {
  const seed = options.granteeSeed ?? crypto.getRandomValues(new Uint8Array(32));
  return new BuyerSession({
    keys: createBuyerKeys(buyerSeed(), buyerAccount(), seed),
    grantManager: options.grantManager,
    chainId: options.chainId,
    transport: options.transport,
  });
}

/** registerCard + acceptTerms, waiting for inclusion; returns the registered terms hash. */
export async function registerAndAccept(
  buyer: BuyerSession,
  principalId: Bytes32,
  terms: Terms,
  wait: (hash: Bytes32) => Promise<unknown>,
): Promise<Bytes32> {
  await wait((await buyer.registerCard()).txHash);
  const accept = buyer.acceptTerms(principalId, terms);
  await wait((await accept.send()).txHash);
  return accept.plan.termsHash;
}

/** The principal grants to the buyer's card over `transport`; returns the grant id once included. */
export async function grantTo(options: {
  locker: Locker;
  grantManager: Address;
  transport: TxTransport;
  buyer: BuyerSession;
  termsHash: Bytes32;
  ns: number;
  term: bigint;
  wait: (hash: Bytes32) => Promise<unknown>;
}): Promise<Bytes32> {
  const plan = planGrant(options.locker, options.grantManager, {
    granteeCard: options.buyer.cardId,
    granteeEncryptionPubKey: options.buyer.encryptionPubKey,
    ns: options.ns,
    termsHash: options.termsHash,
    term: options.term,
  });
  await options.wait((await sendGrant(options.locker, options.transport, plan)).txHash);
  return plan.grantId;
}

/** x402 "exact" requirements the way the gateway advertises them, with the chain's clock. */
export function requirementsFor(options: {
  payTo: Address;
  asset: Address;
  chainId: bigint;
  price: bigint;
  chainTime: bigint;
  resource: string;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "monad-testnet",
    maxAmountRequired: options.price.toString(),
    resource: options.resource,
    description: options.resource,
    mimeType: "application/json",
    payTo: options.payTo,
    maxTimeoutSeconds: 3600,
    asset: options.asset,
    extra: { chainId: options.chainId.toString(), chainTime: options.chainTime.toString() },
  };
}
