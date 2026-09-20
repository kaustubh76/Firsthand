import type { LockerSession } from "@firsthand/sdk/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AppConfig, loadConfig } from "./lib/config.js";
import { EPOCH_REASONS, type Failure, onFailure } from "./lib/failures.js";
import {
  describeFloat,
  describeRollover,
  fetchHealth,
  type GatewayHealth,
  rolloverIn,
} from "./lib/health.js";
import { describeLiveness, fetchLiveness, type Liveness } from "./lib/liveness.js";
import { type CaptureClient, createClient, openSession } from "./lib/locker.js";
import { prfSourceFor, savedCredentialId } from "./lib/prf.js";
import { absorbRequestFromUrl, type GrantRequest, parsePrincipalLink } from "./lib/requests.js";
import { Capture } from "./routes/Capture.js";
import { Enroll } from "./routes/Enroll.js";
import { Evidence } from "./routes/Evidence.js";
import { LockerView } from "./routes/Locker.js";
import { Recall } from "./routes/Recall.js";
import { Verify } from "./routes/Verify.js";

type Route = "capture" | "locker" | "recall" | "verify" | "evidence";

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
  const [connecting, setConnecting] = useState<{ attempt: number; of: number } | null>(null);
  const discovering = useRef(false);
  // A hosted gateway can take a cold start: discovery retries, says which attempt it is on, and
  // can be re-run from the strip or by coming back to the tab — offline is never final.
  const discover = useCallback(async () => {
    if (discovering.current) return;
    discovering.current = true;
    try {
      const c = await loadConfig({ onAttempt: (attempt, of) => setConnecting({ attempt, of }) });
      setConfig(c);
      setClient(createClient(c));
    } finally {
      discovering.current = false;
      setConnecting(null);
    }
  }, []);
  useEffect(() => {
    void discover();
  }, [discover]);

  // The venue's float and the epoch clock, on every screen: a judge sees "relayer low" or "epoch
  // rolls over in 40 min" before a tap fails, not after.
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const refreshHealth = useCallback(async () => {
    if (config?.live) setHealth(await fetchHealth(config));
  }, [config]);
  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => {
      void refreshHealth();
      setNow(BigInt(Math.floor(Date.now() / 1000)));
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshHealth]);
  const [outOfGas, setOutOfGas] = useState<Failure | null>(null);
  const [credentialId, setCredentialId] = useState<Uint8Array | null>(savedCredentialId);
  const [session, setSession] = useState<LockerSession | null>(null);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && config && !config.live && session === null)
        void discover();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [config, discover, session]);
  // A buyer's access request arrives as a link; it opens the Locker once the passkey has unlocked.
  const [requests, setRequests] = useState<GrantRequest[]>(() => absorbRequestFromUrl());
  // A shared locker link (`?principal=`) opens Verify listing that principal — no locker needed.
  const [sharedPrincipal] = useState(() =>
    typeof location === "undefined" ? null : parsePrincipalLink(location.search),
  );
  const [route, setRoute] = useState<Route>(() =>
    sharedPrincipal ? "verify" : requests.length > 0 ? "locker" : "capture",
  );
  const [error, setError] = useState<string | null>(null);
  const [liveness, setLiveness] = useState<Liveness>({ kind: "unknown" });

  const refreshLiveness = useCallback(
    async (s: LockerSession | null = session) => {
      if (!s || !config || !client) return;
      setLiveness(
        await fetchLiveness(
          config,
          client.publicClient,
          s.locker.principalId,
          s.locker.currentEpoch(),
        ),
      );
    },
    [session, config, client],
  );
  // Liveness is re-read on a timer (an epoch can roll over while the tab is open) and whenever a
  // failure says the attestation is stale; an out-of-gas relayer raises the banner and a re-check.
  useEffect(() => {
    const timer = setInterval(() => void refreshLiveness(), 60_000);
    return () => clearInterval(timer);
  }, [refreshLiveness]);
  useEffect(
    () =>
      onFailure((f) => {
        if (f.code === "FH_INSUFFICIENT_FUNDS") {
          setOutOfGas(f);
          void refreshHealth();
        }
        if (f.reason && EPOCH_REASONS.has(f.reason)) void refreshLiveness();
      }),
    [refreshHealth, refreshLiveness],
  );

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
  const float = describeFloat(health);
  const rollover = config ? rolloverIn(config.epochs, now) : null;
  const status = (
    <p
      className="status"
      data-live={config?.live ?? "loading"}
      data-liveness={liveness.kind}
      data-relayer={health?.relayer ? (health.relayer.low ? "low" : "ok") : "unknown"}
    >
      {config === null || connecting
        ? `connecting to gateway…${
            connecting && connecting.attempt > 1 ? ` (${connecting.attempt}/${connecting.of})` : ""
          }`
        : config.live
          ? `live · chain ${config.chainId} · ${hostOf(config.gatewayUrl)}${
              liveness.kind === "unknown" ? "" : ` · ${describeLiveness(liveness)}`
            }${rollover === null ? "" : ` · ${describeRollover(rollover)}`}`
          : `offline · ${config.reason}`}
      {float && (
        <span className="float" data-testid="relayer-float">
          {" "}
          · {float}
        </span>
      )}
      {config && !config.live && !connecting && (
        <>
          {" "}
          <button type="button" className="inline" onClick={() => void discover()}>
            retry
          </button>
        </>
      )}
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
      {outOfGas && (
        <p className="banner" role="alert" data-testid="out-of-gas">
          The venue's relayer is out of gas — nothing can be written on chain until its operator
          tops it up. Reading, verifying and the evidence still work.{" "}
          <button type="button" className="inline" onClick={() => setOutOfGas(null)}>
            dismiss
          </button>
        </p>
      )}
    </header>
  );
  // Verification needs no locker: a buyer, a judge, anyone with a manifest or a passport id.
  const verifyLink = (
    <p className="hint">
      No locker needed to{" "}
      <button type="button" className="inline" onClick={() => setRoute("verify")}>
        verify a manifest or a passport
      </button>{" "}
      or to read{" "}
      <button type="button" className="inline" onClick={() => setRoute("evidence")}>
        the measured evidence
      </button>
      .
    </p>
  );
  const publicRoute =
    config && client && session === null && (route === "verify" || route === "evidence") ? (
      <main>
        {header}
        <button type="button" className="inline" onClick={() => setRoute("capture")}>
          ← back
        </button>
        {route === "verify" ? (
          <Verify config={config} client={client} principal={sharedPrincipal} />
        ) : (
          <Evidence />
        )}
      </main>
    ) : null;
  if (publicRoute) return publicRoute;
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
        {(["capture", "locker", "recall", "verify", "evidence"] as const).map((r) => (
          <button type="button" key={r} onClick={() => setRoute(r)} aria-current={route === r}>
            {r}
            {r === "locker" && requests.length > 0 ? ` (${requests.length})` : ""}
          </button>
        ))}
      </nav>
      {route === "capture" && (
        <Capture
          session={session}
          config={config}
          client={client}
          liveness={liveness}
          onActivated={() => void refreshLiveness()}
        />
      )}
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
        <Recall
          session={session}
          config={config}
          client={client}
          liveness={liveness}
          onActivated={() => void refreshLiveness()}
        />
      )}
      {route === "verify" && <Verify config={config} client={client} principal={sharedPrincipal} />}
      {route === "evidence" && <Evidence />}
    </main>
  );
}
