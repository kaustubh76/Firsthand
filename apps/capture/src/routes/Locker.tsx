import type { Bytes32 } from "@firsthand/core";
import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import type { AppConfig } from "../lib/config.js";

/**
 * The locker's write surface. Anchoring is only possible once the principal is enrolled and has
 * attested this epoch's deposit keys — `PassportAnchors.anchor` checks the signature against the
 * attested root — so "Activate on chain" is a prerequisite, not a nicety. Every write here goes
 * through the gateway's relay: the browser holds no key and pays no gas.
 */
export function LockerView({
  session,
  config,
  waitForTx,
}: {
  session: LockerSession;
  config: AppConfig;
  waitForTx: ((hash: Bytes32) => Promise<void>) | null;
}) {
  const [, rerender] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState<{ enroll: string; attest: string } | null>(null);
  const batches = session.batcher.flushed();

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      rerender((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h1>Locker</h1>
      <p>
        principal <code>{session.locker.principalId}</code> · epoch{" "}
        {session.locker.currentEpoch().toString()} · pending {session.batcher.pendingCount()}
      </p>
      {!config.live && (
        <p className="error">
          Offline: no gateway relay configured, so nothing here reaches a chain. Set
          <code> VITE_GATEWAY_URL</code> and run the gateway with <code>RELAY_ENABLED=true</code>.
        </p>
      )}

      <button
        type="button"
        disabled={!config.live || busy !== null}
        onClick={() =>
          run("activate", async () => {
            const enrolled = await session.enroll();
            // attest reads the principal enrol wrote, so it must wait for inclusion — relaying
            // returns as soon as the gateway accepts the transaction, not when it lands.
            await waitForTx?.(enrolled.txHash);
            const attested = await session.attest();
            await waitForTx?.(attested.txHash);
            setActivated({ enroll: enrolled.txHash, attest: attested.txHash });
          })
        }
      >
        {busy === "activate" ? "Activating…" : "Activate on chain (enroll + attest)"}
      </button>
      {activated && (
        <p>
          enrolled <code>{activated.enroll}</code> · attested <code>{activated.attest}</code>
        </p>
      )}

      <button
        type="button"
        onClick={() => run("anchor", () => session.flush().then(() => undefined))}
        disabled={session.batcher.pendingCount() === 0 || busy !== null}
      >
        {busy === "anchor" ? "Anchoring…" : "Anchor pending batch"}
      </button>
      {error && <p className="error">{error}</p>}

      <ul>
        {batches.map((b) => (
          <li key={b.root}>
            ns {b.ns} · epoch {b.epoch.toString()} · {b.passports.length} passports · root{" "}
            <code>{b.root}</code>
            {b.anchor.txHash && (
              <>
                {" "}
                · tx <code>{b.anchor.txHash}</code>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
