import { blockTime } from "../lib/format.js";
import type { LedgerRow } from "../lib/ledgerMerge.js";
import { Hash, Timeline, type TimelineItem, Tx } from "../ui/index.js";

/**
 * The Consent Ledger's rows, drawn the same way wherever they are read: inside the owner's Locker,
 * and on the public Verify tab where an auditor with no passkey arrives by link. A rescission is a
 * cut through the line, dated by the block consent *ended* — which on the commit-reveal path is the
 * commit's, earlier than the transaction that recorded it.
 */
export function ConsentTimeline({
  rows,
  chainId,
  testId,
}: {
  rows: readonly LedgerRow[];
  chainId: bigint;
  testId: string;
}) {
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
        {e.txHash && <Tx hash={e.txHash} chainId={chainId} copy={false} />}
      </>
    ),
  }));
  return <Timeline items={items} data-testid={testId} />;
}
