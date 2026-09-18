import type { LockerSession } from "@firsthand/sdk/browser";
import { useEffect, useState } from "react";
import { type AppConfig, loadConfig } from "./lib/config.js";
import { describeLiveness, fetchLiveness, type Liveness } from "./lib/liveness.js";
import { type CaptureClient, createClient, openSession } from "./lib/locker.js";
import { prfSourceFor, savedCredentialId } from "./lib/prf.js";
import { absorbRequestFromUrl, type GrantRequest } from "./lib/requests.js";
import { Capture } from "./routes/Capture.js";
import { Enroll } from "./routes/Enroll.js";
import { LockerView } from "./routes/Locker.js";
import { Recall } from "./routes/Recall.js";
import { Verify } from "./routes/Verify.js";

type Route = "capture" | "locker" | "recall" | "verify";

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
  // A buyer's access request arrives as a link; it opens the Locker once the passkey has unlocked.
  const [requests, setRequests] = useState<GrantRequest[]>(() => absorbRequestFromUrl());
  const [route, setRoute] = useState<Route>(() => (requests.length > 0 ? "locker" : "capture"));
  const [error, setError] = useState<string | null>(null);
  const [liveness, setLiveness] = useState<Liveness>({ kind: "unknown" });

  const refreshLiveness = async (s: LockerSession | null = session) => {
    if (!s || !config || !client) return;
    setLiveness(
      await fetchLiveness(
        config,
        client.publicClient,
        s.locker.principalId,
        s.locker.currentEpoch(),
      ),
    );
  };

  async function unlock(id: Uint8Array) {
    if (!client) return;
    try {
      const s = await openSession(client.client, prfSourceFor(id));
      setSession(s);
      void refreshLiveness(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The status strip is on every screen, so nobody mistakes the offline demo for the chain.
  const status = (
    <p className="status" data-live={config?.live ?? "loading"} data-liveness={liveness.kind}>
      {config === null
        ? "connecting to gateway…"
        : config.live
          ? `live · chain ${config.chainId} · ${hostOf(config.gatewayUrl)}${
              liveness.kind === "unknown" ? "" : ` · ${describeLiveness(liveness)}`
            }`
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
  // Verification needs no locker: a buyer, a judge, anyone with a manifest or a passport id.
  const verifyLink = (
    <p className="hint">
      No locker needed to{" "}
      <button type="button" className="inline" onClick={() => setRoute("verify")}>
        verify a manifest or a passport
      </button>
      .
    </p>
  );
  const publicVerify = config && client && route === "verify" && session === null && (
    <main>
      {header}
      <button type="button" className="inline" onClick={() => setRoute("capture")}>
        ← back
      </button>
      <Verify config={config} client={client} />
    </main>
  );
  if (publicVerify) return publicVerify;
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
        {verifyLink}
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
        {verifyLink}
      </main>
    );
  }
  return (
    <main>
      {header}
      <nav>
        {(["capture", "locker", "recall", "verify"] as const).map((r) => (
          <button type="button" key={r} onClick={() => setRoute(r)} aria-current={route === r}>
            {r}
            {r === "locker" && requests.length > 0 ? ` (${requests.length})` : ""}
          </button>
        ))}
      </nav>
      {route === "capture" && <Capture session={session} config={config} liveness={liveness} />}
      {route === "locker" && (
        <LockerView
          session={session}
          config={config}
          client={client}
          liveness={liveness}
          onActivated={() => void refreshLiveness()}
          requests={requests}
          onRequests={setRequests}
        />
      )}
      {route === "recall" && (
        <Recall session={session} config={config} client={client} liveness={liveness} />
      )}
      {route === "verify" && <Verify config={config} client={client} />}
    </main>
  );
}
