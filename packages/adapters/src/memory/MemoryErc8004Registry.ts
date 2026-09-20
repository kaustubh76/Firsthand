import type { Address, Bytes32 } from "@firsthand/core";
import type { Erc8004Addresses } from "../erc8004/addresses.js";
import { decodeAgentURI } from "../erc8004/agentUri.js";
import type {
  AgentView,
  Erc8004Registry,
  Erc8004Writer,
  ReputationSummary,
} from "../ports/Erc8004Registry.js";
import { Recorder } from "./Recorder.js";

export interface MemoryFeedback {
  readonly agentId: bigint;
  readonly client: Address;
  readonly value: bigint;
  readonly decimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly endpoint: string;
  readonly feedbackURI: string;
  readonly feedbackHash: Bytes32;
}

/** In-memory ERC-8004: the same semantics as the registries, for gateway and MCP tests. */
export class MemoryErc8004Registry extends Recorder implements Erc8004Registry, Erc8004Writer {
  readonly addresses: Erc8004Addresses | null;
  readonly agents = new Map<bigint, AgentView>();
  readonly feedback: MemoryFeedback[] = [];
  /** Who `giveFeedback` is called as (the gateway relayer in tests). */
  client: Address = "0x00000000000000000000000000000000000000fe";
  #next = 1n;

  constructor(addresses: Erc8004Addresses | null = null) {
    super();
    this.addresses = addresses;
  }

  /** Mints an agent for `owner` the way `register(uri, metadata)` would. */
  mint(owner: Address, agentURI: string, cardId: Bytes32 | null = null): bigint {
    const agentId = this.#next++;
    this.agents.set(agentId, {
      agentId,
      owner: owner.toLowerCase() as Address,
      agentURI,
      wallet: null,
      cardId,
      registration: decodeAgentURI(agentURI),
    });
    return agentId;
  }

  async agent(agentId: bigint): Promise<AgentView | null> {
    this.record("agent", agentId);
    return this.agents.get(agentId) ?? null;
  }

  async verifyCardBinding(agentId: bigint, cardId: Bytes32, cardOwner: Address): Promise<boolean> {
    const a = this.agents.get(agentId);
    return Boolean(a && a.cardId === cardId.toLowerCase() && a.owner === cardOwner.toLowerCase());
  }

  async summary(
    agentId: bigint,
    clients: readonly Address[] = [],
    tag1 = "",
    tag2 = "",
  ): Promise<ReputationSummary> {
    const rows = this.feedback.filter(
      (f) =>
        f.agentId === agentId &&
        (clients.length === 0 || clients.some((c) => c.toLowerCase() === f.client)) &&
        (tag1 === "" || f.tag1 === tag1) &&
        (tag2 === "" || f.tag2 === tag2),
    );
    return {
      count: BigInt(rows.length),
      value: rows.reduce((acc, f) => acc + f.value, 0n),
      decimals: 0,
    };
  }

  async registerAgent(input: {
    readonly agentURI: string;
    readonly metadata?: readonly { key: string; value: `0x${string}` }[];
  }): Promise<{ agentId: bigint; txHash: Bytes32 }> {
    const card = input.metadata?.find((m) => m.key === "firsthand.card")?.value as
      | Bytes32
      | undefined;
    const agentId = this.mint(this.client, input.agentURI, card ?? null);
    return { agentId, txHash: `0x${agentId.toString(16).padStart(64, "0")}` as Bytes32 };
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
    this.record("giveFeedback", input.agentId);
    this.feedback.push({ ...input, decimals: input.decimals ?? 0, client: this.client });
    return `0x${(this.feedback.length + 0xf000).toString(16).padStart(64, "0")}` as Bytes32;
  }
}
