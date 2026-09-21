import { useState } from "react";
import { enrol, prfSupported } from "../lib/prf.js";
import { Button, Icon, Notice } from "../ui/index.js";

export function Enroll({ onEnrolled }: { onEnrolled: (credentialId: Uint8Array) => void }) {
  const supported = prfSupported();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleEnrol() {
    setBusy(true);
    setProblem(null);
    try {
      const { credentialId, prfEnabled } = await enrol("firsthand-user");
      if (!prfEnabled) {
        setProblem(
          "Passkey created, but this authenticator does not expose the PRF extension, so no locker key can be derived from it. Try a platform passkey (Touch ID, Windows Hello, Android) or a recent security key.",
        );
        return;
      }
      onEnrolled(credentialId);
    } catch (error) {
      setProblem(`Enrolment failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hero">
      <div className="screen-head">
        <span className="eyebrow">Enrol</span>
        <h1>One passkey is the root of everything.</h1>
        <p className="lede">
          Deposit keys, vault keys, the principal on chain — all derived from the passkey's PRF
          output on every unlock. No biometrics leave the device, no issuer, no seed phrase.
        </p>
        <div className="hero-actions">
          <Button
            variant="primary"
            icon="fingerprint"
            onClick={handleEnrol}
            pending={busy}
            pendingLabel="Waiting for passkey…"
            disabled={!supported}
          >
            Create passkey
          </Button>
          <span className="hint">
            {supported
              ? "One tap enrols your passkey."
              : "WebAuthn is not available in this browser."}
          </span>
        </div>
        {problem && <Notice tone="bad">{problem}</Notice>}
      </div>
      <ul className="hero-facts">
        <li>
          <Icon name="check" />
          <span>Nothing is stored but the credential id — keys are re-derived at each unlock.</span>
        </li>
        <li>
          <Icon name="check" />
          <span>Every datum you deposit is minted with a passkey-signed Data Passport.</span>
        </li>
        <li>
          <Icon name="check" />
          <span>
            Consent is a grant you can withdraw in one tap; the chain dates the end of it.
          </span>
        </li>
        <li>
          <Icon name="check" />
          <span>The browser holds no gas: every write rides the venue's relay.</span>
        </li>
      </ul>
    </section>
  );
}
