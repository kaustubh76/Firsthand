import { GrantManagerAbi, PrincipalRegistryAbi, ReceiptLedgerAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, type GrantStatus, ZERO_HASH } from "@firsthand/core";
import { immediatePacer, type Pacer } from "@firsthand/runtime";
import type { Chain, PublicClient, Transport } from "viem";
import type {
  CardView,
  GrantReader,
  GrantView,
  PrincipalLivenessView,
  RegisteredTermsView,
} from "../ports/GrantReader.js";

export interface OnchainGrantReaderOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly grantManager: Address;
  readonly principalRegistry: Address;
  readonly receiptLedger: Address;
  /**
   * Shared scheduler for this endpoint. Defaults to pass-through, so the gateway, anvil and the
   * memory doubles are unaffected; a caller that fans out over a list (the browser reads every
   * grant in a locker) passes one pacer, which bounds `grantState`'s own four-call fan-out too.
   */
  readonly pacer?: Pacer;
}

/** viem reads over GrantManager, PrincipalRegistry and ReceiptLedger. */
export class OnchainGrantReader implements GrantReader {
  readonly #c: PublicClient<Transport, Chain>;
  readonly #o: OnchainGrantReaderOptions;
  readonly #pacer: Pacer;

  constructor(options: OnchainGrantReaderOptions) {
    this.#c = options.publicClient;
    this.#o = options;
    this.#pacer = options.pacer ?? immediatePacer;
  }

  /** Every read in this class goes through here, so one pacer bounds the whole reader. */
  #read<T>(fn: () => Promise<T>): Promise<T> {
    return this.#pacer.run(fn);
  }

  async grantState(grantId: Bytes32): Promise<GrantView | null> {
    const [g, term, principalId, wrapRef] = await Promise.all([
      this.#read(() =>
        this.#c.readContract({
          address: this.#o.grantManager,
          abi: GrantManagerAbi,
          functionName: "grantState",
          args: [grantId],
        }),
      ),
      this.#read(() =>
        this.#c.readContract({
          address: this.#o.grantManager,
          abi: GrantManagerAbi,
          functionName: "termOf",
          args: [grantId],
        }),
      ),
      this.#read(() =>
        this.#c.readContract({
          address: this.#o.grantManager,
          abi: GrantManagerAbi,
          functionName: "principalOf",
          args: [grantId],
        }),
      ),
      this.#read(() =>
        this.#c.readContract({
          address: this.#o.grantManager,
          abi: GrantManagerAbi,
          functionName: "wrapRefOf",
          args: [grantId],
        }),
      ),
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
    const s = await this.#read(() =>
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "effectiveStatus",
        args: [grantId],
      }),
    );
    return s as GrantStatus;
  }

  async termsOf(termsHash: Bytes32): Promise<RegisteredTermsView | null> {
    const t = await this.#read(() =>
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "termsOf",
        args: [termsHash],
      }),
    );
    return t.exists ? { price: t.price, rateLimit: t.rateLimit, ns: t.ns } : null;
  }

  async cardOf(cardId: Bytes32): Promise<CardView | null> {
    const c = await this.#read(() =>
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "cardOf",
        args: [cardId],
      }),
    );
    if (c.owner === `0x${"00".repeat(20)}`) return null;
    return { owner: c.owner.toLowerCase() as Address, encryptionPubKey: c.encryptionPubKey };
  }

  async principalLiveness(principalId: Bytes32): Promise<PrincipalLivenessView | null> {
    const p = await this.#read(() =>
      this.#c.readContract({
        address: this.#o.principalRegistry,
        abi: PrincipalRegistryAbi,
        functionName: "principal",
        args: [principalId],
      }),
    );
    return p.p256KeyCommit === ZERO_HASH
      ? null
      : { lastAttestedEpoch: p.lastAttestedEpoch, thawEpoch: p.thawEpoch };
  }

  isPrincipalLive(principalId: Bytes32): Promise<boolean> {
    return this.#read(() =>
      this.#c.readContract({
        address: this.#o.principalRegistry,
        abi: PrincipalRegistryAbi,
        functionName: "isLive",
        args: [principalId],
      }),
    );
  }

  currentEpoch(): Promise<bigint> {
    return this.#read(() =>
      this.#c.readContract({
        address: this.#o.principalRegistry,
        abi: PrincipalRegistryAbi,
        functionName: "currentEpoch",
      }),
    );
  }

  /**
   * Blocks a commit-reveal rescission has to reveal in before `GrantManager.revealRescind` refuses it
   * with `RevealWindowElapsed`. Not on the `GrantReader` port: serving never asks this, but a client
   * that has committed must show the deadline it is working against.
   */
  revealWindowBlocks(): Promise<bigint> {
    return this.#read(() =>
      this.#c.readContract({
        address: this.#o.grantManager,
        abi: GrantManagerAbi,
        functionName: "revealWindowBlocks",
      }),
    );
  }

  async chainTime(): Promise<bigint> {
    return (await this.#c.getBlock()).timestamp;
  }

  queriesThisEpoch(grantId: Bytes32, epoch: bigint): Promise<number> {
    return this.#read(() =>
      this.#c.readContract({
        address: this.#o.receiptLedger,
        abi: ReceiptLedgerAbi,
        functionName: "queriesThisEpoch",
        args: [grantId, epoch],
      }),
    );
  }
}
