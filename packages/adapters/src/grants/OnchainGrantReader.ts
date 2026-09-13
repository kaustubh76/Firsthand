import { GrantManagerAbi, PrincipalRegistryAbi, ReceiptLedgerAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, type GrantStatus, ZERO_HASH } from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";
import type {
  CardView,
  GrantReader,
  GrantView,
  RegisteredTermsView,
} from "../ports/GrantReader.js";

export interface OnchainGrantReaderOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly grantManager: Address;
  readonly principalRegistry: Address;
  readonly receiptLedger: Address;
}

/** viem reads over GrantManager, PrincipalRegistry and ReceiptLedger. */
export class OnchainGrantReader implements GrantReader {
  readonly #c: PublicClient<Transport, Chain>;
  readonly #o: OnchainGrantReaderOptions;

  constructor(options: OnchainGrantReaderOptions) {
    this.#c = options.publicClient;
    this.#o = options;
  }

  async grantState(grantId: Bytes32): Promise<GrantView | null> {
    const [g, term, principalId, wrapRef] = await Promise.all([
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "grantState",
        args: [grantId],
      }),
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "termOf",
        args: [grantId],
      }),
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "principalOf",
        args: [grantId],
      }),
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "wrapRefOf",
        args: [grantId],
      }),
    ]);
    if (g.status === 0) return null;
    return {
      granteeCard: g.granteeCard,
      ns: g.ns,
      epochStart: g.epochStart,
      epochEnd: g.epochEnd,
      termsHash: g.termsHash,
      status: g.status as GrantStatus,
      term,
      principalId,
      wrapRef,
    };
  }

  async effectiveStatus(grantId: Bytes32): Promise<GrantStatus> {
    const s = await this.#c.readContract({
      address: this.#o.grantManager,
      abi: GrantManagerAbi,
      functionName: "effectiveStatus",
      args: [grantId],
    });
    return s as GrantStatus;
  }

  async termsOf(termsHash: Bytes32): Promise<RegisteredTermsView | null> {
    const t = await this.#c.readContract({
      address: this.#o.grantManager,
      abi: GrantManagerAbi,
      functionName: "termsOf",
      args: [termsHash],
    });
    return t.exists ? { price: t.price, rateLimit: t.rateLimit, ns: t.ns } : null;
  }

  async cardOf(cardId: Bytes32): Promise<CardView | null> {
    const c = await this.#c.readContract({
      address: this.#o.grantManager,
      abi: GrantManagerAbi,
      functionName: "cardOf",
      args: [cardId],
    });
    if (c.owner === `0x${"00".repeat(20)}`) return null;
    return { owner: c.owner.toLowerCase() as Address, encryptionPubKey: c.encryptionPubKey };
  }

  async principalLastAttested(principalId: Bytes32): Promise<bigint | null> {
    const p = await this.#c.readContract({
      address: this.#o.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "principal",
      args: [principalId],
    });
    return p.p256KeyCommit === ZERO_HASH ? null : p.lastAttestedEpoch;
  }

  isPrincipalLive(principalId: Bytes32): Promise<boolean> {
    return this.#c.readContract({
      address: this.#o.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "isLive",
      args: [principalId],
    });
  }

  currentEpoch(): Promise<bigint> {
    return this.#c.readContract({
      address: this.#o.principalRegistry,
      abi: PrincipalRegistryAbi,
      functionName: "currentEpoch",
    });
  }

  async chainTime(): Promise<bigint> {
    return (await this.#c.getBlock()).timestamp;
  }

  queriesThisEpoch(grantId: Bytes32, epoch: bigint): Promise<number> {
    return this.#c.readContract({
      address: this.#o.receiptLedger,
      abi: ReceiptLedgerAbi,
      functionName: "queriesThisEpoch",
      args: [grantId, epoch],
    });
  }
}
