import type { ConsentEvent, ReceiptView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import {
  exportManifest,
  type LockerSession,
  type ManifestVerdict,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { useCallback, useEffect, useState } from "react";
import { Hex, Tx } from "../components/Tx.js";
import type { AppConfig } from "../lib/config.js";
import { type Journal, loadJournal, updateJournal } from "../lib/journal.js";
import { fetchReceipts, fetchTimeline } from "../lib/ledger.js";
import type { CaptureClient } from "../lib/locker.js";
import { NS } from "../lib/terms.js";

/**
 * The locker's own view: activation on chain, what has been anchored, the Consent Ledger (what the
 * chain says about this principal, merged with what this browser did), every grant with a one-tap
 * withdrawal, and the Lineage Manifest — the buyer's diligence file, verified here against the chain.
 * Every write goes through the gateway's relay: the browser holds no key and pays no gas.
 */
export function LockerView({
  session,
  config,
  client,
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
}) {
  const principalId = session.locker.principalId;
  const [journal, setJournal] = useState<Journal>(() => loadJournal(principalId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ConsentEvent[] | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<{ text: string; verdict: ManifestVerdict } | null>(null);
  const batches = session.batcher.flushed();
  const waitForTx = client.waitForTx;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const mutate = (fn: (j: Journal) => void) => setJournal(updateJournal(principalId, fn));

  const refreshLedger = useCallback(async () => {
    if (!config.live || !config.gatewayUrl) return;
    setLedgerError(null);
    try {
      const j = loadJournal(principalId);
      const from = j.enrolBlock ? BigInt(j.enrolBlock) : undefined;
      setEvents(await fetchTimeline(config.gatewayUrl, principalId, from));
    } catch (e) {
      setLedgerError((e as Error).message);
    }
  }, [config.live, config.gatewayUrl, principalId]);

  useEffect(() => {
    void refreshLedger();
  }, [refreshLedger]);

  const activate = () =>
    run("activate", async () => {
      const enrolled = await session.enroll();
      // attest reads the principal enrol wrote, so it must wait for inclusion — relaying returns as
      // soon as the gateway accepts the transaction, not when it lands.
      await waitForTx?.(enrolled.txHash);
      const attested = await session.attest();
      await waitForTx?.(attested.txHash);
      let enrolBlock: string | undefined;
      if (client.publicClient) {
        const receipt = await client.publicClient.getTransactionReceipt({ hash: enrolled.txHash });
        enrolBlock = receipt.blockNumber.toString();
      }
      mutate((j) => {
        j.enrolTx = enrolled.txHash;
        j.attestTx = attested.txHash;
        if (enrolBlock) j.enrolBlock = enrolBlock;
      });
      await refreshLedger();
    });

  const withdraw = (grantId: Bytes32) =>
    run(`rescind:${grantId}`, async () => {
      // Direct rescission: one passkey-signed transaction, effective at its own block.
      const sent = await session.sendRescind(session.planRescind(grantId));
      await waitForTx?.(sent.txHash);
      mutate((j) => {
        const g = j.grants.find((x) => x.grantId === grantId);
        if (g) g.rescindTx = sent.txHash;
      });
      await refreshLedger();
    });

  const buildManifest = () =>
    run("manifest", async () => {
      const receipts = new Map<Bytes32, ReceiptView>();
      if (config.live && config.gatewayUrl) {
        for (const g of journal.grants) {
          for (const r of await fetchReceipts(config.gatewayUrl, g.grantId)) {
            const entry = journal.receipts.find((x) => x.receiptId === r.receiptId);
            if (entry) receipts.set(entry.passportId, r);
          }
        }
      }
      const m = exportManifest({
        domain: session.locker.domain,
        principalId,
        ns: NS.captures,
        batches: batches.filter((b) => b.ns === NS.captures),
        receipts,
        finalityDepth: 0,
      });
      const headBlock = client.publicClient
        ? await client.publicClient.getBlockNumber({ cacheTime: 0 })
        : 0n;
      const verdict = await verifyManifest(m, { anchors: client.anchors, headBlock });
      setManifest({ text: serialiseManifest(m), verdict });
    });

  const download = () => {
    if (!manifest) return;
    const blob = new Blob([manifest.text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lineage-${principalId.slice(2, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const rescindedIds = new Set(
    (events ?? []).filter((e) => e.kind === "rescinded").map((e) => e.grantId),
  );
  const grants = journal.grants.map((g) => ({
    ...g,
    rescinded: g.rescindTx !== undefined || rescindedIds.has(g.grantId),
  }));
  const activated = journal.attestTx !== undefined;

  return (
    <section>
      <h1>Locker</h1>
      <p className="lede">
        principal <Hex value={principalId} /> · epoch {session.locker.currentEpoch().toString()} ·
        pending {session.batcher.pendingCount()}
      </p>
      {!config.live && (
        <p className="error">
          Offline: nothing here reaches a chain ({config.reason}). Open the app with
          <code> ?gateway=https://…</code> to use another gateway.
        </p>
      )}

      <h2>On chain</h2>
      <p className="hint">
        A passport can only be anchored under an attested deposit key, so activation — enroll the
        principal, attest this epoch's keys — comes first. Two relayed transactions.
      </p>
      <button type="button" disabled={!config.live || busy !== null} onClick={activate}>
        {busy === "activate"
          ? "Activating…"
          : activated
            ? "Re-attest this epoch"
            : "Activate on chain (enroll + attest)"}
      </button>
      {journal.enrolTx && journal.attestTx && (
        <p>
          <Tx hash={journal.enrolTx} chainId={config.chainId} label="enrolled" /> ·{" "}
          <Tx hash={journal.attestTx} chainId={config.chainId} label="attested" />
          {journal.enrolBlock && <> · from block {journal.enrolBlock}</>}
        </p>
      )}
      <button
        type="button"
        onClick={() => run("anchor", () => session.flush().then(() => undefined))}
        disabled={session.batcher.pendingCount() === 0 || busy !== null}
      >
        {busy === "anchor" ? "Anchoring…" : "Anchor pending batch"}
      </button>
      {error && <p className="error">{error}</p>}
      {batches.length > 0 && (
        <ul>
          {batches.map((b) => (
            <li key={b.root}>
              ns {b.ns} · epoch {b.epoch.toString()} · {b.passports.length} passport
              {b.passports.length === 1 ? "" : "s"} · root <Hex value={b.root} n={6} />
              {b.anchor.txHash && (
                <>
                  {" "}
                  · <Tx hash={b.anchor.txHash} chainId={config.chainId} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Deposits</h2>
      {journal.deposits.length === 0 ? (
        <p className="hint">Nothing yet — stamp something on the Capture tab.</p>
      ) : (
        <ul>
          {journal.deposits.map((d) => (
            <li key={d.passportId}>
              <strong>{d.label}</strong>{" "}
              <span className="hint">
                ({d.kind}, ns {d.ns})
              </span>
              <br />
              <Hex value={d.passportId} />
              {d.anchorTx && (
                <>
                  {" "}
                  · <Tx hash={d.anchorTx} chainId={config.chainId} label="anchored" />
                </>
              )}
              {d.published ? " · published" : " · not published"}
            </li>
          ))}
        </ul>
      )}

      <h2>Grants</h2>
      <p className="hint">
        Consent, per buyer card and namespace. Withdrawing it is one passkey-signed transaction; the
        gateway refuses the next query at that block, and the ledger dates it.
      </p>
      {grants.length === 0 ? (
        <p className="hint">No grants yet — run a buyer on the Recall tab.</p>
      ) : (
        <ul data-testid="grants">
          {grants.map((g) => (
            <li key={g.grantId}>
              grant <Hex value={g.grantId} /> → card <Hex value={g.granteeCard} n={6} /> · ns {g.ns}{" "}
              · <Tx hash={g.txHash} chainId={config.chainId} label="granted" />
              {g.rescinded ? (
                <>
                  {" "}
                  · <strong>withdrawn</strong>
                  {g.rescindTx && (
                    <>
                      {" "}
                      <Tx hash={g.rescindTx} chainId={config.chainId} />
                    </>
                  )}
                </>
              ) : (
                <>
                  {" "}
                  <button
                    type="button"
                    className="inline"
                    disabled={!config.live || busy !== null}
                    onClick={() => withdraw(g.grantId)}
                  >
                    {busy === `rescind:${g.grantId}` ? "Withdrawing…" : "Withdraw consent"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Consent Ledger</h2>
      <p className="hint">
        What the chain says about this principal, read from event logs by the gateway
        {journal.enrolBlock ? ` since block ${journal.enrolBlock}` : ""}.{" "}
        <button type="button" className="inline" onClick={() => void refreshLedger()}>
          refresh
        </button>
      </p>
      {ledgerError && <p className="error">{ledgerError}</p>}
      {events === null ? (
        <p className="hint">{config.live ? "reading…" : "unavailable offline"}</p>
      ) : events.length === 0 ? (
        <p className="hint">no events in range</p>
      ) : (
        <table className="ledger" data-testid="ledger">
          <tbody>
            {events.map((e) => (
              <tr key={`${e.kind}-${e.txHash ?? e.blockNumber}-${e.grantId ?? ""}`}>
                <td>{e.kind}</td>
                <td>block {e.blockNumber.toString()}</td>
                <td>{e.grantId ? <Hex value={e.grantId} n={6} /> : ""}</td>
                <td>{e.txHash ? <Tx hash={e.txHash} chainId={config.chainId} /> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Lineage Manifest</h2>
      <p className="hint">
        One file that answers per-asset diligence: origin signature, batch proof, anchor, receipt.
        Verified here against the chain — no gateway in the loop.
      </p>
      <button
        type="button"
        onClick={buildManifest}
        disabled={batches.length === 0 || busy !== null}
      >
        {busy === "manifest" ? "Verifying…" : "Export + verify manifest"}
      </button>
      {manifest && (
        <p data-testid="manifest">
          {manifest.verdict.ok ? "verifies" : "FAILS"} · {manifest.verdict.assets.length} asset
          {manifest.verdict.assets.length === 1 ? "" : "s"} · {manifest.verdict.hashesPerAsset}{" "}
          hashes/asset · {manifest.verdict.ms.toFixed(0)} ms{" "}
          <button type="button" className="inline" onClick={download}>
            download JSON
          </button>
        </p>
      )}
    </section>
  );
}
