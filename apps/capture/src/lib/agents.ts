import type { Bytes32 } from "@firsthand/core";

/** The gateway's view of an ERC-8004 agent: identity, bound card, and what this venue said about it. */
export interface AgentInfo {
  readonly agentId: string;
  readonly owner: string;
  readonly cardId: Bytes32 | null;
  readonly name: string | null;
  readonly reputation: { paidQueriesHere: string; firsthandFeedbackAll: string };
  readonly registries: { identityRegistry: string; reputationRegistry: string } | null;
}

export async function fetchAgent(gatewayUrl: string, agentId: string): Promise<AgentInfo | null> {
  const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/agents/${agentId}`);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    agentId: string;
    owner: string;
    cardId: Bytes32 | null;
    registration: { name?: unknown } | null;
    reputation: { paidQueriesHere: string; firsthandFeedbackAll: string };
    registries: { identityRegistry: string; reputationRegistry: string } | null;
  };
  return {
    agentId: body.agentId,
    owner: body.owner,
    cardId: body.cardId,
    name: typeof body.registration?.name === "string" ? body.registration.name : null,
    reputation: body.reputation,
    registries: body.registries,
  };
}

/** The binding a human relies on: the agent names this card, and the agent's owner is the card owner. */
export function bindingHolds(
  info: AgentInfo | null,
  card: Bytes32,
  cardOwner: string | null,
): boolean {
  if (!info?.cardId) return false;
  if (info.cardId.toLowerCase() !== card.toLowerCase()) return false;
  return cardOwner === null ? true : info.owner.toLowerCase() === cardOwner.toLowerCase();
}
