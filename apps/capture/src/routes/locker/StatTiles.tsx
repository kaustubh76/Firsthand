import { formatUsdc } from "../../lib/agent.js";
import type { GrantChainStatus } from "../../lib/grants.js";
import type { Journal } from "../../lib/journal.js";
import { StatTile } from "../../ui/index.js";

/** The locker at a glance — every number from the journal, the chain or the gateway, never typed. */
export function StatTiles({
  journal,
  grantStatuses,
  earnings,
  pendingBatch,
  live,
}: {
  journal: Journal;
  grantStatuses: ReadonlyMap<string, GrantChainStatus> | null;
  earnings: { count: number; total: bigint } | null;
  pendingBatch: number;
  live: boolean;
}) {
  const published = journal.deposits.filter((d) => d.published).length;
  const liveGrants = journal.grants.filter(
    (g) => !g.rescindTx && (grantStatuses?.get(g.grantId) ?? "live") === "live",
  ).length;
  return (
    <div className="tile-grid">
      <StatTile
        label="Deposits"
        icon="stamp"
        value={journal.deposits.length}
        hint={`${published} published`}
      />
      <StatTile
        label="Live grants"
        icon="key"
        value={liveGrants}
        hint={`${journal.grants.length - liveGrants} withdrawn or ended`}
        tone={liveGrants > 0 ? "ok" : "neutral"}
        loading={live && journal.grants.length > 0 && grantStatuses === null}
      />
      <StatTile
        label="Receipts"
        icon="receipt"
        value={earnings?.count ?? 0}
        hint="paid queries on chain"
        loading={live && earnings === null}
      />
      <StatTile
        label="Earned"
        icon="wallet"
        value={formatUsdc(earnings?.total ?? 0n)}
        hint="split to your deposit key"
        tone={earnings && earnings.total > 0n ? "ok" : "neutral"}
        loading={live && earnings === null}
      />
      <StatTile
        label="Pending"
        icon="layers"
        value={pendingBatch}
        hint={pendingBatch > 0 ? "passports waiting to anchor" : "nothing waiting"}
        tone={pendingBatch > 0 ? "warn" : "neutral"}
      />
    </div>
  );
}
