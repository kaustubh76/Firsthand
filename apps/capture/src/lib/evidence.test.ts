import { describe, expect, it } from "vitest";
import { h1, h2, h3, s2Cards, s4Card, s5Card } from "./evidence.js";

/** The screen must say what experiments/README.md says — same files, same numbers. */
describe("evidence reduction", () => {
  it("H1: the sign flips between a vanilla EVM and Monad", () => {
    const { rows, verdict } = h1();
    const evm = rows.find((r) => r.chain.startsWith("anvil"));
    const monad = rows.find((r) => r.chain.startsWith("Monad"));
    expect(evm?.baselinePerBatch).toBe(168_109);
    expect(monad?.baselinePerBatch).toBeCloseTo(200_858, 0);
    expect(evm?.deltaPct ?? 0).toBeGreaterThan(0);
    expect(monad?.deltaPct ?? 0).toBeLessThan(0);
    expect(verdict).toMatch(/sign flips/);
  });

  it("H2: the public mempool race is won, BTX is marked not measurable", () => {
    const { rows, trialsPerArm } = h2();
    expect(trialsPerArm).toBe(50);
    expect(rows.find((r) => r.arm === "B2-public-mempool")?.success).toBe(0.98);
    expect(rows.find((r) => r.arm === "commit-reveal")?.success).toBe(1);
    expect(rows.find((r) => r.arm === "btx")?.note).toMatch(/not measurable/);
  });

  it("H3: Merkle-only under 2 s for 10k assets, full re-proof reported as the regression", () => {
    const c = h3();
    expect(c.passports).toBe(10_000);
    expect(c.merkleMs ?? 0).toBeLessThan(2_000);
    expect(c.fullMs ?? 0).toBeGreaterThan(30_000);
    expect(c.hashesPerAsset).toBe(8);
    expect(c.verdict).toMatch(/regression/);
  });

  it("S2 and S4 carry the on-chain runs with their chain", () => {
    const s2 = s2Cards();
    expect(s2[0]?.chain).toMatch(/Monad/);
    expect(s2[0]?.settleGas).toBe(348_087);
    expect(s2.every((c) => c.refusedAfterRescind && c.manifestVerified)).toBe(true);
    const s4 = s4Card();
    expect(s4).toMatchObject({
      injected: 200,
      refused: 200,
      precision: 1,
      recall: 1,
      forged: 20,
      forgedRefused: 20,
    });
  });

  it("S5 refuses every transplanted witness and admits every genuine one", () => {
    const s5 = s5Card();
    expect(s5).toMatchObject({
      deposits: 500,
      admitted: 500,
      injected: 2_000,
      refused: 2_000,
      refusalRate: 1,
    });
    // A rate of 1 over zero attacks would also read as 1. Four attacks per deposit, by
    // construction, is what makes the ratio mean something.
    expect(s5?.injected).toBe((s5?.deposits ?? 0) * 4);
    // The memory arm is the honest one here; a "Monad" label on this number would be a claim the
    // scenario did not make.
    expect(s5?.chain).not.toMatch(/Monad/);
  });
});

describe("H2 says where it ran", () => {
  it("names the local anvil venue rather than letting Monad be inferred", () => {
    // This card sits between an H1 and an S2 card that both read "Monad testnet (10143)". Its arms
    // ran on anvil, because Monad exposes no global mempool for a bot to watch.
    expect(h2().chain).toMatch(/anvil/);
    expect(h2().chain).not.toMatch(/Monad/);
  });

  it("carries the finding experiments/README.md draws, not just the failed claim", () => {
    expect(h2().verdict).toMatch(/no targeted burst at zero idle cost/);
    expect(h2().verdict).toMatch(/not "the race never starts"/);
    expect(h2().verdict).toMatch(/priority fee.*not yet measured/);
  });
});
