import { type OnchainLensReader, type Pacer, pacedMap } from "@firsthand/adapters/client";
import type { Bytes32, LineageManifest } from "@firsthand/core";

/**
 * The chain's own answer, asked about a Lineage Manifest (README §7.3, §9).
 *
 * `verifyManifest` proves what happened: these passports were signed by this principal, anchored in
 * these roots, and paid for by these receipts. It is history, and history does not change — a
 * manifest of a rescinded grant still verifies, and should.
 *
 * `FirsthandLens.verify` answers a different question, in the present tense: would this passport be
 * served under this grant *now*? That is the compliance question a buyer's file cannot answer about
 * itself, because consent can end after the sale. Asking the Lens is also the only way the twin
 * claim — that the chain runs the same predicate, with the same reasons, as `verifyPredicate` in
 * `@firsthand/core` — is visible to someone who has not run the test suite.
 *
 * One `eth_call` per asset that carries a receipt; an asset with no receipt names no grant, so
 * there is nothing to ask.
 */
export interface LensRow {
  readonly passportId: Bytes32;
  readonly grantId: Bytes32;
  readonly ok: boolean;
  readonly reason: string;
}

export interface LensReport {
  readonly rows: readonly LensRow[];
  /** Assets carrying no receipt: no grant, so no question to put to the chain. */
  readonly unasked: number;
  readonly standing: number;
  readonly address: string;
}

export async function askLens(
  lens: OnchainLensReader,
  manifest: LineageManifest,
  pacer: Pacer,
): Promise<LensReport> {
  // One `eth_call` per asset that carries a receipt, and irreducibly so: the Lens verifies *this*
  // passport's inclusion under that grant, so two assets sharing a grant still need two calls.
  // A pasted manifest sets the length, so the reads are paced rather than fired all at once —
  // this runs on the public Verify tab, where the input is a stranger's file.
  let unasked = 0;
  const asked = manifest.assets.filter((asset) => {
    if (asset.receipt?.grantId !== undefined) return true;
    unasked += 1;
    return false;
  });
  const rows: LensRow[] = await pacedMap(
    asked,
    async (asset) => {
      const grantId = asset.receipt?.grantId as Bytes32;
      // A read that fails is reported as a read that failed, never as a refusal by the chain.
      const verdict = await lens
        .verify(asset, grantId)
        .catch((e: unknown) => ({ ok: false, reason: `unreadable: ${(e as Error).message}` }));
      return {
        passportId: asset.signed.passport.h,
        grantId,
        ok: verdict.ok,
        reason: verdict.reason,
      };
    },
    pacer,
  );
  return {
    rows,
    unasked,
    standing: rows.filter((r) => r.ok).length,
    address: lens.address,
  };
}

/** One sentence for the screen; null when there was nothing to ask. */
export function describeLens(report: LensReport | null): string | null {
  if (report === null) return null;
  if (report.rows.length === 0) {
    return report.unasked === 0
      ? null
      : `consent now: not asked — no asset in this file names a grant (${report.unasked} unpaid)`;
  }
  const refused = report.rows.length - report.standing;
  return (
    `consent now: FirsthandLens says ${report.standing} of ${report.rows.length} grant(s) would still be served` +
    (refused > 0 ? ` · ${refused} refused` : "") +
    (report.unasked > 0 ? ` · ${report.unasked} asset(s) carry no receipt to ask about` : "")
  );
}
