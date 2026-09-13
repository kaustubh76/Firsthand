import { MAX_PRICE, MAX_RECIPIENTS, USDC_DECIMALS, WAD } from "../constants.js";
import { ValidationError } from "../errors.js";

export { MAX_PRICE, MAX_RECIPIENTS, WAD } from "../constants.js";

/**
 * Integer-exact royalty split (README §7.3, ADR-0003).
 *
 *   pay_i    = floor(price * w_i / WAD)
 *   residual = price - Σ pay_i          (→ protocol dust pool)
 *
 * Invariants, fuzz-tested here and in `contracts/test`:
 *   Σ pay_i + residual == price     (value is never minted nor lost)
 *   residual <= n - 1               (bounded by recipient count)
 *   weights == [WAD]  ⇒  pays == [price], residual == 0
 */
export interface SplitResult {
  readonly pays: readonly bigint[];
  readonly residual: bigint;
}

/** Throws `ValidationError` unless `weights` is a valid WAD-scaled distribution. */
export function validateWeights(weights: readonly bigint[]): void {
  if (weights.length === 0) {
    throw new ValidationError("split: no recipients");
  }
  if (weights.length > MAX_RECIPIENTS) {
    throw new ValidationError(
      `split: too many recipients (${weights.length} > ${MAX_RECIPIENTS})`,
      {
        context: { recipients: weights.length },
      },
    );
  }
  let sum = 0n;
  for (const w of weights) {
    if (typeof w !== "bigint" || w < 0n) {
      throw new ValidationError("split: weights must be non-negative bigints");
    }
    sum += w;
  }
  if (sum !== WAD) {
    throw new ValidationError(`split: weights must sum to WAD, got ${sum}`, {
      context: { sum: sum.toString() },
    });
  }
}

export function split(price: bigint, weights: readonly bigint[]): SplitResult {
  if (typeof price !== "bigint" || price < 0n) {
    throw new ValidationError("split: price must be a non-negative bigint");
  }
  if (price > MAX_PRICE) {
    throw new ValidationError(`split: price too large (${price} > ${MAX_PRICE})`, {
      context: { price: price.toString() },
    });
  }
  validateWeights(weights);

  const pays = new Array<bigint>(weights.length);
  let paid = 0n;
  for (let i = 0; i < weights.length; i++) {
    const pay = (price * (weights[i] as bigint)) / WAD;
    pays[i] = pay;
    paid += pay;
  }
  return { pays, residual: price - paid };
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts a decimal quote string (e.g. `"1.2345678"`) to integer base units using
 * **round-half-to-even** at the cut. This is the only place banker's rounding exists in
 * FIRSTHAND: it happens off-chain, before a price ever reaches the split (ADR-0003).
 */
export function quoteToUnits(quote: string, decimals: number = USDC_DECIMALS): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new ValidationError(`quoteToUnits: invalid decimals ${decimals}`);
  }
  const match = DECIMAL_RE.exec(quote.trim());
  if (match === null) {
    throw new ValidationError(`quoteToUnits: not a non-negative decimal: ${JSON.stringify(quote)}`);
  }
  const intPart = match[1] as string;
  const fracPart = match[2] ?? "";

  const kept = fracPart.slice(0, decimals).padEnd(decimals, "0");
  const dropped = fracPart.slice(decimals);
  let units = BigInt(intPart + kept);

  if (dropped.length > 0) {
    const first = dropped.charCodeAt(0) - 48;
    const restNonZero = /[1-9]/.test(dropped.slice(1));
    const roundUp =
      first > 5 ||
      (first === 5 && restNonZero) ||
      (first === 5 && !restNonZero && units % 2n === 1n);
    if (roundUp) units += 1n;
  }
  return units;
}
