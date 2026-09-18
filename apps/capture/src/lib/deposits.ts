import type { Bytes32 } from "@firsthand/core";
import type { DepositResult, LockerSession } from "@firsthand/sdk/browser";
import type { AppConfig } from "./config.js";
import { type DepositEntry, updateJournal } from "./journal.js";
import { termsFor } from "./terms.js";

/**
 * Every deposit from this app goes through here: mint + seal locally, record it, and — when a chain
 * is reachable — anchor the batch and hand the gateway the ciphertext and sidecar so a buyer's query
 * can be served. A passport nobody can fetch is not a deposit.
 */
export interface Landed {
  readonly result: DepositResult;
  readonly entry: DepositEntry;
}

export async function land(
  session: LockerSession,
  config: AppConfig,
  results: readonly { result: DepositResult; label: string; kind: DepositEntry["kind"] }[],
  ns: number,
): Promise<Landed[]> {
  const principalId = session.locker.principalId;
  const entries: Landed[] = results.map(({ result, label, kind }) => ({
    result,
    entry: {
      passportId: result.passportId,
      label,
      kind,
      ns,
      blobId: result.blob.id as Bytes32,
      at: Date.now(),
    },
  }));
  updateJournal(principalId, (j) => {
    for (const { entry } of entries) j.deposits.unshift(entry);
  });
  if (!(config.live && config.gatewayUrl)) return entries;

  const anchored = await session.flush();
  const txOf = new Map<Bytes32, Bytes32>();
  for (const batch of anchored) {
    for (const id of batch.proofs.keys()) {
      if (batch.anchor.txHash) txOf.set(id, batch.anchor.txHash as Bytes32);
    }
  }
  const terms = termsFor(session, ns);
  for (const landed of entries) {
    await session.publish({ gatewayUrl: config.gatewayUrl }, landed.result, terms);
    const anchorTx = txOf.get(landed.entry.passportId);
    if (anchorTx) landed.entry.anchorTx = anchorTx;
    landed.entry.published = true;
  }
  updateJournal(principalId, (j) => {
    for (const { entry } of entries) {
      const row = j.deposits.find((d) => d.passportId === entry.passportId);
      if (row) {
        if (entry.anchorTx) row.anchorTx = entry.anchorTx;
        row.published = entry.published ?? false;
      }
    }
  });
  return entries;
}
