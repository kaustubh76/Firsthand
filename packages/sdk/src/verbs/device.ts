import type { PreparedTx, TxTransport } from "@firsthand/adapters";
import { HardwareDeviceRegistryAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  AttestationError,
  authorityDigest,
  type Bytes32,
  bytesToHex,
  CryptoError,
  concat,
  type Hex,
  hexToBytes,
  registerDeviceStructHash,
  revokeDeviceStructHash,
  type VerifiedDevice,
  verifyAttestationChain,
  verifyP256,
} from "@firsthand/core";
import { randomNonce, signAuthorityDigest } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";

/**
 * `registerDevice` / `revokeDevice` (ADR-0015): bind one secure element to one principal, and let
 * the human take it back.
 *
 * Authorised the same way every other authority verb is — a P-256 signature under *this
 * contract's own* EIP-712 domain, relayable by anyone, `msg.sender` meaning nothing (ADR-0009).
 * The browser holds no gas key for this any more than it does for enrolment.
 */
export interface DeviceAddresses {
  readonly hardwareDeviceRegistry: Address;
}

export interface RegisterDeviceInput {
  /** DER certificates, leaf first — exactly what `KeyStore.getCertificateChain` returns. */
  readonly chain: readonly Uint8Array[];
  /**
   * **Not** generated here. The phone baked `principalId ‖ nonce` into the key's attestation
   * challenge at generation time, and `HardwareDeviceRegistry._requireAttested` checks it, so the
   * nonce is already fixed by a certificate that cannot be re-issued. Passing a fresh one would
   * produce a plan that reverts.
   */
  readonly nonce: Bytes32;
  /** Commitments of the certificates trusted as anchors — the same set the registry was deployed with. */
  readonly anchors: readonly Bytes32[];
  readonly minimumSecurityLevel?: number;
}

export interface RegisterDevicePlan {
  readonly principalId: Bytes32;
  /** Derived from `chain[0]`, never asserted: the contract recomputes it and would disagree. */
  readonly keyCommitment: Bytes32;
  readonly nonce: Bytes32;
  /** The level the certificate carried, 1 TEE or 2 StrongBox. A measurement, shown as read. */
  readonly securityLevel: number;
  /** Null when the attestation carried no `rootOfTrust`, so there is no boot state to report. */
  readonly verifiedBootState: number | null;
  readonly authoritySig: Hex;
  readonly tx: PreparedTx;
}

export interface RevokeDevicePlan {
  readonly principalId: Bytes32;
  readonly keyCommitment: Bytes32;
  readonly nonce: Bytes32;
  readonly authoritySig: Hex;
  readonly tx: PreparedTx;
}

/**
 * Verifies the chain **locally first**, then signs over the commitment it produced.
 *
 * The local pass is not duplicated work. It runs the identical policy the contract runs — same
 * anchors, same minimum level, same challenge — so a chain that would revert is refused here, for
 * free, with a readable reason, instead of costing gas to be told `ChainRejected(3, 1)`. It also
 * means the signature can only ever name a device the certificate actually attested, because the
 * commitment is taken from the verified leaf rather than from an argument.
 */
export function planRegisterDevice(
  locker: Locker,
  registry: Address,
  input: RegisterDeviceInput,
): RegisterDevicePlan {
  const authority = locker.authorityKey();
  const principalId = authority.commitment;

  // The challenge the registry will demand: keccak256(abi.encodePacked(principalId, nonce)) over
  // exactly these 64 bytes.
  const expectedChallenge = concat(hexToBytes(principalId), hexToBytes(input.nonce));
  const device: VerifiedDevice = verifyAttestationChain(input.chain, {
    anchors: input.anchors,
    expectedChallenge,
    ...(input.minimumSecurityLevel === undefined
      ? {}
      : { minimumSecurityLevel: input.minimumSecurityLevel }),
  });

  const structHash = registerDeviceStructHash(principalId, device.keyCommitment, input.nonce);
  const digest = authorityDigest(structHash, locker.authorityDomain(registry));
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  if (!verifyP256(digest, authoritySig, authority.publicKey)) {
    throw new CryptoError(
      "registerDevice: produced signature does not verify against the authority key",
    );
  }

  return {
    principalId,
    keyCommitment: device.keyCommitment,
    nonce: input.nonce,
    securityLevel: device.securityLevel,
    // teeEnforced only, matching AndroidKeyAttestation._authorizations: a boot state the
    // software list claimed would be an assertion by the thing being measured.
    verifiedBootState: device.description.teeEnforced.rootOfTrust?.verifiedBootState ?? null,
    authoritySig,
    tx: {
      to: registry,
      data: encodeFunctionData({
        abi: HardwareDeviceRegistryAbi,
        functionName: "registerDevice",
        args: [principalId, input.chain.map((c) => bytesToHex(c)), input.nonce, authoritySig],
      }),
    },
  };
}

/**
 * Ends a device's ability to witness captures — what a stolen phone needs, and the half of the
 * claim that makes registration mean anything.
 *
 * No chain here: revocation names a commitment the registry already holds. The nonce is fresh,
 * because nothing outside this call has committed to one.
 */
export function planRevokeDevice(
  locker: Locker,
  registry: Address,
  keyCommitment: Bytes32,
  nonce: Bytes32 = randomNonce(),
): RevokeDevicePlan {
  const authority = locker.authorityKey();
  const principalId = authority.commitment;
  const structHash = revokeDeviceStructHash(principalId, keyCommitment, nonce);
  const digest = authorityDigest(structHash, locker.authorityDomain(registry));
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  if (!verifyP256(digest, authoritySig, authority.publicKey)) {
    throw new CryptoError(
      "revokeDevice: produced signature does not verify against the authority key",
    );
  }

  return {
    principalId,
    keyCommitment,
    nonce,
    authoritySig,
    tx: {
      to: registry,
      data: encodeFunctionData({
        abi: HardwareDeviceRegistryAbi,
        functionName: "revokeDevice",
        args: [principalId, keyCommitment, nonce, authoritySig],
      }),
    },
  };
}

export async function sendRegisterDevice(
  locker: Locker,
  transport: TxTransport,
  plan: RegisterDevicePlan,
): Promise<{ readonly txHash: Bytes32; readonly submittedAt: number }> {
  const ref = await transport.send(plan.tx);
  locker.logger.info("registerDevice sent", {
    principalId: plan.principalId,
    keyCommitment: plan.keyCommitment,
    securityLevel: plan.securityLevel,
    tx: ref.hash,
    transport: transport.kind,
  });
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}

export async function sendRevokeDevice(
  locker: Locker,
  transport: TxTransport,
  plan: RevokeDevicePlan,
): Promise<{ readonly txHash: Bytes32; readonly submittedAt: number }> {
  const ref = await transport.send(plan.tx);
  locker.logger.info("revokeDevice sent", {
    principalId: plan.principalId,
    keyCommitment: plan.keyCommitment,
    tx: ref.hash,
    transport: transport.kind,
  });
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}

/** Re-exported so a caller can narrow on the reason a chain was refused before any gas is spent. */
export { AttestationError };
