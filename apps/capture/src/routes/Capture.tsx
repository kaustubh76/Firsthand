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

export function Capture({ session }: { session: LockerSession }) {
  const [text, setText] = useState("");
  const [last, setLast] = useState<DepositResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDeposit() {
    setError(null);
    try {
      const payee = session.locker.depositKey(0).address as Address;
      const result = await session.deposit({
        ns: 0,
        datum: { kind: "bytes", bytes: new TextEncoder().encode(text) },
        terms: {
          price: 1n,
          licenseId: LICENSE_FH_1_0,
          scope: Scope.TRAIN | Scope.EVAL,
          ns: 0,
          rateLimit: 100,
          payees: [payee],
          weights: [WAD],
        },
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
    } catch (e) {
      setError((e as Error).message);
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
      <button type="button" onClick={handleDeposit} disabled={text.trim() === ""}>
        Stamp passport
      </button>
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
        </dl>
      )}
    </section>
  );
}
