import { immediatePacer, type OnchainLensReader } from "@firsthand/adapters/client";
import type { LineageManifest } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { askLens, describeLens } from "./lens.js";

const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const asset = (h: number, grantId?: number) =>
  ({
    signed: { passport: { h: HASH(h) }, signature: "0x" },
    batchRoot: HASH(0xb),
    proof: { index: 0, siblings: [] },
    anchorBlock: 1n,
    ...(grantId === undefined
      ? {}
      : {
          receipt: {
            receiptId: HASH(0xa0),
            grantId: HASH(grantId),
            blockNumber: 1n,
            txHash: HASH(1),
          },
        }),
  }) as unknown as LineageManifest["assets"][number];

const manifest = (assets: LineageManifest["assets"]) => ({ assets }) as LineageManifest;

const fakeLens = (answer: (grantId: string) => { ok: boolean; reason: string }) =>
  ({
    address: HASH(0x1e).slice(0, 42),
    verify: async (_subject: unknown, grantId: string) => answer(grantId),
  }) as unknown as OnchainLensReader;

describe("askLens", () => {
  it("asks only about assets that name a grant", async () => {
    const report = await askLens(
      fakeLens(() => ({ ok: true, reason: "NONE" })),
      manifest([asset(1, 0x99), asset(2)]),
      immediatePacer,
    );
    expect(report.rows).toHaveLength(1);
    expect(report.unasked).toBe(1);
    expect(report.standing).toBe(1);
  });

  it("reports a rescinded grant as the chain words it", async () => {
    const report = await askLens(
      fakeLens(() => ({ ok: false, reason: "GRANT_RESCINDED" })),
      manifest([asset(1, 0x99)]),
      immediatePacer,
    );
    expect(report.rows[0]).toMatchObject({ ok: false, reason: "GRANT_RESCINDED" });
    expect(report.standing).toBe(0);
    expect(describeLens(report)).toMatch(/0 of 1 grant\(s\) would still be served · 1 refused/);
  });

  it("calls a failed read a failed read, never a refusal", async () => {
    const report = await askLens(
      {
        address: "0x00",
        verify: () => Promise.reject(new Error("rpc down")),
      } as unknown as OnchainLensReader,
      manifest([asset(1, 0x99)]),
      immediatePacer,
    );
    expect(report.rows[0]?.ok).toBe(false);
    expect(report.rows[0]?.reason).toMatch(/^unreadable: rpc down/);
  });

  it("says nothing at all when there is nothing to say", async () => {
    expect(describeLens(null)).toBeNull();
    const empty = await askLens(
      fakeLens(() => ({ ok: true, reason: "NONE" })),
      manifest([]),
      immediatePacer,
    );
    expect(describeLens(empty)).toBeNull();
  });
});
