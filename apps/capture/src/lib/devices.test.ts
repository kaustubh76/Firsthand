import type { DeviceView } from "@firsthand/adapters/client";
import { type Bytes32, bytesToHex } from "@firsthand/core";
import { loadVectors } from "@firsthand/test-vectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  challengeOf,
  describeBoot,
  describeLevel,
  GENERATED_TEST_ANCHOR,
  parseChainText,
  reportFor,
  trustsGeneratedAnchor,
} from "./devices.js";

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

// The same golden chain the Solidity reader and the SDK verb are tested against, so the paste box
// and the contract cannot disagree about what a chain is.
const vectors = loadVectors("android-attestation", {
  input: z.object({ certificate: z.string() }),
  expected: z.record(z.string(), z.unknown()),
  extra: z.object({
    anchorCommitment: z.string(),
    chain: z.array(z.string()),
    nonce: z.string(),
    principalId: z.string(),
  }),
});

const hexChain = vectors.extra.chain as `0x${string}`[];
const bytes = (hex: `0x${string}`): Uint8Array =>
  Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
const pem = (hex: `0x${string}`): string =>
  `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...bytes(hex)))
    .replace(/(.{64})/g, "$1\n")
    .trim()}\n-----END CERTIFICATE-----`;

describe("a chain, as it arrives from the phone", () => {
  it("reads PEM, which is what the companion app writes", () => {
    const chain = parseChainText(hexChain.map(pem).join("\n"));
    expect(chain.map(bytesToHex)).toEqual(hexChain);
  });

  it("reads 0x hex too, because that is what a terminal paste looks like", () => {
    expect(parseChainText(hexChain.join("\n")).map(bytesToHex)).toEqual(hexChain);
  });

  it("ignores the provenance header the app writes above the certificates", () => {
    const withHeader = `# device Pixel 9\n# strongBox granted\n${hexChain.map(pem).join("\n")}`;
    expect(parseChainText(withHeader)).toHaveLength(2);
  });

  it("refuses a leaf on its own — a chain with nothing to verify against is not a chain", () => {
    expect(() => parseChainText(pem(hexChain[0] as `0x${string}`))).toThrow(/only the leaf/);
  });

  it("says so when the paste contains no certificate at all", () => {
    expect(() => parseChainText("I copied the wrong thing")).toThrow(/no certificates/);
  });
});

describe("the challenge, read back out of the leaf", () => {
  it("recovers the principal and the nonce the key committed to", () => {
    const { principalId, nonce } = challengeOf(bytes(hexChain[0] as `0x${string}`));
    expect(principalId).toBe(vectors.extra.principalId);
    // The nonce is not the browser's to choose: the certificate fixed it at generation time.
    expect(nonce).toBe(vectors.extra.nonce);
  });

  it("refuses a certificate carrying no key attestation", () => {
    // The intermediate is a real certificate with no KeyDescription extension.
    expect(() => challengeOf(bytes(hexChain[1] as `0x${string}`))).toThrow(/no key attestation/);
  });
});

describe("telling a test-anchored registry from a real one", () => {
  it("recognises the anchor the golden suite's generated chain reaches", () => {
    // Pinned against the vector rather than restated, so regenerating the suite cannot leave the
    // app quietly trusting a constant nothing reaches any more.
    expect(GENERATED_TEST_ANCHOR).toBe(vectors.extra.anchorCommitment);
    expect(
      trustsGeneratedAnchor({ anchors: [GENERATED_TEST_ANCHOR], minimumSecurityLevel: 1 }),
    ).toBe(true);
  });

  it("says nothing about a registry pinned to something else", () => {
    expect(
      trustsGeneratedAnchor({ anchors: [`0x${"ab".repeat(32)}`], minimumSecurityLevel: 1 }),
    ).toBe(false);
    // A registry that trusts the test anchor *and* a real one is not a test registry, and
    // warning about it would cry wolf over a deployment that works.
    expect(
      trustsGeneratedAnchor({
        anchors: [GENERATED_TEST_ANCHOR, `0x${"ab".repeat(32)}`],
        minimumSecurityLevel: 1,
      }),
    ).toBe(false);
  });

  it("says nothing about a registry with no anchors — the constructor forbids one anyway", () => {
    expect(trustsGeneratedAnchor({ anchors: [], minimumSecurityLevel: 1 })).toBe(false);
  });
});
