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
  readonly source: "chain" | "local";
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
      source: "chain",
    });
  }
  const local = (kind: ConsentEventKind, txHash: Bytes32 | undefined, grantId: Bytes32 | null) => {
    if (!txHash) return;
    const k = key(kind, txHash, grantId);
    if (!rows.has(k)) rows.set(k, { kind, txHash, grantId, blockNumber: null, source: "local" });
  };
  local("enrolled", journal.enrolTx, null);
  local("attested", journal.attestTx, null);
  for (const g of journal.grants) {
    local("granted", g.txHash, g.grantId);
    local("rescinded", g.rescindTx, g.grantId);
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
