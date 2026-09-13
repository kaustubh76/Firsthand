import type { TxTransport } from "@firsthand/adapters";
import { GrantManagerAbi, RescissionsAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, type Hex, rescissionCommitment } from "@firsthand/core";
import { randomBytes32 } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";

/**
 * `rescind` (README §7.5, §8 claim 1): withdraw consent for a grant.
 *
 * Path selection is explicit, never silent:
 * - `btx`           direct `GrantManager.rescind` over the encrypted mempool (un-front-runnable)
 * - `commit-reveal` `Rescissions.commit(keccak(grantId ‖ salt))` now, reveal later (fallback)
 * - `public`        direct rescind over the public mempool (the B2 baseline arm — measurable, not recommended)
 *
 * Phase 4 adds the P-256 authority signature over `AuthorityDigests.rescind`; the calldata builders
 * below are final so the race harness can be wired now.
 */
export type RescindPath = "btx" | "commit-reveal" | "public";

export interface RescindAddresses {
  readonly grantManager: Address;
  readonly rescissions: Address;
}

export interface RescindPlan {
  readonly path: RescindPath;
  readonly to: Address;
  readonly data: Hex;
  /** Present for commit-reveal: keep it to reveal later. */
  readonly salt?: Bytes32;
  readonly commitment?: Bytes32;
}

export interface RescindInput {
  readonly grantId: Bytes32;
  readonly epoch: bigint;
  readonly nonce: Bytes32;
  /** 64-byte P-256 authority signature over `authorityDigest(rescindStructHash(...))`. */
  readonly authoritySig: Hex;
}

export function planDirectRescind(
  path: "btx" | "public",
  addresses: RescindAddresses,
  input: RescindInput,
): RescindPlan {
  return {
    path,
    to: addresses.grantManager,
    data: encodeFunctionData({
      abi: GrantManagerAbi,
      functionName: "rescind",
      args: [input.grantId, input.epoch, input.nonce, input.authoritySig],
    }),
  };
}

export function planCommit(
  addresses: RescindAddresses,
  grantId: Bytes32,
  salt: Bytes32 = randomBytes32(),
): RescindPlan {
  const commitment = rescissionCommitment(grantId, salt);
  return {
    path: "commit-reveal",
    to: addresses.rescissions,
    data: encodeFunctionData({ abi: RescissionsAbi, functionName: "commit", args: [commitment] }),
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
