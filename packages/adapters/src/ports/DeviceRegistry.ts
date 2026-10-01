import type { Bytes32, P256PublicKey } from "@firsthand/core";

/**
 * Read model over `HardwareDeviceRegistry` (ADR-0015): which secure elements a principal has
 * registered, at what measured security level, and whether they are still live.
 *
 * Read-only on purpose. Registration and revocation are authorised by the principal's P-256
 * signature and relayed like every other authority verb, so nothing here writes.
 */
export interface DeviceView {
  /** The principal that registered this device; the challenge in its certificate binds the two. */
  readonly principalId: Bytes32;
  /** The attested key. `deviceKeyCommitment(publicKey)` is the id this record is stored under. */
  readonly publicKey: P256PublicKey;
  /**
   * The level read out of the certificate — 1 TrustedEnvironment, 2 StrongBox. A **measurement**,
   * never a level the depositor asked for: a sidecar that carried its own security level would be
   * asserting the one thing this registry exists to establish.
   */
  readonly securityLevel: number;
  /**
   * `VerifiedBootState` as the certificate recorded it: 0 Verified, 1 SelfSigned, 2 Unverified,
   * 3 Failed. The chain stores it and does **not** enforce it — a handset with an unlocked
   * bootloader reports Unverified, and refusing that on chain would produce a device nobody can
   * register rather than a device nobody should trust. Acting on it is a gateway's choice.
   */
  readonly verifiedBootState: number;
  /** False when the attestation carried no `rootOfTrust` at all, so the state above means nothing. */
  readonly hasRootOfTrust: boolean;
  /** Unix seconds of registration. */
  readonly registeredAt: bigint;
  /** Unix seconds the principal revoked it; `0n` while live. */
  readonly revokedAt: bigint;
}

export interface DeviceRegistryReader {
  /** Null when this key commitment was never registered. */
  device(keyCommitment: Bytes32): Promise<DeviceView | null>;
}

/** True when a device is registered to this principal and has not been revoked. */
export function deviceIsLive(device: DeviceView | null, principalId: Bytes32): boolean {
  return device !== null && device.revokedAt === 0n && device.principalId === principalId;
}
