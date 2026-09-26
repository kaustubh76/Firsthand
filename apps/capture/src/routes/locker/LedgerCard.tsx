import { blockTime } from "../../lib/format.js";
import { describeScan, type TimelineScan } from "../../lib/ledger.js";
import { mergeLedger } from "../../lib/ledgerMerge.js";
import {
  Button,
  Card,
  Hash,
  Notice,
  Skeleton,
  Timeline,
  type TimelineItem,
  Tx,
} from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * What the chain says about this principal, as a timeline, merged with what this browser did
 * beyond the gateway's scan window. A rescission is drawn as a cut through the line: the end of
 * consent, dated by block. The kind is its own element with nothing else in it.
 */
export function LedgerCard({
  ctx,
  scan,
  error,
  onRefresh,
  refreshing,
}: {
  ctx: LockerCtx;
  scan: TimelineScan | null;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { session, config, journal, events } = ctx;
  const rows = mergeLedger(session.locker.principalId, events ?? [], journal);
  const items: TimelineItem[] = rows.map((e) => ({
    id: `${e.kind}-${e.txHash ?? e.grantId ?? ""}`,
    status: e.kind === "rescinded" ? "cut" : e.source === "local" ? "local" : "chain",
    title: (
      <>
        <span className="kind">{e.kind}</span>
        <span className="hint">{e.source === "local" ? "this browser" : "on chain"}</span>
      </>
    ),
    meta: (
      <>
        {e.blockNumber === null ? (
          <span>local record</span>
        ) : (
          <span>
            {e.kind === "rescinded" ? "consent ended at block " : "block "}
            {e.blockNumber.toString()}
          </span>
        )}
        {/* The commit dated the end of consent; the reveal only recorded it, later. */}
        {e.viaCommitReveal && (
          <span>
            commit-reveal
            {e.recordedBlock === null ? "" : ` — revealed at block ${e.recordedBlock.toString()}`}
          </span>
        )}
        {e.timestamp !== null && blockTime(e.timestamp) && <span>{blockTime(e.timestamp)}</span>}
        {e.grantId && (
          <span>
            grant <Hash value={e.grantId} n={6} />
          </span>
        )}
        {e.granteeCard && (
          <span>
            card <Hash value={e.granteeCard} n={6} />
          </span>
        )}
        {e.ns !== null && <span>ns {e.ns}</span>}
        {e.txHash && <Tx hash={e.txHash} chainId={config.chainId} copy={false} />}
      </>
    ),
  }));
  const scanNote = describeScan(scan);
  return (
    <Card
      id="locker-ledger"
      icon="clock"
      title="Consent Ledger"
      subtitle={`What the chain says about this principal, read from event logs by the gateway${
        journal.enrolBlock ? ` since block ${journal.enrolBlock}` : ""
      }.`}
      actions={
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          onClick={onRefresh}
          pending={refreshing}
          pendingLabel="Reading…"
          disabled={!config.live}
        >
          Refresh
        </Button>
      }
    >
      {error && <Notice tone="bad">{error}</Notice>}
      {scanNote && (
        <p className="hint" data-testid="ledger-scan">
          {scanNote}
        </p>
      )}
      {events === null && rows.length === 0 ? (
        config.live ? (
          <Skeleton lines={3} />
        ) : (
          <p className="hint">unavailable offline</p>
        )
      ) : rows.length === 0 ? (
        <p className="hint">no events yet</p>
      ) : (
        <Timeline items={items} data-testid="ledger" />
      )}
      <p className="hint">
        The gateway reads a bounded window of blocks per request; rows marked <em>local record</em>{" "}
        are this browser's own transactions from beyond that window.
      </p>
    </Card>
  );
}
