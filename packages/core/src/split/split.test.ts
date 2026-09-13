import { loadVectors } from "@firsthand/test-vectors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { MAX_PRICE, MAX_RECIPIENTS, quoteToUnits, split, validateWeights, WAD } from "./split.js";

const Big = z.string().transform(BigInt);

const SplitInput = z.object({ price: Big, weights: z.array(Big) });
const SplitExpected = z.union([
  z.object({ pays: z.array(Big), residual: Big }),
  z.object({ error: z.string() }),
]);
const QuoteInput = z.object({ quote: z.string(), decimals: z.number() });
const QuoteExpected = z.object({ units: z.string() });

const vectors = loadVectors("split-math", { input: z.unknown(), expected: z.unknown() });

describe("split-math vectors", () => {
  for (const c of vectors.cases) {
    if (c.name.startsWith("quote/")) {
      it(c.name, () => {
        const input = QuoteInput.parse(c.input);
        const expected = QuoteExpected.parse(c.expected);
        expect(quoteToUnits(input.quote, input.decimals).toString()).toBe(expected.units);
      });
      continue;
    }
    it(c.name, () => {
      const input = SplitInput.parse(c.input);
      const expected = SplitExpected.parse(c.expected);
      if ("error" in expected) {
        expect(() => split(input.price, input.weights)).toThrow(ValidationError);
        return;
      }
      const result = split(input.price, input.weights);
      expect(result.pays).toEqual(expected.pays);
      expect(result.residual).toBe(expected.residual);
    });
  }

  it("has hand-derived cases", () => {
    expect(vectors.cases.filter((c) => c.hand).length).toBeGreaterThanOrEqual(3);
  });
});

/** Random WAD composition into 1..MAX_RECIPIENTS parts. */
const weightsArb = fc
  .array(fc.bigInt({ min: 0n, max: WAD }), { minLength: 0, maxLength: MAX_RECIPIENTS - 1 })
  .map((cuts) => {
    const sorted = [...cuts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const weights: bigint[] = [];
    let prev = 0n;
    for (const c of sorted) {
      weights.push(c - prev);
      prev = c;
    }
    weights.push(WAD - prev);
    return weights;
  });

const priceArb = fc.bigInt({ min: 0n, max: MAX_PRICE });

describe("split-math invariants", () => {
  it("never mints nor loses value: Σ pays + residual == price", () => {
    fc.assert(
      fc.property(priceArb, weightsArb, (price, weights) => {
        const { pays, residual } = split(price, weights);
        expect(pays.reduce((a, b) => a + b, 0n) + residual).toBe(price);
      }),
      { numRuns: 2_000 },
    );
  });

  it("bounds the residual by n - 1", () => {
    fc.assert(
      fc.property(priceArb, weightsArb, (price, weights) => {
        const { residual } = split(price, weights);
        expect(residual).toBeLessThanOrEqual(BigInt(weights.length - 1));
        expect(residual).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: 2_000 },
    );
  });

  it("is monotone in price per recipient", () => {
    fc.assert(
      fc.property(
        priceArb,
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        weightsArb,
        (price, delta, weights) => {
          fc.pre(price + delta <= MAX_PRICE);
          const lo = split(price, weights).pays;
          const hi = split(price + delta, weights).pays;
          for (let i = 0; i < lo.length; i++) expect(hi[i]).toBeGreaterThanOrEqual(lo[i] as bigint);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("single full-weight recipient is the identity", () => {
    fc.assert(
      fc.property(priceArb, (price) => {
        expect(split(price, [WAD])).toEqual({ pays: [price], residual: 0n });
      }),
    );
  });
});

describe("split-math validation", () => {
  it("rejects non-bigint or negative prices", () => {
    expect(() => split(-1n, [WAD])).toThrow(ValidationError);
    expect(() => split(1 as unknown as bigint, [WAD])).toThrow(ValidationError);
  });
  it("rejects negative or non-bigint weights", () => {
    expect(() => validateWeights([-1n, WAD + 1n])).toThrow(ValidationError);
    expect(() => validateWeights([1 as unknown as bigint])).toThrow(ValidationError);
  });
  it("exposes MAX_RECIPIENTS", () => {
    expect(MAX_RECIPIENTS).toBe(16);
  });
});

describe("quoteToUnits", () => {
  it("rejects malformed input and bad decimals", () => {
    expect(() => quoteToUnits("1,5")).toThrow(ValidationError);
    expect(() => quoteToUnits("-1")).toThrow(ValidationError);
    expect(() => quoteToUnits("1.0", -1)).toThrow(ValidationError);
    expect(() => quoteToUnits("1.0", 1.5)).toThrow(ValidationError);
  });
  it("uses round-half-to-even at the cut", () => {
    expect(quoteToUnits("2.5", 0)).toBe(2n);
    expect(quoteToUnits("3.5", 0)).toBe(4n);
    expect(quoteToUnits("2.5000001", 0)).toBe(3n);
    expect(quoteToUnits(" 0.1 ")).toBe(100_000n);
  });
});
