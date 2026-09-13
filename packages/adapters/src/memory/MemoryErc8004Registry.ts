import type { Bytes32, GranteeCard } from "@firsthand/core";
import type { Erc8004Registry } from "../ports/Erc8004Registry.js";
import { Recorder } from "./Recorder.js";

export class MemoryErc8004Registry extends Recorder implements Erc8004Registry {
  readonly #cards = new Map<Bytes32, GranteeCard>();

  register(card: GranteeCard): void {
    this.#cards.set(card.cardId, card);
  }

  deactivate(cardId: Bytes32): void {
    const card = this.#cards.get(cardId);
    if (card) this.#cards.set(cardId, { ...card, active: false });
  }

  async resolveCard(cardId: Bytes32): Promise<GranteeCard | null> {
    this.record("resolveCard", cardId);
    return this.#cards.get(cardId) ?? null;
  }
}
