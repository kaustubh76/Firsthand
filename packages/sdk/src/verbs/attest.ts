import type { PreparedTx, TxTransport } from "@firsthand/adapters";
import { PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  attestStructHash,
  authorityDigest,
  type Bytes32,
  depositKeysRoot,
  type Hex,
} from "@firsthand/core";
import { randomNonce, signAuthorityDigest } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";
import type { SentTx } from "./enroll.js";

/**
 * `attest` (README §7.4 weekly ritual): publish the 16 epoch deposit addresses as one commitment
 * and refresh liveness. PassportAnchors verifies anchors against this root (Phase 2).
 */
export interface AttestPlan {
  readonly principalId: Bytes32;
  readonly epoch: bigint;
  readonly depositKeys: readonly Address[];
  readonly depositKeysRoot: Bytes32;
  readonly nonce: Bytes32;
  readonly authoritySig: Hex;
  readonly tx: PreparedTx;
}

export function planAttest(
  locker: Locker,
  registry: Address,
  epoch: bigint = locker.currentEpoch(),
  nonce: Bytes32 = randomNonce(),
): AttestPlan {
  const authority = locker.authorityKey();
  const depositKeys = locker.depositAddresses(epoch);
  const root = depositKeysRoot(depositKeys);
  const digest = authorityDigest(
    attestStructHash(authority.commitment, epoch, root, nonce),
    locker.authorityDomain(registry),
  );
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  return {
    principalId: authority.commitment,
    epoch,
    depositKeys,
    depositKeysRoot: root,
    nonce,
    authoritySig,
    tx: {
      to: registry,
      data: encodeFunctionData({
        abi: PrincipalRegistryAbi,
        functionName: "attest",
        args: [authority.commitment, epoch, root, nonce, authoritySig],
      }),
    },
  };
}

export async function sendAttest(
  locker: Locker,
  transport: TxTransport,
  plan: AttestPlan,
): Promise<SentTx> {
  const ref = await transport.send(plan.tx);
  locker.logger.info("attest sent", {
    principalId: plan.principalId,
    epoch: plan.epoch.toString(),
    tx: ref.hash,
    transport: transport.kind,
  });
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}
