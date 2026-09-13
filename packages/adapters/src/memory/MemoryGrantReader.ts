import {
  type Address,
  type Bytes32,
  cardIdOf,
  effectiveGrantStatus,
  GrantStatus,
  grantIdOf,
  hashTerms,
  LIVENESS_GRACE_EPOCHS,
  type Terms,
} from "@firsthand/core";
import type {
  CardView,
  GrantReader,
  GrantView,
  RegisteredTermsView,
} from "../ports/GrantReader.js";
import { Recorder } from "./Recorder.js";

export interface MemoryGrantInput {
  readonly principalId: Bytes32;
  readonly granteeCard: Bytes32;
  readonly ns: number;
  readonly epochStart?: bigint;
  readonly term?: bigint;
  readonly termsHash: Bytes32;
  readonly wrapRef: Bytes32;
}

/**
 * In-memory twin of GrantManager + the registry's liveness, following the contract's rules: cards are
 * commitments, terms are registered by preimage, grants derive EXPIRED/FROZEN lazily.
 */
export class MemoryGrantReader extends Recorder implements GrantReader {
  readonly #cards = new Map<Bytes32, CardView>();
  readonly #terms = new Map<Bytes32, RegisteredTermsView>();
  readonly #accepted = new Set<string>();
  readonly #grants = new Map<Bytes32, GrantView>();
  readonly #principals = new Map<Bytes32, bigint>();
  readonly #queries = new Map<string, number>();
  #epoch: bigint;
  readonly grace: bigint;

  constructor(options: { epoch?: bigint; grace?: bigint } = {}) {
    super();
    this.#epoch = options.epoch ?? 0n;
    this.grace = options.grace ?? LIVENESS_GRACE_EPOCHS;
  }

  // ── state helpers (what the contract's mutations would do) ────────────────────────────────────

  setEpoch(epoch: bigint): void {
    this.#epoch = epoch;
  }

  enroll(principalId: Bytes32, lastAttestedEpoch: bigint = this.#epoch): void {
    this.#principals.set(principalId, lastAttestedEpoch);
  }

  attest(principalId: Bytes32, epoch: bigint = this.#epoch): void {
    this.#principals.set(principalId, epoch);
  }

  registerCard(owner: Address, encryptionPubKey: Bytes32): Bytes32 {
    const id = cardIdOf(owner, encryptionPubKey);
    this.#cards.set(id, { owner, encryptionPubKey });
    return id;
  }

  acceptTerms(granteeCard: Bytes32, principalId: Bytes32, terms: Terms): Bytes32 {
    const termsHash = hashTerms(terms);
    if (!this.#terms.has(termsHash)) {
      this.#terms.set(termsHash, { price: terms.price, rateLimit: terms.rateLimit, ns: terms.ns });
    }
    this.#accepted.add(`${granteeCard}:${principalId}:${terms.ns}:${termsHash}`);
    return termsHash;
  }

  grant(input: MemoryGrantInput): Bytes32 {
    const epochStart = input.epochStart ?? this.#epoch;
    const id = grantIdOf(input.principalId, input.granteeCard, input.ns, epochStart);
    if (
      !this.#accepted.has(
        `${input.granteeCard}:${input.principalId}:${input.ns}:${input.termsHash}`,
      )
    ) {
      throw new Error("MemoryGrantReader.grant: terms not accepted by that card");
    }
    this.#grants.set(id, {
      granteeCard: input.granteeCard,
      ns: input.ns,
      epochStart,
      epochEnd: 0n,
      termsHash: input.termsHash,
      status: GrantStatus.ACTIVE,
      term: input.term ?? 8n,
      principalId: input.principalId,
      wrapRef: input.wrapRef,
    });
    return id;
  }

  rescind(grantId: Bytes32): void {
    const g = this.#grants.get(grantId);
    if (!g) throw new Error("MemoryGrantReader.rescind: unknown grant");
    this.#grants.set(grantId, { ...g, status: GrantStatus.RESCINDED, epochEnd: this.#epoch });
  }

  /** Called by MemorySettlement to mirror ReceiptLedger's counter. */
  countQuery(grantId: Bytes32, epoch: bigint): number {
    const key = `${grantId}:${epoch}`;
    const next = (this.#queries.get(key) ?? 0) + 1;
    this.#queries.set(key, next);
    return next;
  }

  // ── port ─────────────────────────────────────────────────────────────────────────────────────

  async grantState(grantId: Bytes32): Promise<GrantView | null> {
    this.record("grantState", grantId);
    return this.#grants.get(grantId) ?? null;
  }

  async effectiveStatus(grantId: Bytes32): Promise<GrantStatus> {
    this.record("effectiveStatus", grantId);
    const g = this.#grants.get(grantId);
    if (!g) return GrantStatus.NONE;
    const last = this.#principals.get(g.principalId);
    return effectiveGrantStatus(g, { lastAttestedEpoch: last ?? -1n }, this.#epoch, {
      grace: this.grace,
    });
  }

  async termsOf(termsHash: Bytes32): Promise<RegisteredTermsView | null> {
    this.record("termsOf", termsHash);
    return this.#terms.get(termsHash) ?? null;
  }

  async cardOf(cardId: Bytes32): Promise<CardView | null> {
    this.record("cardOf", cardId);
    return this.#cards.get(cardId) ?? null;
  }

  async principalLastAttested(principalId: Bytes32): Promise<bigint | null> {
    this.record("principalLastAttested", principalId);
    return this.#principals.get(principalId) ?? null;
  }

  async isPrincipalLive(principalId: Bytes32): Promise<boolean> {
    this.record("isPrincipalLive", principalId);
    const last = this.#principals.get(principalId);
    return last !== undefined && this.#epoch <= last + this.grace;
  }

  async currentEpoch(): Promise<bigint> {
    this.record("currentEpoch");
    return this.#epoch;
  }

  async chainTime(): Promise<bigint> {
    this.record("chainTime");
    return BigInt(Math.floor(Date.now() / 1000));
  }

  async queriesThisEpoch(grantId: Bytes32, epoch: bigint): Promise<number> {
    this.record("queriesThisEpoch", grantId, epoch);
    return this.#queries.get(`${grantId}:${epoch}`) ?? 0;
  }
}
