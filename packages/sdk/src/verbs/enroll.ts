import type { PreparedTx, TxTransport } from "@firsthand/adapters";
import { PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  authorityDigest,
  type Bytes32,
  CryptoError,
  enrollStructHash,
  type Hex,
  verifyP256,
} from "@firsthand/core";
import { randomNonce, signAuthorityDigest } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";

/**
 * `enroll` (README §7.3 "P256 = human authority", Phase 1): register the locker's derived P-256
 * authority key on-chain. The plan is fully signed and relayable — whoever sends it pays gas and
 * learns nothing that links them to the principal.
 */
export interface EnrollPlan {
  readonly principalId: Bytes32;
  readonly x: Bytes32;
  readonly y: Bytes32;
  readonly epoch: bigint;
  readonly nonce: Bytes32;
  /** 64-byte low-s P-256 signature over the EIP-712 Enroll digest under the registry's domain. */
  readonly authoritySig: Hex;
  readonly tx: PreparedTx;
}

export function planEnroll(
  locker: Locker,
  registry: Address,
  epoch: bigint = locker.currentEpoch(),
  nonce: Bytes32 = randomNonce(),
): EnrollPlan {
  const authority = locker.authorityKey();
  const structHash = enrollStructHash(authority.commitment, epoch, nonce);
  const digest = authorityDigest(structHash, locker.authorityDomain(registry));
  const authoritySig = signAuthorityDigest(authority.scalar, digest);
  // Belt and braces: never emit a plan the chain would reject.
  if (!verifyP256(digest, authoritySig, authority.publicKey)) {
    throw new CryptoError("enroll: produced signature does not verify against the authority key");
  }
  const x = authority.publicKey.x;
  const y = authority.publicKey.y;
  return {
    principalId: authority.commitment,
    x,
    y,
    epoch,
    nonce,
    authoritySig,
    tx: {
      to: registry,
      data: encodeFunctionData({
        abi: PrincipalRegistryAbi,
        functionName: "enroll",
        args: [BigInt(x), BigInt(y), epoch, nonce, authoritySig],
      }),
    },
  };
}

export interface SentTx {
  readonly txHash: Bytes32;
  readonly submittedAt: number;
}

export async function sendEnroll(
  locker: Locker,
  transport: TxTransport,
  plan: EnrollPlan,
): Promise<SentTx> {
  const ref = await transport.send(plan.tx);
  locker.logger.info("enroll sent", {
    principalId: plan.principalId,
    epoch: plan.epoch.toString(),
    tx: ref.hash,
    transport: transport.kind,
  });
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}
