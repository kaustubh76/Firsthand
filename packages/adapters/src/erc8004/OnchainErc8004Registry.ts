import { type Bytes32, type GranteeCard, NotImplementedError } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";
import type { Erc8004Registry } from "../ports/Erc8004Registry.js";

/**
 * Typed shell for the on-chain ERC-8004 identity registry. The card→encryption-key mapping is the
 * open question in ADR-0006 (decision #12): if the registry cannot carry an X25519 key, this adapter
 * falls back to ECIES over the card's secp256k1 key without touching callers.
 */
export class OnchainErc8004Registry implements Erc8004Registry {
  readonly #client: PublicClient<Transport, Chain>;
  readonly #address: `0x${string}`;

  constructor(client: PublicClient<Transport, Chain>, registryAddress: `0x${string}`) {
    this.#client = client;
    this.#address = registryAddress;
  }

  get address(): `0x${string}` {
    return this.#address;
  }

  get chainId(): number {
    return this.#client.chain.id;
  }

  resolveCard(cardId: Bytes32): Promise<GranteeCard | null> {
    return Promise.reject(
      new NotImplementedError("OnchainErc8004Registry.resolveCard", {
        context: { cardId, registry: this.#address },
      }),
    );
  }
}
