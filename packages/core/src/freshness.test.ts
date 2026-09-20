import { describe, expect, it } from "vitest";
import { DEFAULT_HALF_LIFE_SECONDS, freshnessOf, staleness } from "./freshness.js";

describe("freshness — s(t) = 1 − 2^(−t/τ), README §7.3", () => {
  const τ = DEFAULT_HALF_LIFE_SECONDS;
  it("is 0 at the moment of the last deposit, 0.5 one half-life later, and tends to 1", () => {
    expect(staleness(1_000n, 1_000n)).toBe(0);
    expect(staleness(1_000n, 1_000n + τ)).toBe(0.5);
    expect(staleness(1_000n, 1_000n + 2n * τ)).toBe(0.75);
    expect(staleness(1_000n, 1_000n + 20n * τ)).toBeGreaterThan(0.999);
  });

  it("reads 1 for a namespace with nothing anchored, and 0 for a clock that runs behind the chain", () => {
    expect(staleness(null, 5n)).toBe(1);
    expect(staleness(9_000n, 1_000n)).toBe(0);
  });

  it("honours a namespace's own half-life, and degenerates sanely at τ = 0", () => {
    expect(staleness(0n, 3_600n, 3_600n)).toBe(0.5);
    expect(staleness(0n, 1n, 0n)).toBe(1);
    expect(staleness(5n, 5n, 0n)).toBe(0);
    expect(freshnessOf(100n, 100n + τ)).toEqual({
      lastAnchoredAt: 100n,
      halfLifeSeconds: τ,
      staleness: 0.5,
    });
  });
});
