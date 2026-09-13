import type { AnchorWriter } from "@firsthand/adapters";
import {
  type BatchProof,
  type Bytes32,
  type Eip712Domain,
  type GrantForVerify,
  type LivenessParams,
  type PrincipalRecord,
  type SignedPassport,
  type VerifyResult,
  verifyPredicate,
} from "@firsthand/core";

/**
 * The one call (README §7.3), composed from pure core logic plus one chain read: whether the batch
 * root is anchored. Grant and principal state are passed in by the caller (gateway or lens read).
 */
export interface VerifyContext {
  readonly domain: Eip712Domain;
  readonly anchors: Pick<AnchorWriter, "isAnchored">;
  readonly epochNow: bigint;
  readonly liveness?: LivenessParams;
}

export async function verify(
  signed: SignedPassport,
  batchRoot: Bytes32,
  proof: BatchProof,
  grant: GrantForVerify,
  principal: PrincipalRecord,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const rootAnchored = await ctx.anchors.isAnchored(batchRoot);
  return verifyPredicate({
    passport: signed.passport,
    signature: signed.signature,
    domain: ctx.domain,
    proof,
    batchRoot,
    rootAnchored,
    grant,
    principal,
    epochNow: ctx.epochNow,
    ...(ctx.liveness ? { liveness: ctx.liveness } : {}),
  });
}
