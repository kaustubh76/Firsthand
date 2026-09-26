import { ConsentTimeline } from "../../components/ConsentTimeline.js";
import { describeScan, type TimelineScan } from "../../lib/ledger.js";
import { mergeLedger } from "../../lib/ledgerMerge.js";
import { Button, Card, Notice, Skeleton } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * What the chain says about this principal, as a timeline, merged with what this browser did
 * beyond the gateway's scan window. A rescission is drawn as a cut through the line: the end of
 * consent, dated by block. The rows themselves are `ConsentTimeline`, shared with the public
 * Verify tab so an auditor and an owner read the same ledger.
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
        <ConsentTimeline rows={rows} chainId={config.chainId} testId="ledger" />
      )}
      <p className="hint">
        The gateway reads a bounded window of blocks per request; rows marked <em>local record</em>{" "}
        are this browser's own transactions from beyond that window.
      </p>
    </Card>
  );
}
