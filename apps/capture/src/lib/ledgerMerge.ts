import type { ConsentEvent, ConsentEventKind } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import type { Journal } from "./journal.js";

/** A ledger row: what the chain said, or — beyond the gateway's scan window — what this browser did. */
export interface LedgerRow {
  readonly kind: ConsentEventKind;
  readonly txHash: Bytes32 | null;
  readonly grantId: Bytes32 | null;
  /** Block number when the gateway saw the event; null for a journal-only row. */
  readonly blockNumber: bigint | null;
  /** Block time (seconds) from the chain, or the browser's clock (ms → s) for a journal row. */
  readonly timestamp: bigint | null;
  readonly granteeCard: Bytes32 | null;
  readonly ns: number | null;
  readonly source: "chain" | "local";
  /**
   * `rescinded` only: the block the transaction landed in, when consent ended earlier than that.
   * They differ exactly on the commit-reveal path, where `blockNumber` is the commit's block.
   */
  readonly recordedBlock: bigint | null;
  readonly viaCommitReveal: boolean;
}

/**
 * Gateway events win (they carry block numbers); journal entries fill in whatever the log scan no
 * longer reaches, keyed by transaction hash so nothing is listed twice.
 */
export function mergeLedger(
  principalId: Bytes32,
  events: readonly ConsentEvent[],
  journal: Journal,
): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  const key = (kind: string, tx: string | null, grantId: string | null) =>
    `${kind}:${tx ?? grantId ?? "?"}`;
  for (const e of events) {
    if (e.principalId !== principalId) continue;
    rows.set(key(e.kind, e.txHash, e.grantId), {
      kind: e.kind,
      txHash: e.txHash,
      grantId: e.grantId,
      blockNumber: e.blockNumber,
      timestamp: e.timestamp,
      granteeCard: e.granteeCard ?? null,
      ns: e.ns ?? null,
      source: "chain",
      recordedBlock: e.recordedBlock ?? null,
      viaCommitReveal: e.viaCommitReveal === true,
    });
  }
  // Grant details travel with a `granted` event; a rescission names only the grant, so both rows
  // borrow card and namespace from the journal when it knows the grant.
  const byGrant = new Map(journal.grants.map((g) => [g.grantId, g]));
  for (const [k, row] of rows) {
    if (row.grantId && (row.granteeCard === null || row.ns === null)) {
      const g = byGrant.get(row.grantId);
      if (g)
        rows.set(k, { ...row, granteeCard: row.granteeCard ?? g.granteeCard, ns: row.ns ?? g.ns });
    }
  }
  const local = (
    kind: ConsentEventKind,
    txHash: Bytes32 | undefined,
    grantId: Bytes32 | null,
    at: number | undefined,
  ) => {
    if (!txHash) return;
    const k = key(kind, txHash, grantId);
    const g = grantId ? byGrant.get(grantId) : undefined;
    if (!rows.has(k)) {
      rows.set(k, {
        kind,
        txHash,
        grantId,
        blockNumber: null,
        timestamp: at ? BigInt(Math.floor(at / 1000)) : null,
        granteeCard: g?.granteeCard ?? null,
        ns: g?.ns ?? null,
        source: "local",
        // A journal row knows only that this browser sent it, never which block it landed in.
        recordedBlock: null,
        viaCommitReveal: false,
      });
    }
  };
  local("enrolled", journal.enrolTx, null, undefined);
  local("attested", journal.attestTx, null, undefined);
  for (const g of journal.grants) {
    local("granted", g.txHash, g.grantId, g.at);
    local("rescinded", g.rescindTx, g.grantId, g.rescindAt);
  }
  const order: Record<ConsentEventKind, number> = {
    enrolled: 0,
    attested: 1,
    granted: 2,
    rescinded: 3,
    frozen: 4,
    expired: 5,
  };
  return [...rows.values()].sort((a, b) => {
    if (a.blockNumber !== null && b.blockNumber !== null)
      return Number(a.blockNumber - b.blockNumber);
    if (a.blockNumber !== null) return -1;
    if (b.blockNumber !== null) return 1;
    return order[a.kind] - order[b.kind];
  });
}
