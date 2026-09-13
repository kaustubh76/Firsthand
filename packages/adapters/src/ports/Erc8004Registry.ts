import type { Bytes32, GranteeCard } from "@firsthand/core";

/**
 * ERC-8004 trustless-agent cards (README §5, §7.2). A grant binds to a card; the card publishes the
 * X25519 encryption key that vault keys are wrapped to (decision #12).
 */
export interface Erc8004Registry {
  resolveCard(cardId: Bytes32): Promise<GranteeCard | null>;
}
