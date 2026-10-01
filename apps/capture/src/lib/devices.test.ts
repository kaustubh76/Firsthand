import type { DeviceView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { describeBoot, describeLevel, reportFor } from "./devices.js";

const COMMITMENT = `0x${"ab".repeat(32)}` as Bytes32;
const PRINCIPAL = `0x${"cd".repeat(32)}` as Bytes32;

const view = (patch: Partial<DeviceView> = {}): DeviceView => ({
  principalId: PRINCIPAL,
  publicKey: { x: `0x${"01".repeat(32)}`, y: `0x${"02".repeat(32)}` },
  securityLevel: 2,
  verifiedBootState: 0,
  hasRootOfTrust: true,
  registeredAt: 1_700_000_000n,
  revokedAt: 0n,
  ...patch,
});

describe("a device, as the chain records it", () => {
  it("names the level the certificate carried", () => {
    expect(describeLevel(2)).toBe("StrongBox");
    expect(describeLevel(1)).toBe("TEE");
    // Below TrustedEnvironment the registry refuses registration outright, so this label only
    // ever appears if a future deployment lowers its floor — and then it should read honestly.
    expect(describeLevel(0)).toBe("software");
  });

  it("names every boot state, including the ones a demo would rather not show", () => {
    expect([0, 1, 2, 3].map(describeBoot)).toEqual([
      "Verified",
      "SelfSigned",
      "Unverified",
      "Failed",
    ]);
    expect(describeBoot(9)).toBe("state 9");
  });

  it("reports a live device", () => {
    const report = reportFor(COMMITMENT, view());
    expect(report).toMatchObject({ level: "StrongBox", boot: "Verified", live: true });
    expect(report.revokedAt).toBeNull();
  });

  it("reports absence as absence when no root of trust was attested", () => {
    // Not "Verified by default": a boot state nobody attested is not a boot state.
    expect(reportFor(COMMITMENT, view({ hasRootOfTrust: false })).boot).toBeNull();
  });

  it("reports a revoked device without hiding that it existed", () => {
    const report = reportFor(COMMITMENT, view({ revokedAt: 1_700_000_500n }));
    expect(report.live).toBe(false);
    expect(report.revokedAt).toBe(1_700_000_500n);
    // A buyer auditing an older manifest needs the principal, not a blank.
    expect(report.principalId).toBe(PRINCIPAL);
  });
});
