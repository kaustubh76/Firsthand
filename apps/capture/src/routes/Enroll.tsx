import { useState } from "react";
import { enrol, prfSupported } from "../lib/prf.js";

export function Enroll({ onEnrolled }: { onEnrolled: (credentialId: Uint8Array) => void }) {
  const [status, setStatus] = useState<string>(
    prfSupported()
      ? "Ready — one tap enrols your passkey."
      : "WebAuthn is not available in this browser.",
  );
  const [busy, setBusy] = useState(false);

  async function handleEnrol() {
    setBusy(true);
    try {
      const { credentialId, prfEnabled } = await enrol("firsthand-user");
      if (!prfEnabled) {
        setStatus(
          "Passkey created, but this authenticator does not expose PRF. Keys cannot be derived (Phase 0 gate).",
        );
        return;
      }
      onEnrolled(credentialId);
    } catch (error) {
      setStatus(`Enrolment failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Enrol</h1>
      <p>{status}</p>
      <button type="button" onClick={handleEnrol} disabled={busy || !prfSupported()}>
        {busy ? "Waiting for passkey…" : "Create passkey"}
      </button>
      <p className="hint">
        No biometrics leave the device. All keys derive from the passkey PRF (README §7.3).
      </p>
    </section>
  );
}
