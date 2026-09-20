/**
 * Freshness (README §7.3, §20 "why query #2 gets paid"): interaction data is a stream, and a
 * namespace's *staleness* since its last deposit is `s(t) = 1 − 2^(−t/τ)` with a half-life `τ`
 * published per namespace. It is a market signal computed off-chain from on-chain anchor
 * timestamps — a buyer prices continuing access against it; the protocol enforces nothing with it,
 * and says so (README §14).
 */

/** Default half-life: one epoch. A namespace that saw no deposit for a week reads 0.5. */
export const DEFAULT_HALF_LIFE_SECONDS = 7n * 24n * 3600n;

export interface Freshness {
  /** Unix seconds of the newest anchor in the namespace; null when nothing is anchored. */
  readonly lastAnchoredAt: bigint | null;
  readonly halfLifeSeconds: bigint;
  /** `1 − 2^(−Δt/τ)` in [0, 1); 1 when nothing was ever anchored. Rounded to 4 places. */
  readonly staleness: number;
}

export function staleness(
  lastAnchoredAt: bigint | null,
  now: bigint,
  halfLifeSeconds: bigint = DEFAULT_HALF_LIFE_SECONDS,
): number {
  if (lastAnchoredAt === null) return 1;
  if (halfLifeSeconds <= 0n) return lastAnchoredAt < now ? 1 : 0;
  const elapsed = now > lastAnchoredAt ? now - lastAnchoredAt : 0n;
  const s = 1 - 2 ** -(Number(elapsed) / Number(halfLifeSeconds));
  return Math.round(s * 10_000) / 10_000;
}

export function freshnessOf(
  lastAnchoredAt: bigint | null,
  now: bigint,
  halfLifeSeconds: bigint = DEFAULT_HALF_LIFE_SECONDS,
): Freshness {
  return {
    lastAnchoredAt,
    halfLifeSeconds,
    staleness: staleness(lastAnchoredAt, now, halfLifeSeconds),
  };
}
