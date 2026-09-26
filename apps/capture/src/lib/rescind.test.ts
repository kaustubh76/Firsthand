import { describe, expect, it } from "vitest";
import type { PendingRescission } from "./journal.js";
import { commitState, pendingFor } from "./rescind.js";

const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
// `commitBlock` is optional under `exactOptionalPropertyTypes`, so it is a positional argument
// rather than an override: "no block yet" is a state, not an undefined field.
const pending = (
  commitBlock: string | null = "100",
  over: Partial<PendingRescission> = {},
): PendingRescission => ({
  grantId: HASH(1),
  salt: HASH(2),
  commitment: HASH(3),
  commitTx: HASH(4),
  at: 0,
  ...(commitBlock === null ? {} : { commitBlock }),
  ...over,
});

/**
 * The deadline shown on screen has to be the deadline the contract enforces:
 * `GrantManager.revealRescind` reverts `RevealWindowElapsed` when
 * `block.number - commitBlock > revealWindowBlocks` — strictly greater, so the last block of the
 * window is still revealable. A UI that rounded this the other way would tell a principal their
 * consent could not be ended when it could.
 */
describe("commitState", () => {
  it("waits for the commit's block before it can compute anything", () => {
    expect(commitState(pending(null), 200n, 50n)).toEqual({
      kind: "pending",
    });
  });

  it("says nothing it cannot read", () => {
    expect(commitState(pending(), null, 50n)).toEqual({ kind: "unknown" });
    expect(commitState(pending(), 200n, null)).toEqual({ kind: "unknown" });
  });

  it("is revealable from the commit's own block", () => {
    expect(commitState(pending(), 100n, 50n)).toEqual({ kind: "revealable", blocksLeft: 50n });
  });

  it("is revealable on the last block of the window, and not after", () => {
    expect(commitState(pending(), 150n, 50n)).toEqual({ kind: "revealable", blocksLeft: 0n });
    expect(commitState(pending(), 151n, 50n)).toEqual({ kind: "window-elapsed" });
  });

  it("counts down as the head moves", () => {
    expect(commitState(pending(), 130n, 50n)).toEqual({ kind: "revealable", blocksLeft: 20n });
  });

  it("handles the live deployment's window without overflowing into a number", () => {
    const window = 1_512_000n;
    expect(commitState(pending("9007199254740993"), 9_007_199_254_740_994n, window)).toEqual({
      kind: "revealable",
      blocksLeft: window - 1n,
    });
  });
});

describe("pendingFor", () => {
  it("finds a grant's outstanding commit and ignores others", () => {
    const list = [pending(), pending("100", { grantId: HASH(9), commitTx: HASH(10) })];
    expect(pendingFor(list, HASH(9))?.commitTx).toBe(HASH(10));
    expect(pendingFor(list, HASH(77))).toBeNull();
    expect(pendingFor(undefined, HASH(1))).toBeNull();
  });
});
