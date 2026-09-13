import type { LockerSession } from "@firsthand/sdk/browser";
import { useMemo, useState } from "react";
import { createClient, openSession } from "./lib/locker.js";
import { prfSourceFor, savedCredentialId } from "./lib/prf.js";
import { Capture } from "./routes/Capture.js";
import { Enroll } from "./routes/Enroll.js";
import { LockerView } from "./routes/Locker.js";
import { Rescind } from "./routes/Rescind.js";

type Route = "capture" | "locker" | "rescind";

export function App() {
  const client = useMemo(createClient, []);
  const [credentialId, setCredentialId] = useState<Uint8Array | null>(savedCredentialId);
  const [session, setSession] = useState<LockerSession | null>(null);
  const [route, setRoute] = useState<Route>("capture");
  const [error, setError] = useState<string | null>(null);

  async function unlock(id: Uint8Array) {
    try {
      setSession(await openSession(client, prfSourceFor(id)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (credentialId === null) {
    return (
      <Enroll
        onEnrolled={(id) => {
          setCredentialId(id);
          void unlock(id);
        }}
      />
    );
  }
  if (session === null) {
    return (
      <section>
        <h1>Unlock</h1>
        <button type="button" onClick={() => unlock(credentialId)}>
          Tap passkey
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }
  return (
    <main>
      <nav>
        {(["capture", "locker", "rescind"] as const).map((r) => (
          <button type="button" key={r} onClick={() => setRoute(r)} aria-current={route === r}>
            {r}
          </button>
        ))}
      </nav>
      {route === "capture" && <Capture session={session} />}
      {route === "locker" && <LockerView session={session} />}
      {route === "rescind" && <Rescind session={session} />}
    </main>
  );
}
