import type { ReceiptView } from "@firsthand/adapters/client";
import { type Address, LICENSE_FH_1_0, Scope, type Terms, WAD } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { fetchEarnings, ownTerms } from "./earnings.js";

const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const terms = (over: Partial<Terms> = {}): Terms => ({
  price: 1_000n,
  licenseId: LICENSE_FH_1_0,
  scope: Scope.TRAIN,
  ns: 0,
  rateLimit: 100,
  payees: [ADDR(0xaa)],
  weights: [WAD],
  ...over,
});

const receipt = (termsHash: string, n: number): ReceiptView =>
  ({
    receiptId: HASH(n),
    grantId: HASH(0x99),
    payer: ADDR(0xbb),
    ns: 0,
    termsHash,
    epoch: 1n,
    blockNumber: BigInt(n),
    txHash: HASH(n),
  }) as ReceiptView;

const reader = (prices: Record<string, bigint>) => ({
  termsOf: async (h: string) => (prices[h] === undefined ? null : { price: prices[h] as bigint }),
});

describe("fetchEarnings", () => {
  it("prices each receipt from the chain, not from this app's constant", async () => {
    const mine = terms();
    const own = ownTerms([mine]);
    const [hash] = [...own.keys()];
    // The chain says 2500, the app's own terms say 1000. The chain wins: the buyer paid what the
    // registered terms said at settlement, which is the only number a receipt attests to.
    const e = await fetchEarnings(
      [receipt(hash as string, 1), receipt(hash as string, 2)],
      reader({ [hash as string]: 2_500n }),
      own,
    );
    expect(e.count).toBe(2);
    expect(e.settled).toBe(5_000n);
    expect(e.yours).toBe(5_000n);
    expect(e.unattributed).toBe(0);
  });

  it("splits by the terms' weights rather than assuming the whole price", async () => {
    const shared = terms({
      payees: [ADDR(0xaa), ADDR(0xcc)],
      weights: [WAD / 4n, (WAD * 3n) / 4n],
    });
    const own = ownTerms([shared]);
    const [hash] = [...own.keys()];
    const e = await fetchEarnings(
      [receipt(hash as string, 1)],
      reader({ [hash as string]: 1_000n }),
      own,
    );
    expect(e.settled).toBe(1_000n);
    expect(e.yours).toBe(250n);
  });

  it("counts what it cannot price instead of guessing", async () => {
    const own = ownTerms([terms()]);
    const [hash] = [...own.keys()];
    // Terms the chain has never seen, and terms this browser never issued: both unattributable.
    const e = await fetchEarnings(
      [receipt(hash as string, 1), receipt(HASH(0xdead), 2)],
      reader({}),
      own,
    );
    expect(e.settled).toBe(0n);
    expect(e.yours).toBe(0n);
    expect(e.unattributed).toBe(2);
    expect(e.count).toBe(2);
  });

  it("reads each distinct terms hash once, however many receipts share it", async () => {
    const own = ownTerms([terms()]);
    const [hash] = [...own.keys()];
    let calls = 0;
    const counting = {
      termsOf: async (h: string) => {
        calls += 1;
        return h === hash ? { price: 1_000n } : null;
      },
    };
    await fetchEarnings(
      [receipt(hash as string, 1), receipt(hash as string, 2), receipt(hash as string, 3)],
      counting,
      own,
    );
    expect(calls).toBe(1);
  });
});
