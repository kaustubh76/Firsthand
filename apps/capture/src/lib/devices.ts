import type { DeviceView, OnchainDeviceRegistryReader } from "@firsthand/adapters/client";
import { type Bytes32, SecurityLevel, VerifiedBootState } from "@firsthand/core";

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
