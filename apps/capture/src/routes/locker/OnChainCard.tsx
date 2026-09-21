import { activate as activateLocker, reattest as reattestLocker } from "../../lib/activation.js";
import { describeLiveness, type Liveness } from "../../lib/liveness.js";
import { Button, Card, Hash, Notice, Pill, Tx } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/** Activation and the anchor batch — the two things a locker does on chain for itself. */
export function OnChainCard({
  ctx,
  liveness,
  onActivated,
}: {
  ctx: LockerCtx;
  liveness: Liveness;
  onActivated: () => void;
}) {
  const { session, config, client, journal, actions, refreshLedger } = ctx;
  const batches = session.batcher.flushed();
  const pending = session.batcher.pendingCount();
  const activated = journal.attestTx !== undefined;
  const reattestMode = liveness.kind === "attest-needed" || (liveness.kind === "live" && activated);

  const activate = () =>
    actions.run("activate", async () => {
      await activateLocker(session, client);
      onActivated();
      await refreshLedger();
    });
  const reattest = () =>
    actions.run("attest", async () => {
      await reattestLocker(session, client);
      onActivated();
      await refreshLedger();
    });
  const anchor = () =>
    actions.run("anchor", async () => {
      await session.flush();
    });

  const tone = liveness.kind === "live" ? "ok" : liveness.kind === "unknown" ? "neutral" : "warn";

  return (
    <Card
      id="locker-onchain"
      icon="zap"
      title="On chain"
      tone={tone}
      subtitle="A passport can only be anchored under an attested deposit key, so activation — enroll the principal, attest this epoch's keys — comes first."
      actions={
        liveness.kind !== "unknown" && (
          <Pill tone={tone} dot data-testid="liveness">
            {describeLiveness(liveness)}
          </Pill>
        )
      }
    >
      <div className="btn-row">
        {reattestMode ? (
          <Button
            icon="refresh"
            onClick={reattest}
            pending={actions.is("attest")}
            pendingLabel="Attesting…"
            disabled={!config.live || actions.busy !== null}
          >
            Re-attest this epoch
          </Button>
        ) : (
          <Button
            variant="primary"
            icon="key"
            onClick={activate}
            pending={actions.is("activate")}
            pendingLabel="Activating…"
            disabled={!config.live || actions.busy !== null}
          >
            Activate on chain (enroll + attest)
          </Button>
        )}
        <Button
          icon="layers"
          onClick={anchor}
          pending={actions.is("anchor")}
          pendingLabel="Anchoring…"
          disabled={pending === 0 || actions.busy !== null}
        >
          Anchor pending batch{pending > 0 ? ` (${pending})` : ""}
        </Button>
      </div>
      {journal.enrolTx && journal.attestTx && (
        <p className="row-meta">
          <Tx hash={journal.enrolTx} chainId={config.chainId} label="enrolled" />
          <Tx hash={journal.attestTx} chainId={config.chainId} label="attested" />
          {journal.enrolBlock && <span>from block {journal.enrolBlock}</span>}
        </p>
      )}
      {actions.errorFor((k) => k === "activate" || k === "attest" || k === "anchor") && (
        <Notice tone="bad">
          {actions.errorFor((k) => k === "activate" || k === "attest" || k === "anchor")}
        </Notice>
      )}
      {batches.length > 0 && (
        <ul className="plain asset-list">
          {batches.map((b) => (
            <li key={b.root}>
              <Pill tone="ok">batch</Pill>
              <span>
                ns {b.ns} · epoch {b.epoch.toString()} · {b.passports.length} passport
                {b.passports.length === 1 ? "" : "s"}
              </span>
              <span>
                root <Hash value={b.root} n={6} />
              </span>
              {b.anchor.txHash && <Tx hash={b.anchor.txHash} chainId={config.chainId} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
