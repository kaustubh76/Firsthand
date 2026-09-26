import { LIVENESS_GRACE_EPOCHS } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { canAnchor, canGrant, describeLiveness, type Liveness, livenessOf } from "./liveness.js";

/**
 * The boundaries, against the contract's rule rather than against the previous implementation's.
 * `PrincipalRegistry.effectiveStatus` is FROZEN while a scheduled thaw has not arrived and otherwise
 * `withinGrace(now, lastAttested, 2)`, so "one epoch since the last attest" is **live** — the case
 * this module used to get wrong, which disabled granting and approving for a principal the chain
 * would have served.
 */
const GRACE = Number(LIVENESS_GRACE_EPOCHS);

describe("livenessOf", () => {
  it("has nobody to describe before enrolment", () => {
    expect(livenessOf(null, 5n)).toEqual({ kind: "not-enrolled" });
  });

  it("is live and anchorable the epoch it was attested for", () => {
    expect(livenessOf({ lastAttestedEpoch: 5n, thawEpoch: 0n }, 5n)).toEqual({
      kind: "live",
      epoch: 5n,
      lastAttested: 5n,
      attestedThisEpoch: true,
    });
  });

  it("stays live through the whole grace window, but cannot anchor a new capture", () => {
    for (let gap = 1; gap <= GRACE; gap++) {
      const l = livenessOf({ lastAttestedEpoch: 5n, thawEpoch: 0n }, 5n + BigInt(gap));
      expect(l, `gap of ${gap} epoch(s)`).toEqual({
        kind: "live",
        epoch: 5n + BigInt(gap),
        lastAttested: 5n,
        attestedThisEpoch: false,
      });
      expect(canGrant(l)).toBe(true);
      expect(canAnchor(l)).toBe(false);
    }
  });

  it("lapses one epoch past the grace window", () => {
    const l = livenessOf({ lastAttestedEpoch: 5n, thawEpoch: 0n }, 5n + LIVENESS_GRACE_EPOCHS + 1n);
    expect(l).toEqual({ kind: "lapsed", epoch: 8n, lastAttested: 5n });
    expect(canGrant(l)).toBe(false);
    expect(canAnchor(l)).toBe(false);
  });

  it("is frozen while a scheduled thaw has not been reached, whatever the attestation says", () => {
    expect(livenessOf({ lastAttestedEpoch: 5n, thawEpoch: 7n }, 5n)).toEqual({
      kind: "frozen",
      thawEpoch: 7n,
    });
    expect(livenessOf({ lastAttestedEpoch: 6n, thawEpoch: 7n }, 6n)).toEqual({
      kind: "frozen",
      thawEpoch: 7n,
    });
  });

  it("is live again at the thaw epoch", () => {
    expect(livenessOf({ lastAttestedEpoch: 7n, thawEpoch: 7n }, 7n)).toMatchObject({
      kind: "live",
      attestedThisEpoch: true,
    });
  });

  it("knows nothing until the chain has been read", () => {
    expect(canGrant({ kind: "unknown" })).toBe(false);
    expect(canAnchor({ kind: "unknown" })).toBe(false);
  });
});

describe("describeLiveness", () => {
  const cases: readonly [string, Liveness, RegExp][] = [
    ["unknown", { kind: "unknown" }, /^$/],
    ["not enrolled", { kind: "not-enrolled" }, /Activate/],
    [
      "attested this epoch",
      { kind: "live", epoch: 5n, lastAttested: 5n, attestedThisEpoch: true },
      /attested for epoch 5/,
    ],
    // The grace case says the consequence that matters: grants are unaffected, captures are not.
    [
      "live within grace",
      { kind: "live", epoch: 6n, lastAttested: 5n, attestedThisEpoch: false },
      /grants live through epoch 7.*Re-attest/,
    ],
    ["lapsed", { kind: "lapsed", epoch: 8n, lastAttested: 5n }, /lapsed after epoch 5.*frozen/],
    ["frozen", { kind: "frozen", thawEpoch: 9n }, /frozen until epoch 9/],
  ];

  it.each(cases)("describes a principal who is %s", (_label, l, pattern) => {
    expect(describeLiveness(l)).toMatch(pattern);
  });
});
