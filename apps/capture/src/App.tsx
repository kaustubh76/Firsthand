import type { LockerSession } from "@firsthand/sdk/browser";
import { useEffect, useState } from "react";
import { type AppConfig, loadConfig } from "./lib/config.js";
import { type CaptureClient, createClient, openSession } from "./lib/locker.js";
import { prfSourceFor, savedCredentialId } from "./lib/prf.js";
import { Capture } from "./routes/Capture.js";
import { Enroll } from "./routes/Enroll.js";
import { LockerView } from "./routes/Locker.js";
import { Recall } from "./routes/Recall.js";

type Route = "capture" | "locker" | "recall";

const hostOf = (url: string | null): string => {
  try {
    return url ? new URL(url).host : "no gateway";
  } catch {
    return url ?? "no gateway";
  }
};

export function App() {
  // Addresses come from the gateway's discovery document, so this is async — the browser has no
  // deployment file to read.
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [client, setClient] = useState<CaptureClient | null>(null);
  useEffect(() => {
    void loadConfig().then((c) => {
      setConfig(c);
      setClient(createClient(c));
    });
  }, []);
  const [credentialId, setCredentialId] = useState<Uint8Array | null>(savedCredentialId);
  const [session, setSession] = useState<LockerSession | null>(null);
  const [route, setRoute] = useState<Route>("capture");
  const [error, setError] = useState<string | null>(null);

  async function unlock(id: Uint8Array) {
    if (!client) return;
    try {
      setSession(await openSession(client.client, prfSourceFor(id)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The status strip is on every screen, so nobody mistakes the offline demo for the chain.
  const status = (
    <p className="status" data-live={config?.live ?? "loading"}>
      {config === null
        ? "connecting to gateway…"
        : config.live
          ? `live · chain ${config.chainId} · ${hostOf(config.gatewayUrl)}`
          : `offline · ${config.reason}`}
    </p>
  );
  const header = (
    <header className="masthead">
      <div>
        <span className="brand">FIRSTHAND</span>
        <span className="tagline">
          the data locker that can prove what's inside it — deposit · query · rescind
        </span>
      </div>
      {status}
    </header>
  );
  if (!config || !client) {
    return (
      <main>
        {header}
        <section>
          <p>Loading…</p>
        </section>
      </main>
    );
  }
  if (credentialId === null) {
    return (
      <main>
        {header}
        <Enroll
          onEnrolled={(id) => {
            setCredentialId(id);
            void unlock(id);
          }}
        />
      </main>
    );
  }
  if (session === null) {
    return (
      <main>
        {header}
        <section>
          <h1>Unlock</h1>
          <p className="lede">
            Your locker's keys derive from the passkey's PRF output on every unlock; nothing is
            stored but the credential id.
          </p>
          <button type="button" onClick={() => unlock(credentialId)}>
            Tap passkey
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }
  return (
    <main>
      {header}
      <nav>
        {(["capture", "locker", "recall"] as const).map((r) => (
          <button type="button" key={r} onClick={() => setRoute(r)} aria-current={route === r}>
            {r}
          </button>
        ))}
      </nav>
      {route === "capture" && <Capture session={session} config={config} />}
      {route === "locker" && <LockerView session={session} config={config} client={client} />}
      {route === "recall" && <Recall session={session} config={config} client={client} />}
    </main>
  );
}
