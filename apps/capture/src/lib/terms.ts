import { type Address, LICENSE_FH_1_0, Scope, type Terms, WAD } from "@firsthand/core";
import type { LockerSession } from "@firsthand/sdk/browser";

/** Namespaces this app deposits into; the label is what the locker shows. */
export const NS = { captures: 0, imports: 1 } as const;

/** Price per query, in USDC base units (6 decimals): 0.001 USDC. */
export const PRICE_UNITS = 1_000n;

/**
 * The one set of terms every deposit from this app is offered under, so the demand side can
 * reconstruct exactly what it must accept: `acceptTerms` is by preimage, and a grant only matches a
 * passport whose termsHash is the hash of these. The payee is the namespace's deposit key.
 */
export function termsFor(session: LockerSession, ns: number): Terms {
  return {
    price: PRICE_UNITS,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN | Scope.EVAL,
    ns,
    rateLimit: 100,
    payees: [session.locker.depositKey(ns).address as Address],
    weights: [WAD],
  };
}
