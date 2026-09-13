import type { TxTransport } from "@firsthand/adapters";
import { GrantManagerAbi, RescissionsAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  authorityDigest,
  type Bytes32,
  type Hex,
  rescindCommitStructHash,
  rescindStructHash,
  rescissionCommitment,
} from "@firsthand/core";
import { randomBytes32, randomNonce, signAuthorityDigest } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";

/**
 * `rescind` (README §7.5, §8 claim 1): withdraw consent for a grant.
 *
 * Path selection is explicit, never silent:
 * - `btx`           direct `GrantManager.rescind` over the encrypted mempool (un-front-runnable)
 * - `commit-reveal` `Rescissions.commit(keccak(grantId ‖ salt))` now, `revealRescind` later (fallback)
 * - `public`        direct rescind over the public mempool (the B2 baseline arm — measurable, not recommended)
 *
 * The P-256 authority signature is produced here (Phase 3); Phase 4 adds the BTX transport and race harness.
 */
export type RescindPath = "btx" | "commit-reveal" | "public";

export interface RescindAddresses {
  readonly grantManager: Address;
  readonly rescissions: Address;
}

/** Addresses every verb needs; extended per phase. */
export interface VerbAddresses extends RescindAddresses {
  readonly principalRegistry: Address;
}

export interface RescindPlan {
  readonly path: RescindPath;
  readonly to: Address;
  readonly data: Hex;
  readonly grantId: Bytes32;
  /** Present for commit-reveal: keep it to reveal later. */
  readonly salt?: Bytes32;
  readonly commitment?: Bytes32;
}

/** Direct rescission signed by the locker's authority key under GrantManager's domain. */
export function planDirectRescind(
  locker: Locker,
  path: "btx" | "public",
  addresses: RescindAddresses,
  grantId: Bytes32,
  epoch: bigint = locker.currentEpoch(),
  nonce: Bytes32 = randomNonce(),
): RescindPlan {
  const authority = locker.authorityKey();
  const digest = authorityDigest(
    rescindStructHash(grantId, epoch, nonce),
    locker.authorityDomain(addresses.grantManager),
  );
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  return {
    path,
    grantId,
    to: addresses.grantManager,
    data: encodeFunctionData({
      abi: GrantManagerAbi,
      functionName: "rescind",
      args: [grantId, epoch, nonce, authoritySig],
    }),
  };
}

/** Step 1 of the fallback: post a blind commitment (anyone may relay it). */
export function planCommit(
  addresses: RescindAddresses,
  grantId: Bytes32,
  salt: Bytes32 = randomBytes32(),
): RescindPlan {
  const commitment = rescissionCommitment(grantId, salt);
  return {
    path: "commit-reveal",
    grantId,
    to: addresses.rescissions,
    data: encodeFunctionData({ abi: RescissionsAbi, functionName: "commit", args: [commitment] }),
    salt,
    commitment,
  };
}

/** Step 2 of the fallback: reveal with the authority signature over RescindCommit; effective end = commit block. */
export function planRevealRescind(
  locker: Locker,
  addresses: RescindAddresses,
  grantId: Bytes32,
  salt: Bytes32,
  nonce: Bytes32 = randomNonce(),
): RescindPlan {
  const commitment = rescissionCommitment(grantId, salt);
  const authority = locker.authorityKey();
  const digest = authorityDigest(
    rescindCommitStructHash(commitment, nonce),
    locker.authorityDomain(addresses.grantManager),
  );
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  return {
    path: "commit-reveal",
    grantId,
    to: addresses.grantManager,
    data: encodeFunctionData({
      abi: GrantManagerAbi,
      functionName: "revealRescind",
      args: [grantId, salt, nonce, authoritySig],
    }),
    salt,
    commitment,
  };
}

export interface RescindResult {
  readonly plan: RescindPlan;
  readonly txHash: Bytes32;
  readonly submittedAt: number;
  readonly encryptedMempool: boolean;
}

/** Sends a prepared plan over the chosen transport, recording the broadcast time for §7.4's Δ_race. */
export async function sendRescind(
  locker: Locker,
  transport: TxTransport,
  plan: RescindPlan,
): Promise<RescindResult> {
  const caps = await transport.capabilities();
  const ref = await transport.send({ to: plan.to, data: plan.data });
  locker.logger.info("rescind sent", { path: plan.path, transport: transport.kind, tx: ref.hash });
  return {
    plan,
    txHash: ref.hash,
    submittedAt: ref.submittedAt,
    encryptedMempool: caps.encryptedMempool,
  };
}
