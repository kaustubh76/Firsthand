import type { ConsentEvent, OnchainLensReader } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import type { LockerSession } from "@firsthand/sdk/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Delegate } from "../components/Delegate.js";
import { Portability } from "../components/Portability.js";
import { useAsyncActions } from "../hooks/useAsyncActions.js";
import { useJournal } from "../hooks/useJournal.js";
import type { AppConfig } from "../lib/config.js";
import { type Earnings, fetchEarnings, ownTerms } from "../lib/earnings.js";
import { reportFailure } from "../lib/failures.js";
import { fetchGrantStatuses, type GrantChainStatus } from "../lib/grants.js";
import { fetchReceipts, fetchTimeline, type TimelineScan } from "../lib/ledger.js";
import { type Liveness, readerFor } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import type { GrantRequest } from "../lib/requests.js";
import { fetchRevealWindow } from "../lib/rescind.js";
import { NS, termsFor } from "../lib/terms.js";
import { Hash, Notice, Pill } from "../ui/index.js";
import { ActivityCard } from "./locker/ActivityCard.js";
import { DepositsCard } from "./locker/DepositsCard.js";
import { EarningsCard } from "./locker/EarningsCard.js";
import { GrantsCard } from "./locker/GrantsCard.js";
import { LedgerCard } from "./locker/LedgerCard.js";
import { ManifestCard } from "./locker/ManifestCard.js";
import { OnChainCard } from "./locker/OnChainCard.js";
import { RequestsCard } from "./locker/RequestsCard.js";
import { ShareCard } from "./locker/ShareCard.js";
import { StatTiles } from "./locker/StatTiles.js";
import type { LockerAction, LockerCtx } from "./locker/types.js";

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
  const [journal, mutate] = useJournal(principalId);
  const actions = useAsyncActions<LockerAction>({ explain: reportFailure });

  // The Consent Ledger: the gateway's event scan since the enrol block.
  const [events, setEvents] = useState<ConsentEvent[] | null>(null);
  const [scan, setScan] = useState<TimelineScan | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const refreshLedger = useCallback(async () => {
    if (!config.live || !config.gatewayUrl) return;
    setLedgerError(null);
    setLedgerBusy(true);
    try {
      const from = journal.enrolBlock ? BigInt(journal.enrolBlock) : undefined;
      const t = await fetchTimeline(config.gatewayUrl, principalId, from);
      setEvents(t.events);
      setScan(t.scan);
    } catch (e) {
      setLedgerError(reportFailure(e));
    } finally {
      setLedgerBusy(false);
    }
  }, [config.live, config.gatewayUrl, principalId, journal.enrolBlock]);
  useEffect(() => {
    void refreshLedger();
  }, [refreshLedger]);

  // Earnings: a read model over the receipts of every grant this browser issued.
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earningsError, setEarningsError] = useState<string | null>(null);
  const [earningsBusy, setEarningsBusy] = useState(false);
  const grantIds = useMemo(() => journal.grants.map((g) => g.grantId), [journal.grants]);
  const grantKey = grantIds.join(",");
  const refreshEarnings = useCallback(async () => {
    if (!config.live || !config.gatewayUrl) return;
    setEarningsBusy(true);
    setEarningsError(null);
    const from = journal.enrolBlock ? BigInt(journal.enrolBlock) : undefined;
    try {
      const receipts = [];
      for (const id of grantIds) {
        receipts.push(...(await fetchReceipts(config.gatewayUrl, id, from)));
      }
      // Priced from the chain's registered terms, split by the terms' own weights — see
      // `lib/earnings.ts` for what this replaced.
      const reader = client.publicClient ? readerFor(config, client.publicClient) : null;
      setEarnings(
        reader === null
          ? {
              count: receipts.length,
              settled: 0n,
              yours: 0n,
              unattributed: receipts.length,
              rows: [],
            }
          : await fetchEarnings(
              receipts,
              reader,
              ownTerms(Object.values(NS).map((ns) => termsFor(session, ns))),
            ),
      );
    } catch (e) {
      setEarningsError(reportFailure(e));
    } finally {
      setEarningsBusy(false);
    }
    // grantKey stands in for grantIds so a new grant re-reads without a new array identity.
  }, [config.live, config.gatewayUrl, journal.enrolBlock, grantKey, client, session]);
  useEffect(() => {
    void refreshEarnings();
  }, [refreshEarnings]);

  // Grant status from the contract, refining what the journal and the events already say.
  const [statuses, setStatuses] = useState<Map<Bytes32, GrantChainStatus> | null>(null);
  const refreshStatuses = useCallback(async () => {
    if (!config.live || !client.publicClient) return;
    if (grantIds.length === 0) {
      setStatuses(new Map());
      return;
    }
    // Through the Lens where the gateway names it — the contract's own dashboard read (§7.3, §9) —
    // and through GrantManager where it does not. Same precedence, published address.
    const reader = readerFor(config, client.publicClient);
    const statusOf = client.lens
      ? (id: Bytes32) => (client.lens as OnchainLensReader).grantStatus(id)
      : (id: Bytes32) => reader.effectiveStatus(id);
    setStatuses(await fetchGrantStatuses(statusOf, grantIds));
  }, [config, client.publicClient, grantKey]);
  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  // A committed-but-unrevealed withdrawal has a deadline: `revealRescind` refuses once
  // `head - commitBlock > revealWindowBlocks`. Read both, and only while something is pending.
  const pendingCommits = journal.pendingRescissions?.length ?? 0;
  const [reveal, setReveal] = useState<{ window: bigint | null; head: bigint | null }>({
    window: null,
    head: null,
  });
  useEffect(() => {
    if (pendingCommits === 0 || !client.publicClient) return;
    const read = async () => {
      const [window, head] = await Promise.all([
        fetchRevealWindow(config, client),
        client.publicClient?.getBlockNumber({ cacheTime: 0 }).catch(() => null) ?? null,
      ]);
      setReveal({ window, head: head ?? null });
    };
    void read();
    // The head moves, so the deadline is re-read while a commit is outstanding.
    const timer = setInterval(() => void read(), 30_000);
    return () => clearInterval(timer);
  }, [pendingCommits, config, client]);

  const ctx: LockerCtx = {
    session,
    config,
    client,
    journal,
    mutate,
    actions,
    events,
    refreshLedger,
  };

  return (
    <section>
      <div className="screen-head">
        <span className="eyebrow">Your locker</span>
        <h1>Locker</h1>
        <p className="identity">
          <span>
            principal <Hash value={principalId} copy />
          </span>
          <span>epoch {session.locker.currentEpoch().toString()}</span>
          <Pill tone={config.live ? "ok" : "bad"} dot>
            {config.live ? `chain ${config.chainId}` : "offline"}
          </Pill>
        </p>
      </div>
      {!config.live && (
        <Notice tone="warn">
          Offline: nothing here reaches a chain ({config.reason}). Point the app at a gateway from
          Settings.
        </Notice>
      )}

      <StatTiles
        journal={journal}
        grantStatuses={statuses}
        earnings={earnings}
        pendingBatch={session.batcher.pendingCount()}
        live={config.live}
      />

      <div className="locker-grid">
        <div className="locker-main">
          <RequestsCard
            ctx={ctx}
            liveness={liveness}
            requests={requests}
            onRequests={(list) => {
              onRequests(list);
              void refreshEarnings();
              void refreshStatuses();
            }}
          />
          <OnChainCard ctx={ctx} liveness={liveness} onActivated={onActivated} />
          <DepositsCard ctx={ctx} />
          <GrantsCard
            ctx={ctx}
            statuses={statuses}
            reveal={reveal}
            onWithdrawn={() => void refreshStatuses()}
          />
          <EarningsCard
            ctx={ctx}
            earnings={earnings}
            error={earningsError}
            onRefresh={() => void refreshEarnings()}
            refreshing={earningsBusy}
          />
          <LedgerCard
            ctx={ctx}
            scan={scan}
            error={ledgerError}
            onRefresh={() => void refreshLedger()}
            refreshing={ledgerBusy}
          />
          <ManifestCard ctx={ctx} />
        </div>
        <aside className="locker-aside">
          <ShareCard ctx={ctx} />
          <Delegate session={session} config={config} principalId={principalId} />
          <Portability config={config} principalId={principalId} grantIds={grantIds} />
          <ActivityCard config={config} />
        </aside>
      </div>
    </section>
  );
}
