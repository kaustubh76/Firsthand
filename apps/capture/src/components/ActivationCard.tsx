import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import { type Activated, activate, reattest } from "../lib/activation.js";
import type { AppConfig } from "../lib/config.js";
import { describeLiveness, type Liveness } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import { Tx } from "./Tx.js";

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
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
  liveness: Liveness;
  onActivated: () => void;
  what: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Activated | null>(null);
  // Once done, the card stays to show its transactions until the judge moves on.
  if (done === null && (liveness.kind === "live" || liveness.kind === "unknown")) return null;
  if (!config.live) return null;
  const needsFreshAttest = liveness.kind === "attest-needed";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsFreshAttest) {
        const attestTx = await reattest(session, client);
        setDone({ enrolTx: attestTx, attestTx, enrolBlock: null });
      } else {
        setDone(await activate(session, client));
      }
      onActivated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card" data-testid="activation">
        <p>
          <strong>On chain.</strong>{" "}
          <Tx hash={done.enrolTx} chainId={config.chainId} label="enrolled" /> ·{" "}
          <Tx hash={done.attestTx} chainId={config.chainId} label="attested" /> —{" "}
          {what.toLowerCase()} will anchor from here on.
        </p>
      </div>
    );
  }
  return (
    <div className="card" data-testid="activation">
      <p>
        <strong>{what} cannot anchor yet</strong> — {describeLiveness(liveness)}.
      </p>
      <p className="hint">
        {needsFreshAttest
          ? "Epochs roll weekly; a passport is only anchored under a deposit-key root attested for its epoch. One relayed transaction."
          : "Enroll your principal and attest this epoch's deposit keys — two relayed transactions signed by your passkey. The browser pays no gas."}
      </p>
      <button type="button" onClick={run} disabled={busy || liveness.kind === "frozen"}>
        {busy
          ? needsFreshAttest
            ? "Attesting…"
            : "Activating…"
          : needsFreshAttest
            ? "Attest this epoch"
            : "Activate on chain (enroll + attest)"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
