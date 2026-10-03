import {
  type Attestation,
  deviceKeyCommitment,
  type HardwareWitness,
  hardwareCaptureDigest,
  type P256PublicKey,
  type Passport,
} from "@firsthand/core";
import type { SecretBytes } from "@firsthand/crypto";
import { signAuthorityDigest } from "@firsthand/crypto";

/**
 * Signs a capture witness with a P-256 key held **in this process** (ADR-0015).
 *
 * The software stand-in for a secure element: development, the browser tier, and tests, none of
 * which have one. It cannot be used to fake a hardware claim, and the reason is structural rather
 * than a matter of trust — what makes a witness count is the device being registered in
 * `HardwareDeviceRegistry`, and registration verifies an attestation certificate chain that no
 * software key has. A witness produced here is refused at ingest like any other unregistered
 * device, so this function can only ever produce a *well-formed* claim, never a true one.
 *
 * The real path is the reverse shape: the phone signs, and the key never leaves the element.
 */
export function signCaptureWitness(
  device: { readonly scalar: SecretBytes; readonly publicKey: P256PublicKey },
  input: {
    readonly chainId: bigint;
    readonly passport: Passport;
    readonly attestation: Attestation;
  },
): HardwareWitness {
  const digest = hardwareCaptureDigest({
    chainId: input.chainId,
    origin: input.passport.origin,
    contentHash: input.passport.h,
    capturedAt: input.attestation.capturedAt,
    nonce: input.passport.nonce,
    deviceClass: input.attestation.deviceClass,
  });
  return {
    publicKey: device.publicKey,
    signature: signAuthorityDigest(device.scalar, digest),
  };
}

/**
 * The `deviceClass` a class-3 attestation must carry for `device`: the commitment the registry
 * keys its record by, so the attestation names the device and the witness proves it signed.
 */
export function deviceClassFor(publicKey: P256PublicKey): ReturnType<typeof deviceKeyCommitment> {
  return deviceKeyCommitment(publicKey);
}
