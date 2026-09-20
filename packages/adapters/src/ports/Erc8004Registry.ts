import type { Address, Bytes32 } from "@firsthand/core";
import type { Erc8004Addresses } from "../erc8004/addresses.js";

/**
 * ERC-8004 trustless-agent identities (README §5, §7.2). A FIRSTHAND card is what a grant binds
 * to; an ERC-8004 agent that *owns* that card (same key) and names it in its on-chain metadata is
 * what a human sees when the agent asks for access — and what the gateway's paid-query feedback
 * accrues to (README §5 "receipts feed its reputation surface").
 */
export interface AgentView {
  readonly agentId: bigint;
  readonly owner: Address;
  readonly agentURI: string;
  /** Verified receiving wallet, when the agent set one; else null. */
  readonly wallet: Address | null;
  /** `firsthand.card` metadata, when the agent bound a card. */
  readonly cardId: Bytes32 | null;
  /** The registration file, when the URI is a `data:` JSON document (the form FIRSTHAND writes). */
  readonly registration: Record<string, unknown> | null;
}

export interface ReputationSummary {
  readonly count: bigint;
  readonly value: bigint;
  readonly decimals: number;
}

export interface Erc8004Registry {
  /** Null where no registry is deployed (local chains): callers show "unavailable", not an error. */
  readonly addresses: Erc8004Addresses | null;
  agent(agentId: bigint): Promise<AgentView | null>;
  /** The card in a request really belongs to this agent: metadata names it and the agent's owner is the card owner. */
  verifyCardBinding(agentId: bigint, cardId: Bytes32, cardOwner: Address): Promise<boolean>;
  summary(
    agentId: bigint,
    clients?: readonly Address[],
    tag1?: string,
    tag2?: string,
  ): Promise<ReputationSummary>;
}

/** The write side: needs a wallet, because both calls are `msg.sender`-authorised. */
export interface Erc8004Writer {
  registerAgent(input: {
    readonly agentURI: string;
    readonly metadata?: readonly { key: string; value: `0x${string}` }[];
  }): Promise<{ agentId: bigint; txHash: Bytes32 }>;
  giveFeedback(input: {
    readonly agentId: bigint;
    readonly value: bigint;
    readonly decimals?: number;
    readonly tag1: string;
    readonly tag2: string;
    readonly endpoint: string;
    readonly feedbackURI: string;
    readonly feedbackHash: Bytes32;
  }): Promise<Bytes32>;
}
