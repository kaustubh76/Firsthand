import type { PreparedTx, TxTransport } from "@firsthand/adapters";
import { GrantManagerAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  authorityDigest,
  type Bytes32,
  grantIdOf,
  grantStructHash,
  type Hex,
} from "@firsthand/core";
import { randomNonce, signAuthorityDigest, wrapVaultKeyToGrantee } from "@firsthand/crypto";
import { encodeFunctionData } from "viem";
import type { Locker } from "../locker/Locker.js";
import type { SentTx } from "./enroll.js";

/**
 * `grant` (README §7.2): wrap the namespace-epoch vault key to the grantee's card key, sign the
 * Grant struct with the authority key, and produce the calldata. The wrap bytes are published to a
 * gateway (`publishWrap`); the chain stores only their hash.
 */
export interface GrantInput {
  readonly granteeCard: Bytes32;
  /** The card's X25519 public key (from `GrantManager.cardOf`). */
  readonly granteeEncryptionPubKey: Bytes32;
  readonly ns: number;
  readonly termsHash: Bytes32;
  readonly term: bigint;
  readonly epochStart?: bigint;
  readonly nonce?: Bytes32;
}

export interface GrantPlan {
  readonly grantId: Bytes32;
  readonly principalId: Bytes32;
  readonly granteeCard: Bytes32;
  readonly ns: number;
  readonly epochStart: bigint;
  readonly term: bigint;
  readonly termsHash: Bytes32;
  readonly wrapRef: Bytes32;
  /** Sealed vault key for (ns, epochStart); publish to the gateway, never on-chain. */
  readonly wrap: Uint8Array;
  readonly nonce: Bytes32;
  readonly authoritySig: Hex;
  readonly tx: PreparedTx;
}

export function planGrant(locker: Locker, grantManager: Address, input: GrantInput): GrantPlan {
  const epochStart = input.epochStart ?? locker.currentEpoch();
  const nonce = input.nonce ?? randomNonce();
  const authority = locker.authorityKey();
  const grantId = grantIdOf(authority.commitment, input.granteeCard, input.ns, epochStart);
  const vault = locker.keys.vaultKey(input.ns, epochStart);
  let wrap: ReturnType<typeof wrapVaultKeyToGrantee>;
  try {
    wrap = wrapVaultKeyToGrantee(vault, input.granteeEncryptionPubKey, {
      grantId,
      ns: input.ns,
      epoch: epochStart,
    });
  } finally {
    vault.dispose();
  }
  const structHash = grantStructHash({
    principalId: authority.commitment,
    granteeCard: input.granteeCard,
    ns: input.ns,
    epochStart,
    term: input.term,
    termsHash: input.termsHash,
    wrapRef: wrap.ref,
    nonce,
  });
  const authoritySig = signAuthorityDigest(
    authority.scalar,
    authorityDigest(structHash, locker.authorityDomain(grantManager)),
  );
  return {
    grantId,
    principalId: authority.commitment,
    granteeCard: input.granteeCard,
    ns: input.ns,
    epochStart,
    term: input.term,
    termsHash: input.termsHash,
    wrapRef: wrap.ref,
    wrap: wrap.bytes,
    nonce,
    authoritySig,
    tx: {
      to: grantManager,
      data: encodeFunctionData({
        abi: GrantManagerAbi,
        functionName: "grant",
        args: [
          authority.commitment,
          input.granteeCard,
          input.ns,
          epochStart,
          input.term,
          input.termsHash,
          wrap.ref,
          nonce,
          authoritySig,
        ],
      }),
    },
  };
}

export async function sendGrant(
  locker: Locker,
  transport: TxTransport,
  plan: GrantPlan,
): Promise<SentTx> {
  const ref = await transport.send(plan.tx);
  locker.logger.info("grant sent", { grantId: plan.grantId, ns: plan.ns, tx: ref.hash });
  return { txHash: ref.hash, submittedAt: ref.submittedAt };
}
