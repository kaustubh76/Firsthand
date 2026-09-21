import type { ConsentEvent, ReceiptView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import { hashTerms } from "@firsthand/core";
import {
  type LockerSession,
  type ManifestVerdict,
  manifestFromSidecars,
  publishWrap,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { useCallback, useEffect, useState } from "react";
import { Delegate } from "../components/Delegate.js";
import { Portability } from "../components/Portability.js";
import { activate as activateLocker, reattest as reattestLocker } from "../lib/activation.js";
import { formatUsdc } from "../lib/agent.js";
import { type AgentInfo, bindingHolds, fetchAgent } from "../lib/agents.js";
import type { AppConfig } from "../lib/config.js";
import { downloadJson } from "../lib/download.js";
import { reportFailure } from "../lib/failures.js";
import { type Journal, loadJournal, updateJournal } from "../lib/journal.js";
import { describeScan, fetchReceipts, fetchTimeline, type TimelineScan } from "../lib/ledger.js";
import { mergeLedger } from "../lib/ledgerMerge.js";
import { describeLiveness, type Liveness, readerFor } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import { dismissRequest, type GrantRequest, lockerLink } from "../lib/requests.js";
import { fetchSidecar } from "../lib/sidecars.js";
import { NS, PRICE_UNITS, termsFor } from "../lib/terms.js";
import { Hash, Tx } from "../ui/index.js";

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
  liveness,
  onActivated,
  requests,
  onRequests,
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
  liveness: Liveness;
  onActivated: () => void;
  requests: GrantRequest[];
  onRequests: (list: GrantRequest[]) => void;
}) {
  const principalId = session.locker.principalId;
  const [journal, setJournal] = useState<Journal>(() => loadJournal(principalId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ConsentEvent[] | null>(null);
  const [scan, setScan] = useState<TimelineScan | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<{ text: string; verdict: ManifestVerdict } | null>(null);
  const [earnings, setEarnings] = useState<{
    count: number;
    total: bigint;
    rows: { tx: string; grantId: string; block: bigint }[];
  } | null>(null);
  const batches = session.batcher.flushed();
  const waitForTx = client.waitForTx;
  // Who is asking: the requester's ERC-8004 identity, checked against the card in the link.
  const [agents, setAgents] = useState<
    Record<string, { info: AgentInfo | null; verified: boolean; owner: string | null }>
  >({});
  useEffect(() => {
    if (!config.live || !config.gatewayUrl || !client.publicClient) return;
    for (const r of requests) {
      if (!r.agentId || agents[`${r.card}:${r.agentId}`]) continue;
      const key = `${r.card}:${r.agentId}`;
      void (async () => {
        const [info, card] = await Promise.all([
          fetchAgent(config.gatewayUrl as string, r.agentId as string),
          readerFor(config, client.publicClient as NonNullable<typeof client.publicClient>)
            .cardOf(r.card)
            .catch(() => null),
        ]);
        const owner = card?.owner ?? null;
        setAgents((a) => ({
          ...a,
          [key]: { info, verified: bindingHolds(info, r.card, owner), owner },
        }));
      })();
    }
  }, [requests, config, client.publicClient, agents]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(reportFailure(e));
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
      const t = await fetchTimeline(config.gatewayUrl, principalId, from);
      setEvents(t.events);
      setScan(t.scan);
    } catch (e) {
      setLedgerError(reportFailure(e));
    }
  }, [config.live, config.gatewayUrl, principalId]);

  useEffect(() => {
    void refreshLedger();
  }, [refreshLedger]);

  const activate = () =>
    run("activate", async () => {
      await activateLocker(session, client);
      setJournal(loadJournal(principalId));
      onActivated();
      await refreshLedger();
    });

  const reattest = () =>
    run("attest", async () => {
      await reattestLocker(session, client);
      setJournal(loadJournal(principalId));
      onActivated();
      await refreshLedger();
    });

  const approve = (r: GrantRequest) =>
    run(`approve:${r.card}`, async () => {
      if (!config.gatewayUrl) throw new Error("no gateway");
      const termsHash = hashTerms(termsFor(session, r.ns));
      // Grant, wait for inclusion, then hand the gateway the wrap: its ingest checks the grant on
      // chain, and a relayed transaction is accepted long before it is mined.
      const { plan, sent } = await session.grant({
        granteeCard: r.card,
        granteeEncryptionPubKey: r.pub,
        ns: r.ns,
        termsHash,
        term: 4n,
      });
      await waitForTx?.(sent.txHash, "Granted");
      await publishWrap({ gatewayUrl: config.gatewayUrl }, plan.grantId, plan.wrap);
      const known = r.agentId ? agents[`${r.card}:${r.agentId}`] : undefined;
      mutate((j) =>
        j.grants.unshift({
          grantId: plan.grantId,
          granteeCard: r.card,
          ns: r.ns,
          termsHash,
          txHash: sent.txHash,
          at: Date.now(),
          ...(known?.verified && r.agentId
            ? { agentId: r.agentId, ...(known.info?.name ? { agentName: known.info.name } : {}) }
            : {}),
        }),
      );
      onRequests(dismissRequest(r.card, r.ns));
      await refreshLedger();
    });

  const refreshEarnings = useCallback(async () => {
    if (!config.live || !config.gatewayUrl) return;
    const j = loadJournal(principalId);
    const from = j.enrolBlock ? BigInt(j.enrolBlock) : undefined;
    const rows: { tx: string; grantId: string; block: bigint }[] = [];
    try {
      for (const g of j.grants) {
        for (const r of await fetchReceipts(config.gatewayUrl, g.grantId, from)) {
          rows.push({ tx: r.txHash, grantId: r.grantId, block: r.blockNumber });
        }
      }
    } catch (e) {
      // Earnings are a read model over the same ledger the Consent Ledger shows: say so, once.
      setLedgerError(reportFailure(e));
      return;
    }
    setEarnings({ count: rows.length, total: PRICE_UNITS * BigInt(rows.length), rows });
  }, [config.live, config.gatewayUrl, principalId]);

  useEffect(() => {
    void refreshEarnings();
  }, [refreshEarnings]);

  const withdraw = (grantId: Bytes32) =>
    run(`rescind:${grantId}`, async () => {
      // Direct rescission: one passkey-signed transaction, effective at its own block.
      const sent = await session.sendRescind(session.planRescind(grantId));
      await waitForTx?.(sent.txHash, "Consent withdrawn");
      mutate((j) => {
        const g = j.grants.find((x) => x.grantId === grantId);
        if (g) g.rescindTx = sent.txHash;
      });
      await refreshLedger();
    });

  const buildManifest = () =>
    run("manifest", async () => {
      if (!config.gatewayUrl) throw new Error("no gateway");
      // Rebuilt from what the gateway publishes, not from this session's memory: the same file a
      // buyer could assemble, and it survives a reload.
      const receipts = new Map<Bytes32, ReceiptView>();
      const from = journal.enrolBlock ? BigInt(journal.enrolBlock) : undefined;
      for (const g of journal.grants) {
        for (const r of await fetchReceipts(config.gatewayUrl, g.grantId, from)) {
          const entry = journal.receipts.find((x) => x.receiptId === r.receiptId);
          if (entry) receipts.set(entry.passportId, r);
        }
      }
      const sidecars = [];
      for (const d of journal.deposits) {
        if (d.ns !== NS.captures || !d.published) continue;
        const sc = await fetchSidecar(config.gatewayUrl, d.passportId);
        if (sc) sidecars.push(sc);
      }
      if (sidecars.length === 0) throw new Error("no published captures to export yet");
      const m = await manifestFromSidecars({
        domain: session.locker.domain,
        principalId,
        ns: NS.captures,
        sidecars,
        anchors: client.anchors,
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
    if (manifest) downloadJson(`lineage-${principalId.slice(2, 10)}.json`, manifest.text);
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
        principal <Hash value={principalId} /> · epoch {session.locker.currentEpoch().toString()} ·
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
      {liveness.kind !== "unknown" && (
        <p className="hint" data-testid="liveness">
          {describeLiveness(liveness)}
        </p>
      )}
      {liveness.kind === "attest-needed" || (liveness.kind === "live" && activated) ? (
        <button type="button" disabled={!config.live || busy !== null} onClick={reattest}>
          {busy === "attest" ? "Attesting…" : "Re-attest this epoch"}
        </button>
      ) : (
        <button type="button" disabled={!config.live || busy !== null} onClick={activate}>
          {busy === "activate" ? "Activating…" : "Activate on chain (enroll + attest)"}
        </button>
      )}
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
              {b.passports.length === 1 ? "" : "s"} · root <Hash value={b.root} n={6} />
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

      <Delegate session={session} config={config} principalId={principalId} />

      <Portability
        config={config}
        principalId={principalId}
        grantIds={journal.grants.map((g) => g.grantId)}
      />

      <h2>Share your locker</h2>
      <p className="hint">
        A buyer starts from this link: it lists what you published (never the plaintext) and lets an
        agent ask for access — <code>firsthand_request_access</code> in the MCP takes a principal
        id.
      </p>
      <p>
        <code className="hex" data-testid="locker-link">
          {lockerLink(location.origin, principalId)}
        </code>{" "}
        <button
          type="button"
          className="inline"
          onClick={() =>
            void navigator.clipboard?.writeText(lockerLink(location.origin, principalId))
          }
        >
          copy
        </button>
      </p>

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
              <Hash value={d.passportId} />
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

      {requests.length > 0 && (
        <>
          <h2>Access requests</h2>
          <p className="hint">
            A buyer asked for access by sending you a link. Approving is one passkey-signed grant
            under your terms ({formatUsdc(PRICE_UNITS)} per query); the vault key is sealed to their
            card, the gateway gets only the wrap.
          </p>
          <ul data-testid="requests">
            {requests.map((r) => {
              const known = r.agentId ? agents[`${r.card}:${r.agentId}`] : undefined;
              return (
                <li key={`${r.card}-${r.ns}`}>
                  <strong>{r.label}</strong> asks for namespace {r.ns} · card{" "}
                  <Hash value={r.card} n={6} />
                  <br />
                  <span className="hint" data-testid="agent-identity">
                    {!r.agentId
                      ? "no ERC-8004 identity — an unverified card"
                      : !known
                        ? `ERC-8004 agent #${r.agentId} — checking…`
                        : !known.info
                          ? `ERC-8004 agent #${r.agentId} — not found in the registry`
                          : known.verified
                            ? `ERC-8004 agent #${r.agentId}${known.info.name ? ` “${known.info.name}”` : ""} · owner ${known.info.owner.slice(0, 10)}… · binding verified ✓ · ${known.info.reputation.paidQueriesHere} paid quer${known.info.reputation.paidQueriesHere === "1" ? "y" : "ies"} credited here`
                            : `ERC-8004 agent #${r.agentId} — binding does NOT match this card ✗`}
                  </span>{" "}
                  <button
                    type="button"
                    className="inline"
                    disabled={!config.live || busy !== null || liveness.kind !== "live"}
                    onClick={() => approve(r)}
                  >
                    {busy === `approve:${r.card}` ? "Granting…" : "Approve with passkey"}
                  </button>{" "}
                  <button
                    type="button"
                    className="inline"
                    onClick={() => onRequests(dismissRequest(r.card, r.ns))}
                  >
                    dismiss
                  </button>
                </li>
              );
            })}
          </ul>
        </>
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
              grant <Hash value={g.grantId} /> → card <Hash value={g.granteeCard} n={6} /> · ns{" "}
              {g.ns} · <Tx hash={g.txHash} chainId={config.chainId} label="granted" />
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

      <h2>Earnings</h2>
      <p className="hint">
        Every paid query leaves a receipt on chain; the RoyaltyRouter splits the price to your
        deposit key at settlement.{" "}
        <button type="button" className="inline" onClick={() => void refreshEarnings()}>
          refresh
        </button>
      </p>
      {earnings === null ? (
        <p className="hint">{config.live ? "reading…" : "unavailable offline"}</p>
      ) : (
        <p data-testid="earnings">
          {earnings.count} receipt{earnings.count === 1 ? "" : "s"} · {formatUsdc(earnings.total)}
          {earnings.rows.slice(0, 5).map((r) => (
            <span key={r.tx}>
              {" "}
              · <Tx hash={r.tx} chainId={config.chainId} label={`block ${r.block}`} />
            </span>
          ))}
        </p>
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
      {describeScan(scan) && (
        <p className="hint" data-testid="ledger-scan">
          {describeScan(scan)}
        </p>
      )}
      {(() => {
        const rows = mergeLedger(principalId, events ?? [], journal);
        if (events === null && rows.length === 0) {
          return <p className="hint">{config.live ? "reading…" : "unavailable offline"}</p>;
        }
        if (rows.length === 0) return <p className="hint">no events yet</p>;
        return (
          <table className="ledger" data-testid="ledger">
            <tbody>
              {rows.map((e) => (
                <tr key={`${e.kind}-${e.txHash ?? e.grantId ?? ""}`} data-source={e.source}>
                  <td>{e.kind}</td>
                  <td>
                    {e.blockNumber === null ? (
                      <span className="hint">local record</span>
                    ) : (
                      `block ${e.blockNumber.toString()}`
                    )}
                  </td>
                  <td>{e.grantId ? <Hash value={e.grantId} n={6} /> : ""}</td>
                  <td>{e.txHash ? <Tx hash={e.txHash} chainId={config.chainId} /> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
      <p className="hint">
        The gateway reads a bounded window of blocks per request; rows marked <em>local record</em>{" "}
        are this browser's own transactions from beyond that window.
      </p>

      <h2>Lineage Manifest</h2>
      <p className="hint">
        One file that answers per-asset diligence: origin signature, batch proof, anchor, receipt.
        Verified here against the chain — no gateway in the loop.
      </p>
      <button
        type="button"
        onClick={buildManifest}
        disabled={!config.live || journal.deposits.length === 0 || busy !== null}
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
