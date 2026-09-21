import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import { useAsyncActions } from "../hooks/useAsyncActions.js";
import { type Activated, activate, reattest } from "../lib/activation.js";
import type { AppConfig } from "../lib/config.js";
import { describeLiveness, type Liveness } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import { Button, Card, Notice, Tx } from "../ui/index.js";

/**
 * The one step a fresh locker needs before anything anchors, offered wherever the judge is
 * standing instead of a pointer to another tab.
 */
export function ActivationCard({
  session,
  config,
  client,
  liveness,
  onActivated,
  what,
  id,
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
  liveness: Liveness;
  onActivated: () => void;
  what: string;
  /** A jump target for the journey rail. */
  id?: string | undefined;
}) {
  const actions = useAsyncActions<"activate">();
  const [done, setDone] = useState<Activated | null>(null);
  // Once done, the card stays to show its transactions until the judge moves on.
  if (done === null && (liveness.kind === "live" || liveness.kind === "unknown")) return null;
  if (!config.live) return null;
  const needsFreshAttest = liveness.kind === "attest-needed";

  const run = () =>
    actions.run("activate", async () => {
      if (needsFreshAttest) {
        const attestTx = await reattest(session, client);
        setDone({ enrolTx: attestTx, attestTx, enrolBlock: null });
      } else {
        setDone(await activate(session, client));
      }
      onActivated();
    });

  if (done) {
    return (
      <Card tone="ok" icon="check" title="On chain" data-testid="activation" id={id} compact>
        <p className="row-meta">
          <Tx hash={done.enrolTx} chainId={config.chainId} label="enrolled" />
          <Tx hash={done.attestTx} chainId={config.chainId} label="attested" />
          <span>{what.toLowerCase()} will anchor from here on.</span>
        </p>
      </Card>
    );
  }
  return (
    <Card
      tone="accent"
      icon="zap"
      title={`${what} cannot anchor yet`}
      subtitle={describeLiveness(liveness)}
      data-testid="activation"
      id={id}
    >
      <p className="hint">
        {needsFreshAttest
          ? "Epochs roll weekly; a passport is only anchored under a deposit-key root attested for its epoch. One relayed transaction."
          : "Enroll your principal and attest this epoch's deposit keys — two relayed transactions signed by your passkey. The browser pays no gas."}
      </p>
      <div className="btn-row">
        <Button
          variant="primary"
          icon="key"
          onClick={run}
          pending={actions.is("activate")}
          pendingLabel={needsFreshAttest ? "Attesting…" : "Activating…"}
          disabled={liveness.kind === "frozen"}
        >
          {needsFreshAttest ? "Attest this epoch" : "Activate on chain (enroll + attest)"}
        </Button>
      </div>
      {actions.error && <Notice tone="bad">{actions.error}</Notice>}
    </Card>
  );
}
