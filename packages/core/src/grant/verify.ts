import type { Bytes32 } from "../bytes.js";
import type { BatchProof } from "../merkle/merkle.js";
import { verifyPassportInBatch } from "../merkle/merkle.js";
import { passportId } from "../passport/typed.js";
import type { Eip712Domain, Passport, PassportSignature } from "../passport/types.js";
import { verifyPassportSignature } from "../passport/verify.js";
import {
  effectiveGrantStatus,
  type GrantRecord,
  GrantStatus,
  type LivenessParams,
  type PrincipalRecord,
} from "./state.js";

/**
 * The one verification predicate (README §7.3):
 *
 *   verify(P, G, e_now) = SigOK(P) ∧ MerkleOK(P, batchRoot) ∧ GrantLive(G) ∧ (e_now ≤ e_attested + g)
 *
 * plus two binding checks the prose implies: the passport's terms are the terms the grantee
 * accepted, and the passport's epoch falls inside the epochs the grant admits.
 * This is the off-chain twin of `FirsthandLens.verify`; reason codes match `VerifyFailure`.
 */
export const VerifyFailure = {
  SIG_INVALID: "SIG_INVALID",
  MERKLE_INVALID: "MERKLE_INVALID",
  ROOT_UNKNOWN: "ROOT_UNKNOWN",
  TERMS_MISMATCH: "TERMS_MISMATCH",
  EPOCH_OUT_OF_GRANT: "EPOCH_OUT_OF_GRANT",
  GRANT_NOT_LIVE: "GRANT_NOT_LIVE",
  GRANT_RESCINDED: "GRANT_RESCINDED",
  GRANT_EXPIRED: "GRANT_EXPIRED",
  GRANT_FROZEN: "GRANT_FROZEN",
  /** The anchored root belongs to a different principal or namespace than the grant. */
  SCOPE_MISMATCH: "SCOPE_MISMATCH",
} as const;
export type VerifyFailure = (typeof VerifyFailure)[keyof typeof VerifyFailure];

export interface GrantForVerify extends GrantRecord {
  readonly termsHash: Bytes32;
  /** When present together with `VerifyInput.anchorOwner`, the root must belong to this principal/namespace. */
  readonly principalId?: Bytes32;
  readonly ns?: number;
}

export interface AnchorOwner {
  readonly principalId: Bytes32;
  readonly ns: number;
}

export interface VerifyInput {
  readonly passport: Passport;
  readonly signature: PassportSignature;
  readonly domain: Eip712Domain;
  readonly proof: BatchProof;
  readonly batchRoot: Bytes32;
  /** Whether `batchRoot` is anchored on-chain for `(principal, ns, epoch)` — supplied by the caller. */
  readonly rootAnchored: boolean;
  /** Who anchored `batchRoot` (from `PassportAnchors.anchorOf`), when known. */
  readonly anchorOwner?: AnchorOwner;
  readonly grant: GrantForVerify;
  readonly principal: PrincipalRecord;
  readonly epochNow: bigint;
  readonly liveness?: LivenessParams;
}

export type VerifyResult =
  | { readonly ok: true; readonly passportId: Bytes32 }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly passportId: Bytes32 };

export function verifyPredicate(input: VerifyInput): VerifyResult {
  const id = passportId(input.passport);
  const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason, passportId: id });

  if (!verifyPassportSignature(input.passport, input.signature, input.domain)) {
    return fail(VerifyFailure.SIG_INVALID);
  }
  if (!input.rootAnchored) return fail(VerifyFailure.ROOT_UNKNOWN);
  if (!verifyPassportInBatch(input.batchRoot, id, input.proof)) {
    return fail(VerifyFailure.MERKLE_INVALID);
  }
  if (input.anchorOwner && input.grant.principalId !== undefined && input.grant.ns !== undefined) {
    if (
      input.anchorOwner.principalId !== input.grant.principalId ||
      input.anchorOwner.ns !== input.grant.ns
    ) {
      return fail(VerifyFailure.SCOPE_MISMATCH);
    }
  }
  if (input.passport.termsHash !== input.grant.termsHash) return fail(VerifyFailure.TERMS_MISMATCH);

  const status = effectiveGrantStatus(input.grant, input.principal, input.epochNow, input.liveness);
  switch (status) {
    case GrantStatus.ACTIVE:
      break;
    case GrantStatus.RESCINDED:
      return fail(VerifyFailure.GRANT_RESCINDED);
    case GrantStatus.EXPIRED:
      return fail(VerifyFailure.GRANT_EXPIRED);
    case GrantStatus.FROZEN:
      return fail(VerifyFailure.GRANT_FROZEN);
    default:
      return fail(VerifyFailure.GRANT_NOT_LIVE);
  }

  // A live grant admits epochs [epochStart, epochNow]; never future epochs.
  if (input.passport.epoch < input.grant.epochStart || input.passport.epoch > input.epochNow) {
    return fail(VerifyFailure.EPOCH_OUT_OF_GRANT);
  }
  return { ok: true, passportId: id };
}
