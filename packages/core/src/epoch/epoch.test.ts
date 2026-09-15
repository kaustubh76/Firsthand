import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_EPOCH_LENGTH,
  epochAt,
  epochEnd,
  epochStart,
  isWithinGrace,
  thawEpochAfterGap,
} from "./epoch.js";

const params = { genesis: 1_000n, length: DEFAULT_EPOCH_LENGTH };

describe("epoch", () => {
  it("counts fixed-length windows from genesis", () => {
    expect(epochAt(1_000n, params)).toBe(0n);
    expect(epochAt(1_000n + DEFAULT_EPOCH_LENGTH - 1n, params)).toBe(0n);
    expect(epochAt(1_000n + DEFAULT_EPOCH_LENGTH, params)).toBe(1n);
    expect(epochStart(3n, params)).toBe(1_000n + 3n * DEFAULT_EPOCH_LENGTH);
    expect(epochEnd(3n, params)).toBe(epochStart(4n, params) - 1n);
  });
  it("rejects pre-genesis timestamps, non-positive lengths and negative epochs", () => {
    expect(() => epochAt(999n, params)).toThrow(ValidationError);
    expect(() => epochAt(1_000n, { genesis: 0n, length: 0n })).toThrow(ValidationError);
    expect(() => epochStart(-1n, params)).toThrow(ValidationError);
  });
  it("start/end bracket every timestamp of the epoch", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 1n << 40n }), (ts) => {
        const e = epochAt(ts, params);
        expect(epochStart(e, params) <= ts && ts <= epochEnd(e, params)).toBe(true);
      }),
    );
  });
  it("liveness grace is inclusive", () => {
    expect(isWithinGrace(10n, 8n)).toBe(true);
    expect(isWithinGrace(11n, 8n)).toBe(false);
    expect(isWithinGrace(11n, 8n, 3n)).toBe(true);
  });
  it("schedules a thaw one boundary after a gap attest, none within grace (§7.6)", () => {
    expect(thawEpochAfterGap(7n, 5n)).toBeNull(); // 7 == 5 + grace
    expect(thawEpochAfterGap(8n, 5n)).toBe(9n);
    expect(thawEpochAfterGap(8n, 5n, 3n)).toBeNull();
    expect(thawEpochAfterGap(20n, 5n)).toBe(21n);
  });
});
