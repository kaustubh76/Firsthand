import { formatUsdc } from "../../lib/agent.js";
import { pluralise } from "../../lib/format.js";
import { Button, Card, Notice, Skeleton, Tx } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

export interface Earnings {
  readonly count: number;
  readonly total: bigint;
  readonly rows: readonly { tx: string; grantId: string; block: bigint }[];
}

/** Every paid query leaves a receipt on chain; the RoyaltyRouter split the price at settlement. */
export function EarningsCard({
  ctx,
  earnings,
  error,
  onRefresh,
  refreshing,
}: {
  ctx: LockerCtx;
  earnings: Earnings | null;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { config } = ctx;
  return (
    <Card
      id="locker-earnings"
      icon="wallet"
      title="Earnings"
      subtitle="Every paid query leaves a receipt on chain; the RoyaltyRouter splits the price to your deposit key at settlement."
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
      {earnings === null ? (
        config.live ? (
          <Skeleton lines={2} />
        ) : (
          <p className="hint">unavailable offline</p>
        )
      ) : (
        <p className="earnings-line" data-testid="earnings">
          <span>{pluralise(earnings.count, "receipt")}</span>
          <span>·</span>
          <span className="big">{formatUsdc(earnings.total)}</span>
          {earnings.rows.slice(0, 5).map((r) => (
            <Tx
              key={r.tx}
              hash={r.tx}
              chainId={config.chainId}
              label={`block ${r.block}`}
              copy={false}
            />
          ))}
        </p>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </Card>
  );
}
