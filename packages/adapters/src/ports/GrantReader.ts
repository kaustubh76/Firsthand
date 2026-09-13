import type { Address, Bytes32, GrantStatus } from "@firsthand/core";

/** Read model over GrantManager + PrincipalRegistry state, as the serving path needs it. */
export interface GrantView {
  readonly granteeCard: Bytes32;
  readonly ns: number;
  readonly epochStart: bigint;
  readonly epochEnd: bigint;
  readonly termsHash: Bytes32;
  /** Stored status (ACTIVE or RESCINDED); use `effectiveStatus` for the lazy one. */
  readonly status: GrantStatus;
  readonly term: bigint;
  readonly principalId: Bytes32;
  readonly wrapRef: Bytes32;
}

export interface RegisteredTermsView {
  readonly price: bigint;
  readonly rateLimit: number;
  readonly ns: number;
}

export interface CardView {
  readonly owner: Address;
  readonly encryptionPubKey: Bytes32;
}

export interface GrantReader {
  grantState(grantId: Bytes32): Promise<GrantView | null>;
  effectiveStatus(grantId: Bytes32): Promise<GrantStatus>;
  termsOf(termsHash: Bytes32): Promise<RegisteredTermsView | null>;
  cardOf(cardId: Bytes32): Promise<CardView | null>;
  principalLastAttested(principalId: Bytes32): Promise<bigint | null>;
  isPrincipalLive(principalId: Bytes32): Promise<boolean>;
  currentEpoch(): Promise<bigint>;
  /** Latest block timestamp (unix seconds) — what EIP-3009 validity windows are judged against. */
  chainTime(): Promise<bigint>;
  queriesThisEpoch(grantId: Bytes32, epoch: bigint): Promise<number>;
}
