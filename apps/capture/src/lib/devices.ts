import type {
  DevicePolicy,
  DeviceView,
  OnchainDeviceRegistryReader,
} from "@firsthand/adapters/client";
import {
  type Bytes32,
  bytesToHex,
  keyDescriptionOf,
  parseCertificate,
  SecurityLevel,
  VerifiedBootState,
} from "@firsthand/core";

/**
 * What the chain records about one secure element (ADR-0015), read straight from
 * `HardwareDeviceRegistry` rather than from a gateway — the same reason the Lens and the receipt
 * ledger are read directly: when a buyer is auditing what a gateway served, the gateway's word is
 * the thing in question.
 */
export interface DeviceReport {
  readonly keyCommitment: Bytes32;
  /** "StrongBox" · "TEE" · "software" — the level the certificate carried, not one anybody chose. */
  readonly level: string;
  /** Null when the attestation carried no `rootOfTrust`, so there is no state to report. */
  readonly boot: string | null;
  readonly principalId: Bytes32;
  readonly registeredAt: bigint;
  readonly revokedAt: bigint | null;
  readonly live: boolean;
}

/**
 * The anchor the golden suite's **generated** chain reaches
 * (`packages/test-vectors/vectors/android-attestation.v1.json`, `extra.anchorCommitment`).
 *
 * A registry pinned to it trusts a certificate this repository made up, so no real handset can
 * register against it and a registration there proves the plumbing, not a device. It is listed
 * here only so the app can *recognise* one — the question is always answered by reading the
 * registry's own `anchors()`, never by configuration, so the warning cannot be forgotten and
 * disappears on its own the moment the registry is redeployed against a real attestation
 * intermediate.
 */
export const GENERATED_TEST_ANCHOR =
  "0xff068cebf11af4a3ea44919461c835c32c4bd8f60da77d577e4dfdc2dd5b6f9b" as Bytes32;

/** True when every anchor this registry trusts is one this repository generated. */
export function trustsGeneratedAnchor(policy: DevicePolicy): boolean {
  return (
    policy.anchors.length > 0 &&
    policy.anchors.every((a) => a.toLowerCase() === GENERATED_TEST_ANCHOR)
  );
}

/** 1 TrustedEnvironment, 2 StrongBox; anything lower is not hardware and the registry refuses it. */
export function describeLevel(level: number): string {
  if (level >= SecurityLevel.STRONG_BOX) return "StrongBox";
  if (level === SecurityLevel.TRUSTED_ENVIRONMENT) return "TEE";
  return "software";
}

export function describeBoot(state: number): string {
  switch (state) {
    case VerifiedBootState.VERIFIED:
      return "Verified";
    case VerifiedBootState.SELF_SIGNED:
      return "SelfSigned";
    case VerifiedBootState.UNVERIFIED:
      return "Unverified";
    case VerifiedBootState.FAILED:
      return "Failed";
    default:
      return `state ${state}`;
  }
}

export function reportFor(keyCommitment: Bytes32, device: DeviceView): DeviceReport {
  return {
    keyCommitment,
    level: describeLevel(device.securityLevel),
    boot: device.hasRootOfTrust ? describeBoot(device.verifiedBootState) : null,
    principalId: device.principalId,
    registeredAt: device.registeredAt,
    revokedAt: device.revokedAt === 0n ? null : device.revokedAt,
    live: device.revokedAt === 0n,
  };
}

/** Null when the registry has never seen this commitment. */
export async function askDeviceRegistry(
  reader: OnchainDeviceRegistryReader,
  keyCommitment: Bytes32,
): Promise<DeviceReport | null> {
  const device = await reader.device(keyCommitment);
  return device === null ? null : reportFor(keyCommitment, device);
}

/**
 * Certificates out of whatever the phone put on the clipboard: PEM blocks, or `0x…` hex one per
 * line. Leaf first, as `KeyStore.getCertificateChain` returns them and as `registerDevice` takes
 * them.
 *
 * Lenient about the wrapper and strict about the contents — a stray header line is a transport
 * artefact, whereas a certificate that does not parse is the thing the user needs told.
 */
export function parseChainText(text: string): Uint8Array[] {
  const pem = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  const chain = pem.length
    ? pem.map((m) => base64ToBytes((m[1] as string).replace(/\s+/g, "")))
    : text
        .split(/\s+/)
        .filter((t) => /^0x[0-9a-fA-F]+$/.test(t))
        .map((t) => hexToBytes(t));
  if (chain.length === 0) throw new Error("no certificates found — paste the PEM the app wrote");
  if (chain.length < 2) {
    throw new Error("a chain needs a leaf and at least one issuer; this has only the leaf");
  }
  return chain;
}

/**
 * The `principalId ‖ nonce` the key was generated under, read back out of the leaf.
 *
 * The nonce is not something the browser may choose: it is baked into a signed certificate that
 * cannot be re-issued, so recovering it here is the only way the paste needs one field instead
 * of two — and the principal comes with it, which is what lets the card refuse a chain that
 * names somebody else before any gas is spent.
 */
export function challengeOf(leaf: Uint8Array): { principalId: Bytes32; nonce: Bytes32 } {
  const description = keyDescriptionOf(parseCertificate(leaf));
  if (description === null) {
    throw new Error("no key attestation in this certificate — it is not an attested key");
  }
  const challenge = description.attestationChallenge;
  if (challenge.length !== 64) {
    throw new Error(
      `this key was generated under a ${challenge.length}-byte challenge; FIRSTHAND uses 64 (principalId ‖ nonce)`,
    );
  }
  return {
    principalId: bytesToHex(challenge.subarray(0, 32)),
    nonce: bytesToHex(challenge.subarray(32)),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  if (body.length % 2 !== 0) throw new Error("odd-length hex in the pasted chain");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.substr(i * 2, 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
