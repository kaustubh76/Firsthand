import type { ReceiptView } from "@firsthand/adapters/client";
import { type Bytes32, hashTerms, split, type Terms } from "@firsthand/core";

/**
 * What the locker actually earned, derived from the chain rather than from a constant.
 *
 * This used to be `receiptCount × PRICE_UNITS` — the app's own hard-coded price multiplied by a
 * real receipt count — under a card that said "the RoyaltyRouter splits the price to your deposit
 * key at settlement". Both halves of that sentence were unbacked: the price came from
 * `lib/terms.ts`, not from the terms the buyer actually paid under, and no split was ever computed.
 * It happened to be right only because every terms this app issues has one payee at WAD.
 *
 * Now: the price of each receipt's terms is read from `GrantManager.termsOf` — the registered
 * preimage the settlement was checked against — and the principal's share is `split()` from
 * `@firsthand/core`, the same floor-and-dust arithmetic `SplitMath` runs on chain (ADR-0003). A
 * receipt under terms this browser cannot price or attribute is counted and named, never guessed.
 */
export interface EarningsRow {
  readonly tx: string;
  readonly grantId: string;
  readonly block: bigint;
}

export interface Earnings {
  readonly count: number;
  /** Sum of the on-chain price of every receipt's terms — what buyers paid. */
  readonly settled: bigint;
  /** The principal's share of that, by the terms' own weights. */
  readonly yours: bigint;
  /** Receipts whose terms the chain did not know, or whose payees this browser cannot name. */
  readonly unattributed: number;
  readonly rows: readonly EarningsRow[];
}

export interface TermsReader {
  termsOf(termsHash: Bytes32): Promise<{ readonly price: bigint } | null>;
}

/**
 * `own` maps a terms hash to the preimage this browser issued, which is where the payees and
 * weights come from: the chain registers only price, rate limit and namespace.
 */
export async function fetchEarnings(
  receipts: readonly ReceiptView[],
  reader: TermsReader,
  own: ReadonlyMap<Bytes32, { terms: Terms; payee: string }>,
): Promise<Earnings> {
  const prices = new Map<Bytes32, bigint | null>();
  let settled = 0n;
  let yours = 0n;
  let unattributed = 0;

  for (const r of receipts) {
    if (!prices.has(r.termsHash)) {
      prices.set(r.termsHash, (await reader.termsOf(r.termsHash).catch(() => null))?.price ?? null);
    }
    const price = prices.get(r.termsHash) ?? null;
    const mine = own.get(r.termsHash);
    if (price === null || mine === undefined) {
      unattributed += 1;
      continue;
    }
    settled += price;
    const i = mine.terms.payees.findIndex((p) => p.toLowerCase() === mine.payee.toLowerCase());
    yours += i === -1 ? 0n : (split(price, mine.terms.weights).pays[i] ?? 0n);
  }

  return {
    count: receipts.length,
    settled,
    yours,
    unattributed,
    rows: receipts.map((r) => ({
      tx: r.txHash,
      grantId: r.grantId,
      block: r.blockNumber,
    })),
  };
}

/** The terms this browser offers, by hash — what lets a receipt be attributed to a payee. */
export function ownTerms(
  termsByNs: readonly Terms[],
): ReadonlyMap<Bytes32, { terms: Terms; payee: string }> {
  const out = new Map<Bytes32, { terms: Terms; payee: string }>();
  for (const terms of termsByNs) {
    const payee = terms.payees[0];
    if (payee !== undefined) out.set(hashTerms(terms), { terms, payee });
  }
  return out;
}
