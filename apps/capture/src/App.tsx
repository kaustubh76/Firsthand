import type { LockerSession } from "@firsthand/sdk/browser";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJournal } from "./hooks/useJournal.js";
import { useJourney } from "./hooks/useJourney.js";
import { useTheme } from "./hooks/useTheme.js";
import { TxContext, useTxTracker } from "./hooks/useTx.js";
import { type AppConfig, loadConfig } from "./lib/config.js";
import { EPOCH_REASONS, type Failure, onFailure } from "./lib/failures.js";
import { fetchHealth, type GatewayHealth } from "./lib/health.js";
import { fetchLiveness, type Liveness } from "./lib/liveness.js";
import { type CaptureClient, createClient, openSession } from "./lib/locker.js";
import {
  forgetCredentialId,
  isPrfAbsent,
  prfSourceFor,
  saveCredentialId,
  savedCredentialId,
} from "./lib/prf.js";
import { absorbRequestFromUrl, type GrantRequest, parsePrincipalLink } from "./lib/requests.js";
import { Capture } from "./routes/Capture.js";
import { Enroll } from "./routes/Enroll.js";
import { Evidence } from "./routes/Evidence.js";
import { LockerView } from "./routes/Locker.js";
import { Recall } from "./routes/Recall.js";
import { Unlock } from "./routes/Unlock.js";
import { Verify } from "./routes/Verify.js";
import { Header } from "./shell/Header.js";
import { JourneyRail } from "./shell/JourneyRail.js";
import { LoadingFrame } from "./shell/LoadingFrame.js";
import { Nav } from "./shell/Nav.js";
import { initialRoute, NavigationContext, type Navigator, type Route } from "./shell/navigation.js";
import { PublicFrame } from "./shell/PublicFrame.js";
import { SettingsSheet } from "./shell/SettingsSheet.js";
import { StatusStrip } from "./shell/StatusStrip.js";
import { Button, Icon } from "./ui/index.js";

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

export function App() {
  useTheme();

  // Addresses come from the gateway's discovery document, so this is async — the browser has no
  // deployment file to read.
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [rawClient, setRawClient] = useState<CaptureClient | null>(null);
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
      setRawClient(createClient(c));
    } finally {
      discovering.current = false;
      setConnecting(null);
    }
  }, []);
  useEffect(() => {
    void discover();
  }, [discover]);

  // Every relayed transaction the routes wait for becomes a toast and a timeline row.
  const tracker = useTxTracker(rawClient, config?.chainId ?? null);
  const client = tracker.client;

  // The venue's float and the epoch clock, on every screen: a judge sees "relayer low" or "epoch
  // rolls over in 40 min" before a tap fails, not after.
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [now, setNow] = useState(nowSeconds);
  const refreshHealth = useCallback(async () => {
    if (config?.live) setHealth(await fetchHealth(config));
  }, [config]);
  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => {
      void refreshHealth();
      setNow(nowSeconds());
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

  // Routing: state mirrored into the hash; `go()` may name a card to scroll to and focus.
  const [route, setRoute] = useState<Route>(() =>
    initialRoute({
      sharedPrincipal: sharedPrincipal !== null,
      hasRequests: requests.length > 0,
      hash: typeof location === "undefined" ? "" : location.hash,
    }),
  );
  const [target, setTarget] = useState<string | null>(null);
  const go = useCallback((r: Route, t?: string) => {
    setRoute(r);
    setTarget(t ?? null);
  }, []);
  const navigator = useMemo<Navigator>(() => ({ route, target, go }), [route, target, go]);
  useEffect(() => {
    if (typeof history !== "undefined" && location.hash !== `#${route}`) {
      history.replaceState(null, "", `#${route}`);
    }
  }, [route]);
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(target);
      if (el) {
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
        el.focus({ preventScroll: true });
      }
      setTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const [liveness, setLiveness] = useState<Liveness>({ kind: "unknown" });

  // The journey rail: seven beats of the script, lit by the credential, the chain and the journal.
  const [journal, mutateJournal] = useJournal(session?.locker.principalId ?? null);
  const journeyInputs = useMemo(
    () => ({
      unlocked: session !== null,
      live: config?.live ?? false,
      liveness,
      journal: session ? journal : null,
    }),
    [session, config?.live, liveness, journal],
  );
  const journey = useJourney(journeyInputs);
  useEffect(() => {
    if (session && route === "evidence" && !journal.evidenceSeenAt) {
      mutateJournal((j) => {
        j.evidenceSeenAt = Date.now();
      });
    }
  }, [session, route, journal.evidenceSeenAt, mutateJournal]);

  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

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

  /**
   * One passkey tap derives the key tree. This is also the PRF gate: the authenticator's
   * create-time flag is only a hint, so a fresh credential is remembered only once it has actually
   * derived, and an authenticator that cannot derive is named here rather than at enrolment.
   */
  async function unlock(id: Uint8Array, justEnrolled = false) {
    if (!client) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const s = await openSession(client.client, prfSourceFor(id));
      if (justEnrolled) saveCredentialId(id);
      setSession(s);
      void refreshLiveness(s);
    } catch (e) {
      if (isPrfAbsent(e)) {
        // A passkey that cannot derive must not be remembered, or every load retries it.
        forgetCredentialId();
        setCredentialId(null);
        setUnlockError(
          "This passkey cannot derive a locker key: its authenticator does not return a PRF output. Enrol with a passkey held by the device you are using — Touch ID on this Mac, Windows Hello on this PC, the screen lock on this phone — rather than one on another device over a QR code.",
        );
      } else {
        setUnlockError((e as Error).message);
      }
    } finally {
      setUnlocking(false);
    }
  }

  const [settingsOpen, setSettingsOpen] = useState(false);
  const header = (
    <Header
      tools={
        <Button
          variant="ghost"
          icon="settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        />
      }
      status={
        <StatusStrip
          config={config}
          connecting={connecting}
          liveness={liveness}
          health={health}
          now={now}
          onRetry={() => void discover()}
        />
      }
      outOfGas={outOfGas}
      onDismissOutOfGas={() => setOutOfGas(null)}
    />
  );

  // Verification needs no locker: a buyer, a judge, anyone with a manifest or a passport id. (Their
  // names must stay free of "capture", "locker", "recall" — the browser tier clicks nav buttons by
  // those names, unscoped.)
  const publicLinks = (
    <p className="public-links">
      <Icon name="shield" />
      <span>No passkey needed to</span>
      <Button variant="inline" onClick={() => go("verify")}>
        verify a manifest or a passport
      </Button>
      <span>or to read</span>
      <Button variant="inline" onClick={() => go("evidence")}>
        the measured evidence
      </Button>
      .
    </p>
  );

  let body: ReactElement;
  if (!config || !client) {
    body = <LoadingFrame />;
  } else if (session === null && (route === "verify" || route === "evidence")) {
    body = (
      <PublicFrame onBack={() => go("capture")}>
        {route === "verify" ? (
          <Verify config={config} client={client} principal={sharedPrincipal} />
        ) : (
          <Evidence />
        )}
      </PublicFrame>
    );
  } else if (credentialId === null) {
    body = (
      <main>
        <JourneyRail steps={journey} />
        <Enroll
          problem={unlockError}
          onEnrolled={(id) => {
            setCredentialId(id);
            void unlock(id, true);
          }}
        />
        {publicLinks}
      </main>
    );
  } else if (session === null) {
    body = (
      <main>
        <JourneyRail steps={journey} />
        <Unlock onUnlock={() => void unlock(credentialId)} busy={unlocking} error={unlockError} />
        {publicLinks}
      </main>
    );
  } else {
    body = (
      <>
        <JourneyRail steps={journey} />
        <Nav badges={{ locker: requests.length }} />
        <main>
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
          {route === "verify" && (
            <Verify config={config} client={client} principal={sharedPrincipal} />
          )}
          {route === "evidence" && <Evidence />}
        </main>
      </>
    );
  }

  return (
    <NavigationContext.Provider value={navigator}>
      <TxContext.Provider value={tracker}>
        <div className="app">
          {header}
          {body}
          <SettingsSheet
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            config={config}
            health={health}
            onRefreshHealth={() => void refreshHealth()}
            session={session}
            now={now}
          />
        </div>
      </TxContext.Provider>
    </NavigationContext.Provider>
  );
}
