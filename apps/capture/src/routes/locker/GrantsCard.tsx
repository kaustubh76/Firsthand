import type { Bytes32 } from "@firsthand/core";
import { relativeTime } from "../../lib/format.js";
import { type GrantChainStatus, grantView } from "../../lib/grants.js";
import type { PendingRescission } from "../../lib/journal.js";
import {
  commitRescind,
  commitState,
  directRescind,
  forgetCommit,
  pendingFor,
  revealRescind,
} from "../../lib/rescind.js";
import { useNavigation } from "../../shell/navigation.js";
import { Button, Card, EmptyState, Hash, Notice, Pill, Tx } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * Consent, per buyer card and namespace, and both ways of ending it.
 *
 * Directly: one passkey-signed transaction, effective at its own block — and visible in the public
 * mempool before it lands, which is the race §13's observer bot is built to win. Privately: a blind
 * commitment now, a reveal later, with consent back-dated to the commit's block (ADR-0012). The
 * second is the arm the Evidence tab measures, so it has to be one a judge can actually run.
 *
 * Each row carries exactly one element that says "withdrawn" — the status pill — which the browser
 * tier waits for; a committed-but-unrevealed grant is still live on chain and says so.
 */
export function GrantsCard({
  ctx,
  statuses,
  expiries,
  reveal,
  onWithdrawn,
}: {
  ctx: LockerCtx;
  statuses: ReadonlyMap<Bytes32, GrantChainStatus> | null;
  /** Epoch each grant lapses at on its own (`epochStart + term`), derived from the chain. */
  expiries: ReadonlyMap<Bytes32, bigint>;
  /** The deployment's reveal window and the chain's head — what a pending commit's deadline is read from. */
  reveal: { readonly window: bigint | null; readonly head: bigint | null };
  onWithdrawn: () => void;
}) {
  const nav = useNavigation();
  const { session, config, client, journal, actions, events, refreshLedger } = ctx;
  const principalId = session.locker.principalId;

  const after = async () => {
    onWithdrawn();
    await refreshLedger();
  };

  const withdraw = (grantId: Bytes32) =>
    actions.run(`rescind:${grantId}`, async () => {
      await directRescind(session, client, grantId);
      await after();
    });

  const commit = (grantId: Bytes32) =>
    actions.run(`commit:${grantId}`, async () => {
      await commitRescind(session, client, grantId);
      await after();
    });

  const revealNow = (pending: PendingRescission) =>
    actions.run(`reveal:${pending.grantId}`, async () => {
      await revealRescind(session, client, pending);
      await after();
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
            const err =
              actions.errorFor(`rescind:${g.grantId}`) ??
              actions.errorFor(`commit:${g.grantId}`) ??
              actions.errorFor(`reveal:${g.grantId}`);
            const pending = pendingFor(journal.pendingRescissions, g.grantId);
            const state = pending ? commitState(pending, reveal.head, reveal.window) : null;
            const elapsed = state?.kind === "window-elapsed";
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
                  {/* Consent has an end even if nobody withdraws it; say when. */}
                  {view.status === "live" && expiries.get(g.grantId) !== undefined && (
                    <span data-testid={`expiry:${g.grantId}`}>
                      runs through epoch {(expiries.get(g.grantId) as bigint) - 1n}
                    </span>
                  )}
                  <Tx hash={g.txHash} chainId={config.chainId} label="granted" copy={false} />
                  {g.rescindTx && <Tx hash={g.rescindTx} chainId={config.chainId} copy={false} />}
                </div>
                {pending && (
                  <p className="row-meta" data-testid={`commit:${g.grantId}`}>
                    <Pill tone={elapsed ? "bad" : "warn"} dot>
                      {elapsed ? "commit expired" : "commit posted"}
                    </Pill>
                    <Tx
                      hash={pending.commitTx}
                      chainId={config.chainId}
                      label="committed"
                      copy={false}
                    />
                    {pending.commitBlock !== undefined && (
                      <span>consent ends at block {pending.commitBlock} once revealed</span>
                    )}
                    {state?.kind === "revealable" && reveal.window !== null && (
                      <span>
                        reveal within {state.blocksLeft.toString()} block(s) — by block{" "}
                        {(BigInt(pending.commitBlock as string) + reveal.window).toString()}
                      </span>
                    )}
                    {elapsed && (
                      <span>the reveal window closed; commit again or withdraw directly</span>
                    )}
                  </p>
                )}
                {view.status === "live" && (
                  <div className="row-actions">
                    {pending ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          icon="eye"
                          disabled={!config.live || actions.busy !== null || elapsed}
                          pending={actions.is(`reveal:${g.grantId}`)}
                          pendingLabel="Revealing…"
                          onClick={() => revealNow(pending)}
                        >
                          Reveal and end consent
                        </Button>
                        <Button
                          variant="inline"
                          size="sm"
                          disabled={actions.busy !== null}
                          onClick={() => forgetCommit(principalId, g.grantId)}
                        >
                          discard this commit
                        </Button>
                      </>
                    ) : (
                      <>
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
                        <Button
                          size="sm"
                          icon="lock"
                          disabled={!config.live || actions.busy !== null}
                          pending={actions.is(`commit:${g.grantId}`)}
                          pendingLabel="Committing…"
                          onClick={() => commit(g.grantId)}
                        >
                          Withdraw privately
                        </Button>
                      </>
                    )}
                  </div>
                )}
                {view.status === "live" && !pending && (
                  <p className="hint">
                    Privately: the mempool sees only <code>keccak256(grant, salt)</code> — no grant,
                    no principal, no signature — and the reveal back-dates the end of consent to the
                    commit's block. Two transactions instead of one.
                  </p>
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
