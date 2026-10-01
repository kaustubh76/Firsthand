import { useEffect, useState } from "react";
import { JUDGES_URL } from "../lib/links.js";
import { enrol, type PrfCapability, prfCapability, prfSupported } from "../lib/prf.js";
import { Button, Icon, Notice } from "../ui/index.js";

/**
 * The protocol is three verbs (README §4), and the tabs are named after what you do rather than
 * after them. Someone opening this cold was told how the passkey works and never what the thing
 * is for, so the causal chain — deposit, query, rescind, and the refusal that proves the last one
 * — had to be inferred from tab names.
 */
const VERBS: readonly { verb: string; where: string; what: string }[] = [
  {
    verb: "deposit",
    where: "Capture",
    what: "a note, a photo or a whole ChatGPT export becomes a Data Passport your passkey signed, anchored in a batch on Monad",
  },
  {
    verb: "query",
    where: "Recall",
    what: "a buyer accepts your terms and pays per query over x402; the gateway checks the chain before it serves, and the receipt lands on chain",
  },
  {
    verb: "rescind",
    where: "Locker",
    what: "you withdraw consent in one tap — publicly, or privately by commitment — and the same paid query is refused from that block on",
  },
];

export function Enroll({
  onEnrolled,
  problem: reported = null,
}: {
  onEnrolled: (credentialId: Uint8Array) => void;
  /** A failure from the derivation that follows enrolment — the real PRF gate lives there. */
  problem?: string | null;
}) {
  const supported = prfSupported();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Asked before the tap, so a browser that cannot derive keys says so before a passkey exists.
  const [capability, setCapability] = useState<PrfCapability>("unknown");
  useEffect(() => {
    let live = true;
    void prfCapability().then((c) => {
      if (live) setCapability(c);
    });
    return () => {
      live = false;
    };
  }, []);
  const shown = problem ?? reported;

  async function handleEnrol() {
    setBusy(true);
    setProblem(null);
    try {
      // `prfEnabled` is only the authenticator's advertisement, and several platforms that do
      // support PRF never set it on create. The gate is the first real derivation, one tap later
      // in `unlock()` — this screen no longer refuses a working authenticator on a missing flag.
      const { credentialId } = await enrol("firsthand-user");
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
        {capability === "no" && !shown && (
          <Notice tone="warn">
            This browser reports no support for the WebAuthn PRF extension, which is what a locker's
            keys derive from. Enrolling here will not produce a locker you can open — try a current
            Chrome, Edge, Safari or Firefox on this device.
          </Notice>
        )}
        {shown && <Notice tone="bad">{shown}</Notice>}
      </div>
      <ol className="hero-verbs" data-testid="verbs">
        {VERBS.map((v, i) => (
          <li key={v.verb}>
            <span className="beat-num" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <strong>{v.verb}</strong> <span className="hint">· {v.where} tab</span>
              <br />
              <span className="hint">{v.what}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="hint">
        That last line is the point: consent you can end, dated by a chain, with the refusal
        provable afterwards.{" "}
        <a href={JUDGES_URL} target="_blank" rel="noreferrer">
          the three-minute walkthrough
        </a>
      </p>
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
