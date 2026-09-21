import type { Bytes32 } from "@firsthand/core";
import { relativeTime } from "../../lib/format.js";
import { type GrantChainStatus, grantView } from "../../lib/grants.js";
import { useNavigation } from "../../shell/navigation.js";
import { Button, Card, EmptyState, Hash, Notice, Pill, Tx } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * Consent, per buyer card and namespace. Withdrawing it is one passkey-signed transaction; the
 * gateway refuses the next query at that block and the ledger dates it. Each row carries exactly
 * one element that says "withdrawn" — the status pill — which the browser tier waits for.
 */
export function GrantsCard({
  ctx,
  statuses,
  onWithdrawn,
}: {
  ctx: LockerCtx;
  statuses: ReadonlyMap<Bytes32, GrantChainStatus> | null;
  onWithdrawn: () => void;
}) {
  const nav = useNavigation();
  const { session, config, client, journal, mutate, actions, events, refreshLedger } = ctx;

  const withdraw = (grantId: Bytes32) =>
    actions.run(`rescind:${grantId}`, async () => {
      // Direct rescission: one passkey-signed transaction, effective at its own block.
      const sent = await session.sendRescind(session.planRescind(grantId));
      await client.waitForTx?.(sent.txHash, "Consent withdrawn");
      mutate((j) => {
        const g = j.grants.find((x) => x.grantId === grantId);
        if (g) g.rescindTx = sent.txHash;
      });
      onWithdrawn();
      await refreshLedger();
    });

  const live = journal.grants.filter(
    (g) => grantView(g, events ?? [], statuses?.get(g.grantId) ?? null).status === "live",
  ).length;

  return (
    <Card
      id="locker-grants"
      icon="key"
      title="Grants"
      subtitle="Consent, per buyer card and namespace. Withdrawing it is one passkey-signed transaction; the gateway refuses the next query at that block."
      actions={
        journal.grants.length > 0 && (
          <Pill tone={live > 0 ? "ok" : "neutral"} dot>
            {live} live
          </Pill>
        )
      }
    >
      {journal.grants.length === 0 ? (
        <EmptyState
          icon="key"
          title="No grants yet"
          hint="Run a buyer on the Recall tab, or share your link and approve a request here."
          action={
            <Button size="sm" icon="replay" onClick={() => nav.go("recall", "recall-run")}>
              Run the first buyer
            </Button>
          }
        />
      ) : (
        <ul className="cards" data-testid="grants">
          {journal.grants.map((g) => {
            const view = grantView(g, events ?? [], statuses?.get(g.grantId) ?? null);
            const err = actions.errorFor(`rescind:${g.grantId}`);
            return (
              <li key={g.grantId} className="grant-row" data-state={view.status}>
                <div className="row-head">
                  <span className="row-meta">
                    <span>
                      grant <Hash value={g.grantId} copy />
                    </span>
                    <span>
                      → card <Hash value={g.granteeCard} n={6} />
                    </span>
                    {g.agentId && (
                      <span>
                        ERC-8004 #{g.agentId}
                        {g.agentName ? ` “${g.agentName}”` : ""}
                      </span>
                    )}
                  </span>
                  <Pill tone={view.tone} dot>
                    {view.status}
                  </Pill>
                </div>
                <div className="row-meta">
                  <span>ns {g.ns}</span>
                  <span>{relativeTime(g.at)}</span>
                  <Tx hash={g.txHash} chainId={config.chainId} label="granted" copy={false} />
                  {g.rescindTx && <Tx hash={g.rescindTx} chainId={config.chainId} copy={false} />}
                </div>
                {view.status === "live" && (
                  <div className="row-actions">
                    <Button
                      variant="danger"
                      size="sm"
                      icon="scissors"
                      disabled={!config.live || actions.busy !== null}
                      pending={actions.is(`rescind:${g.grantId}`)}
                      pendingLabel="Withdrawing…"
                      onClick={() => withdraw(g.grantId)}
                    >
                      Withdraw consent
                    </Button>
                  </div>
                )}
                {err && <Notice tone="bad">{err}</Notice>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
