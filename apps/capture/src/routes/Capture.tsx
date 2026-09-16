import {
  type Address,
  AttestationClass,
  LICENSE_FH_1_0,
  Scope,
  tag,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import type { DepositResult, LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import type { AppConfig } from "../lib/config.js";

export function Capture({ session, config }: { session: LockerSession; config: AppConfig }) {
  const [text, setText] = useState("");
  const [last, setLast] = useState<DepositResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string | null>(null);

  async function handleDeposit() {
    setError(null);
    try {
      const payee = session.locker.depositKey(0).address as Address;
      const terms = {
        price: 1n,
        licenseId: LICENSE_FH_1_0,
        scope: Scope.TRAIN | Scope.EVAL,
        ns: 0,
        rateLimit: 100,
        payees: [payee],
        weights: [WAD],
      } as const;
      const result = await session.deposit({
        ns: 0,
        datum: { kind: "bytes", bytes: new TextEncoder().encode(text) },
        terms,
        attestation: {
          class: AttestationClass.DEVICE_CAPTURE,
          capturedAt: BigInt(Math.floor(Date.now() / 1000)),
          sourceTag: tag("capture-pwa-v0"),
          deviceClass: tag(navigator.userAgent.includes("Mobile") ? "mobile" : "desktop"),
          metaHash: ZERO_HASH,
        },
      });
      setLast(result);
      setText("");
      setPublished(null);
      // A passport nobody can fetch is not a deposit: anchor the batch, then hand the gateway the
      // ciphertext and the sidecar so a buyer's query can be served.
      if (config.live && config.gatewayUrl) {
        setBusy(true);
        await session.flush();
        await session.publish({ gatewayUrl: config.gatewayUrl }, result, terms);
        setPublished(config.gatewayUrl);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Capture</h1>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What did you observe?"
        rows={4}
      />
      <button type="button" onClick={handleDeposit} disabled={text.trim() === "" || busy}>
        {busy ? "Anchoring + publishing…" : "Stamp passport"}
      </button>
      {!config.live && (
        <p className="error">
          Offline: passports are minted and sealed locally but never anchored, so no buyer can fetch
          them ({config.reason}). Open the app with <code>?gateway=https://…</code> to use another
          gateway.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {last && (
        <dl>
          <dt>passportId</dt>
          <dd>
            <code>{last.passportId}</code>
          </dd>
          <dt>origin</dt>
          <dd>
            <code>{last.signed.passport.origin}</code>
          </dd>
          <dt>blob</dt>
          <dd>
            <code>{last.blob.id}</code>
          </dd>
          {published && (
            <>
              <dt>published</dt>
              <dd>
                a buyer can now query it at <code>{published}</code>
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
