import type { Address, Bytes32 } from "@firsthand/core";
import { ChainError } from "@firsthand/core";
import {
  type Chain,
  decodeEventLog,
  hexToString,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type {
  AgentView,
  Erc8004Registry,
  Erc8004Writer,
  ReputationSummary,
} from "../ports/Erc8004Registry.js";
import { sendWithNonceRetry } from "../tx/send.js";
import { CARD_METADATA_KEY, IdentityRegistryAbi, ReputationRegistryAbi } from "./abi.js";
import { type Erc8004Addresses, erc8004Addresses } from "./addresses.js";
import { decodeAgentURI } from "./agentUri.js";

export interface OnchainErc8004RegistryOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Defaults to the reference deployment for the client's chain; null where there is none. */
  readonly addresses?: Erc8004Addresses | null;
  /** Needed for `registerAgent` / `giveFeedback`; reads work without it. */
  readonly walletClient?: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/** The reference ERC-8004 registries over viem. */
export class OnchainErc8004Registry implements Erc8004Registry, Erc8004Writer {
  readonly addresses: Erc8004Addresses | null;
  readonly #o: OnchainErc8004RegistryOptions;

  constructor(options: OnchainErc8004RegistryOptions) {
    this.#o = options;
    this.addresses =
      options.addresses === undefined
        ? erc8004Addresses(options.publicClient.chain.id)
        : options.addresses;
  }

  #need(): Erc8004Addresses {
    if (!this.addresses) {
      throw new ChainError("ERC-8004 registries are not deployed on this chain", {
        context: { chainId: this.#o.publicClient.chain.id },
      });
    }
    return this.addresses;
  }

  async agent(agentId: bigint): Promise<AgentView | null> {
    const a = this.#need();
    const pc = this.#o.publicClient;
    let owner: Address;
    try {
      owner = (
        await pc.readContract({
          address: a.identityRegistry,
          abi: IdentityRegistryAbi,
          functionName: "ownerOf",
          args: [agentId],
        })
      ).toLowerCase() as Address;
    } catch {
      return null; // ERC-721: ownerOf reverts for an unminted token
    }
    const [agentURI, wallet, cardRaw] = await Promise.all([
      pc.readContract({
        address: a.identityRegistry,
        abi: IdentityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
      }),
      pc
        .readContract({
          address: a.identityRegistry,
          abi: IdentityRegistryAbi,
          functionName: "getAgentWallet",
          args: [agentId],
        })
        .catch(() => "0x0000000000000000000000000000000000000000" as const),
      pc.readContract({
        address: a.identityRegistry,
        abi: IdentityRegistryAbi,
        functionName: "getMetadata",
        args: [agentId, CARD_METADATA_KEY],
      }),
    ]);
    const cardId = decodeCard(cardRaw);
    return {
      agentId,
      owner,
      agentURI,
      wallet:
        wallet === "0x0000000000000000000000000000000000000000"
          ? null
          : (wallet.toLowerCase() as Address),
      cardId,
      registration: decodeAgentURI(agentURI),
    };
  }

  async verifyCardBinding(agentId: bigint, cardId: Bytes32, cardOwner: Address): Promise<boolean> {
    const view = await this.agent(agentId);
    if (!view) return false;
    return (
      view.cardId !== null &&
      view.cardId.toLowerCase() === cardId.toLowerCase() &&
      view.owner === cardOwner.toLowerCase()
    );
  }

  async summary(
    agentId: bigint,
    clients: readonly Address[] = [],
    tag1 = "",
    tag2 = "",
  ): Promise<ReputationSummary> {
    const a = this.#need();
    // The registry refuses an empty client list ("clientAddresses required"): "everyone" means
    // every client that has ever given this agent feedback, which it also tells us.
    let who: readonly Address[] = clients;
    if (who.length === 0) {
      who = (await this.#o.publicClient.readContract({
        address: a.reputationRegistry,
        abi: ReputationRegistryAbi,
        functionName: "getClients",
        args: [agentId],
      })) as readonly Address[];
      if (who.length === 0) return { count: 0n, value: 0n, decimals: 0 };
    }
    const [count, value, decimals] = await this.#o.publicClient.readContract({
      address: a.reputationRegistry,
      abi: ReputationRegistryAbi,
      functionName: "getSummary",
      args: [agentId, [...who], tag1, tag2],
    });
    return { count: BigInt(count), value: BigInt(value), decimals: Number(decimals) };
  }

  async registerAgent(input: {
    readonly agentURI: string;
    readonly metadata?: readonly { key: string; value: `0x${string}` }[];
  }): Promise<{ agentId: bigint; txHash: Bytes32 }> {
    const a = this.#need();
    const wallet = this.#wallet();
    const hash = await sendWithNonceRetry(
      () =>
        wallet.writeContract({
          address: a.identityRegistry,
          abi: IdentityRegistryAbi,
          functionName: "register",
          args: [
            input.agentURI,
            (input.metadata ?? []).map((m) => ({ metadataKey: m.key, metadataValue: m.value })),
          ],
        }),
      { account: wallet.account, chainId: wallet.chain.id },
    );
    const receipt = await this.#o.publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: IdentityRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Registered") {
          return { agentId: ev.args.agentId, txHash: hash as Bytes32 };
        }
      } catch {
        // another contract's log
      }
    }
    throw new ChainError("register() mined but emitted no Registered event", {
      context: { txHash: hash },
    });
  }

  async giveFeedback(input: {
    readonly agentId: bigint;
    readonly value: bigint;
    readonly decimals?: number;
    readonly tag1: string;
    readonly tag2: string;
    readonly endpoint: string;
    readonly feedbackURI: string;
    readonly feedbackHash: Bytes32;
  }): Promise<Bytes32> {
    const a = this.#need();
    const wallet = this.#wallet();
    const hash = await sendWithNonceRetry(
      () =>
        wallet.writeContract({
          address: a.reputationRegistry,
          abi: ReputationRegistryAbi,
          functionName: "giveFeedback",
          args: [
            input.agentId,
            input.value,
            input.decimals ?? 0,
            input.tag1,
            input.tag2,
            input.endpoint,
            input.feedbackURI,
            input.feedbackHash,
          ],
        }),
      { account: wallet.account, chainId: wallet.chain.id },
    );
    return hash as Bytes32;
  }

  #wallet(): WalletClient<Transport, Chain, PrivateKeyAccount> {
    if (!this.#o.walletClient) {
      throw new ChainError(
        "ERC-8004 writes need a wallet: registration and feedback are msg.sender-authorised",
      );
    }
    return this.#o.walletClient;
  }
}

/** Metadata is bytes; FIRSTHAND stores the card id as its 32 raw bytes (or, tolerated, as hex text). */
export function decodeCard(raw: `0x${string}`): Bytes32 | null {
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase() as Bytes32;
  try {
    const text = hexToString(raw);
    if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase() as Bytes32;
  } catch {
    // not text
  }
  return null;
}

/** The metadata entry that binds a card to an agent at registration. */
export function cardMetadata(cardId: Bytes32): { key: string; value: `0x${string}` } {
  return { key: CARD_METADATA_KEY, value: cardId };
}
