import { LIVENESS_GRACE_EPOCHS } from "../constants.js";
import { isWithinGrace } from "../epoch/epoch.js";
import { GrantError } from "../errors.js";

/**
 * Grant lifecycle (README §7.5): `NONE → ACTIVE → (RESCINDED | EXPIRED | FROZEN)`.
 * Numeric values match `GrantStatus` in `contracts/src/types/Structs.sol`.
 */
export const GrantStatus = {
  NONE: 0,
  ACTIVE: 1,
  RESCINDED: 2,
  EXPIRED: 3,
  FROZEN: 4,
} as const;
export type GrantStatus = (typeof GrantStatus)[keyof typeof GrantStatus];

export const PrincipalStatus = {
  NONE: 0,
  ACTIVE: 1,
  FROZEN: 2,
} as const;
export type PrincipalStatus = (typeof PrincipalStatus)[keyof typeof PrincipalStatus];

/** Stored grant fields that matter to the state machine (subset of §11 `GrantState`). */
export interface GrantRecord {
  /** Stored status — only ACTIVE or RESCINDED are ever *written*; the rest are derived lazily. */
  readonly status: GrantStatus;
  readonly epochStart: bigint;
  /** Term length in epochs; the grant expires at `epochStart + term`. */
  readonly term: bigint;
}

export interface PrincipalRecord {
  readonly lastAttestedEpoch: bigint;
}

export interface LivenessParams {
  readonly grace?: bigint;
}

/**
 * Effective status at `epochNow`, evaluated lazily — no keepers (README §7.3/§7.5).
 * Precedence: RESCINDED (terminal) > EXPIRED (term elapsed) > FROZEN (principal liveness) > ACTIVE.
 * FROZEN is deliberately *not* terminal: a principal who re-attests thaws future epochs (§7.6).
 */
export function effectiveGrantStatus(
  grant: GrantRecord,
  principal: PrincipalRecord,
  epochNow: bigint,
  params: LivenessParams = {},
): GrantStatus {
  if (grant.status === GrantStatus.NONE) return GrantStatus.NONE;
  if (grant.status === GrantStatus.RESCINDED) return GrantStatus.RESCINDED;
  if (epochNow >= grant.epochStart + grant.term) return GrantStatus.EXPIRED;
  if (
    !isWithinGrace(epochNow, principal.lastAttestedEpoch, params.grace ?? LIVENESS_GRACE_EPOCHS)
  ) {
    return GrantStatus.FROZEN;
  }
  return GrantStatus.ACTIVE;
}

export function isGrantLive(
  grant: GrantRecord,
  principal: PrincipalRecord,
  epochNow: bigint,
  params: LivenessParams = {},
): boolean {
  return effectiveGrantStatus(grant, principal, epochNow, params) === GrantStatus.ACTIVE;
}

export type GrantEvent = { readonly type: "grant" } | { readonly type: "rescind" };

/**
 * Explicit (written) transitions. Only two exist: NONE→ACTIVE on grant, ACTIVE→RESCINDED on
 * rescind. Everything else is derived by `effectiveGrantStatus` and never written back —
 * which is what guarantees "no transition ever re-releases a wrapped key".
 */
export function nextGrantStatus(current: GrantStatus, event: GrantEvent): GrantStatus {
  switch (event.type) {
    case "grant":
      if (current === GrantStatus.NONE) return GrantStatus.ACTIVE;
      throw new GrantError("FH_GRANT_NOT_LIVE", "grant: already exists", {
        context: { current },
      });
    case "rescind":
      if (current === GrantStatus.ACTIVE) return GrantStatus.RESCINDED;
      if (current === GrantStatus.RESCINDED) {
        throw new GrantError("FH_GRANT_RESCINDED", "rescind: already rescinded");
      }
      throw new GrantError("FH_GRANT_NOT_LIVE", "rescind: grant is not active", {
        context: { current },
      });
    default: {
      const never: never = event;
      throw new GrantError("FH_GRANT_NOT_LIVE", `unknown event ${JSON.stringify(never)}`);
    }
  }
}
