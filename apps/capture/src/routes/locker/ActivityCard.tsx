import { useTx } from "../../hooks/useTx.js";
import type { AppConfig } from "../../lib/config.js";
import { relativeTime } from "../../lib/format.js";
import { Card, EmptyState, Pill, Timeline, type TimelineItem, Tx } from "../../ui/index.js";

/** Every relayed transaction from this tab, pending → mined, with its explorer link. */
export function ActivityCard({ config }: { config: AppConfig }) {
  const tx = useTx();
  const items: TimelineItem[] = tx.txs.map((t) => ({
    id: t.hash,
    status: t.status === "mined" ? "chain" : t.status === "failed" ? "failed" : "pending",
    title: t.label,
    meta: (
      <>
        <span>{relativeTime(t.sentAt)}</span>
        <Tx hash={t.hash} chainId={config.chainId} copy={false} />
      </>
    ),
    body: t.error ? <span className="error">{t.error}</span> : undefined,
  }));
  return (
    <Card
      id="locker-activity"
      icon="zap"
      title="Activity"
      subtitle="Relayed by the venue on your behalf; the browser pays no gas."
      actions={
        tx.pendingCount > 0 && (
          <Pill tone="pending" dot>
            {tx.pendingCount} pending
          </Pill>
        )
      }
    >
      {items.length === 0 ? (
        <EmptyState icon="zap" title="No transactions from this tab yet" />
      ) : (
        <Timeline items={items.slice(0, 12)} />
      )}
    </Card>
  );
}
