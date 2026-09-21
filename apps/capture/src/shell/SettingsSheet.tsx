import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";
import { useInstallPrompt } from "../hooks/useInstallPrompt.js";
import { type ThemePref, useTheme } from "../hooks/useTheme.js";
import { useTx } from "../hooks/useTx.js";
import { clearAgentRecord } from "../lib/agent.js";
import type { AppConfig } from "../lib/config.js";
import { addressUrl } from "../lib/explorer.js";
import { blockTime, formatMon, relativeTime } from "../lib/format.js";
import { describeRollover, type GatewayHealth, rolloverIn } from "../lib/health.js";
import { clearJournal } from "../lib/journal.js";
import { forgetCredentialId } from "../lib/prf.js";
import {
  describeSettlement,
  describeUploadCap,
  gatewayHref,
  validGatewayUrl,
} from "../lib/settings.js";
import { Button, Field, Hash, Notice, Pill, Timeline, type TimelineItem, Tx } from "../ui/index.js";
import { Sheet } from "../ui/Sheet.js";

/**
 * The venue and this device, one tap from every screen. Nothing here talks to the chain: it reads
 * what discovery and /healthz already said, switches gateways through the `?gateway=` mechanism
 * that resolveGatewayUrl remembers, and forgets local records. Action names stay free of the
 * words capture / locker / recall (the browser tier clicks nav buttons by those, unscoped).
 */
export function SettingsSheet({
  open,
  onClose,
  config,
  health,
  onRefreshHealth,
  session,
  now,
}: {
  open: boolean;
  onClose: () => void;
  config: AppConfig | null;
  health: GatewayHealth | null;
  onRefreshHealth: () => void;
  session: LockerSession | null;
  now: bigint;
}) {
  const theme = useTheme();
  const install = useInstallPrompt();
  const tx = useTx();
  const [gatewayInput, setGatewayInput] = useState("");
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"passkey" | "journal" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const useGateway = () => {
    const url = validGatewayUrl(gatewayInput);
    if (!url) {
      setGatewayError("Enter an https:// gateway URL (http:// only for localhost).");
      return;
    }
    location.assign(gatewayHref(location.href, url));
  };
  const forgetGateway = () => location.assign(gatewayHref(location.href, null));

  const rollover = config ? rolloverIn(config.epochs, now, 7n * 86_400n) : null;
  const epochNow =
    config && config.epochs.length > 0n && now >= config.epochs.genesis
      ? (now - config.epochs.genesis) / config.epochs.length
      : null;

  const activity: TimelineItem[] = tx.txs.map((t) => ({
    id: t.hash,
    status: t.status === "mined" ? "chain" : t.status === "failed" ? "failed" : "pending",
    title: t.label,
    meta: (
      <>
        <span>{relativeTime(t.sentAt)}</span>
        {config && <Tx hash={t.hash} chainId={config.chainId} copy={false} />}
      </>
    ),
    body: t.error ? <span className="error">{t.error}</span> : undefined,
  }));

  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <section className="sheet-section">
        <h3>Gateway</h3>
        <p className="hint">
          The venue this app talks to. Discovery gives it the contracts, the epoch clock and the
          relay; a different gateway is a different venue for the same locker.
        </p>
        <p className="row-meta">
          <span>current</span>
          <code className="hex">{config?.gatewayUrl ?? "none"}</code>
          {config && (
            <Pill tone={config.live ? "ok" : "bad"} dot>
              {config.live ? "live" : "offline"}
            </Pill>
          )}
        </p>
        <Field label="Switch to another gateway" error={gatewayError}>
          {(id) => (
            <input
              id={id}
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={gatewayInput}
              onChange={(e) => {
                setGatewayInput(e.target.value);
                setGatewayError(null);
              }}
            />
          )}
        </Field>
        <div className="btn-row">
          <Button
            variant="primary"
            icon="arrow"
            onClick={useGateway}
            disabled={!gatewayInput.trim()}
          >
            Use this gateway
          </Button>
          <Button variant="ghost" onClick={forgetGateway}>
            Forget override
          </Button>
        </div>
        <p className="hint">
          The page reloads on this venue; the choice is remembered on this device.
        </p>
      </section>

      <section className="sheet-section">
        <h3>Venue</h3>
        {config ? (
          <dl className="kv">
            <dt>chain</dt>
            <dd>{config.chainId.toString()}</dd>
            <dt>wiring</dt>
            <dd>{describeSettlement(health)}</dd>
            <dt>relayer</dt>
            <dd>
              {health?.relayer ? (
                <span className="row-meta">
                  <Hash
                    value={health.relayer.address}
                    n={6}
                    copy
                    href={addressUrl(config.chainId, health.relayer.address)}
                  />
                  <span>{formatMon(health.relayer.balanceMon)}</span>
                  <Pill
                    tone={
                      health.relayer.balanceMon <= 0.001
                        ? "bad"
                        : health.relayer.low
                          ? "warn"
                          : "ok"
                    }
                    dot
                  >
                    {health.relayer.balanceMon <= 0.001
                      ? "out of gas"
                      : health.relayer.low
                        ? "low"
                        : "funded"}
                  </Pill>
                </span>
              ) : config.live ? (
                "not reported"
              ) : (
                "offline"
              )}
            </dd>
            <dt>relay</dt>
            <dd>
              {config.relayEnabled
                ? `${config.relayAllow.length} allowed entry point${config.relayAllow.length === 1 ? "" : "s"}${config.faucet ? " · faucet mint" : ""}`
                : "disabled"}
            </dd>
            <dt>uploads</dt>
            <dd>{describeUploadCap(config.maxUploadBytes)}</dd>
            <dt>anchors</dt>
            <dd>{config.anchorsLayout} layout</dd>
            <dt>ERC-8004</dt>
            <dd>
              {config.erc8004 ? "identity + reputation registries published" : "no registries here"}
            </dd>
            <dt>epoch</dt>
            <dd>
              {epochNow === null ? "—" : `#${epochNow.toString()}`} · length{" "}
              {(Number(config.epochs.length) / 86_400).toFixed(0)} d · genesis{" "}
              {blockTime(config.epochs.genesis) || config.epochs.genesis.toString()}
              {rollover !== null && ` · ${describeRollover(rollover)}`}
            </dd>
          </dl>
        ) : (
          <p className="hint">Still connecting.</p>
        )}
        <div className="btn-row">
          <Button size="sm" icon="refresh" onClick={onRefreshHealth} disabled={!config?.live}>
            Refresh health
          </Button>
        </div>
      </section>

      <section className="sheet-section">
        <h3>Appearance</h3>
        <div className="radio-row" role="radiogroup" aria-label="Theme">
          {(["system", "dark", "light"] as const).map((p: ThemePref) => (
            <label key={p}>
              <input
                type="radio"
                name="theme"
                value={p}
                checked={theme.pref === p}
                onChange={() => theme.setPref(p)}
              />
              {p === "system" ? "System" : p === "dark" ? "Dark" : "Light"}
            </label>
          ))}
        </div>
      </section>

      <section className="sheet-section">
        <h3>App</h3>
        {install.installed ? (
          <p className="row-meta">
            <Pill tone="ok" dot>
              installed
            </Pill>
            <span>Running as an app on this device.</span>
          </p>
        ) : install.canInstall ? (
          <div className="btn-row">
            <Button icon="download" onClick={() => void install.prompt()}>
              Install app
            </Button>
            <span className="hint">Adds FIRSTHAND to your home screen or dock.</span>
          </div>
        ) : (
          <p className="hint">
            Install from the browser menu ("Add to Home Screen" / "Install") to run this as an app.
          </p>
        )}
      </section>

      <section className="sheet-section">
        <h3>This device</h3>
        <p className="hint">
          Nothing here touches the chain. The passkey stays in your authenticator; the journal is
          this browser's record of what it did; the demo buyer is a throwaway key.
        </p>
        <div className="btn-row">
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirm(confirm === "passkey" ? null : "passkey")}
          >
            Forget passkey on this device
          </Button>
          <Button
            size="sm"
            disabled={!session}
            onClick={() => setConfirm(confirm === "journal" ? null : "journal")}
          >
            Clear local journal
          </Button>
          <Button
            size="sm"
            onClick={() => {
              clearAgentRecord();
              setNote("Demo buyer cleared — the next run mints a fresh one.");
            }}
          >
            Clear demo buyer
          </Button>
        </div>
        {confirm === "passkey" && (
          <Notice tone="warn">
            <p>
              This browser forgets which passkey opens the app; the passkey itself and everything on
              chain stay. Enrolling again creates a <em>new</em> principal.
            </p>
            <div className="btn-row">
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  forgetCredentialId();
                  location.assign(gatewayHref(location.href, config?.gatewayUrl ?? null));
                }}
              >
                Forget and reload
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Keep it
              </Button>
            </div>
          </Notice>
        )}
        {confirm === "journal" && session && (
          <Notice tone="warn">
            <p>
              Deposits, grants and receipts recorded by this browser are forgotten; the chain and
              the gateway keep every one of them, and the Consent Ledger re-reads what it can.
            </p>
            <div className="btn-row">
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  clearJournal(session.locker.principalId);
                  setConfirm(null);
                  setNote("Local journal cleared.");
                }}
              >
                Clear it
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Keep it
              </Button>
            </div>
          </Notice>
        )}
        {note && <Notice tone="ok">{note}</Notice>}
      </section>

      <section className="sheet-section">
        <h3>Activity</h3>
        {activity.length === 0 ? (
          <p className="hint">No relayed transactions from this tab yet.</p>
        ) : (
          <>
            <Timeline items={activity} />
            <div className="btn-row">
              <Button variant="ghost" size="sm" onClick={tx.clear}>
                Clear list
              </Button>
            </div>
          </>
        )}
      </section>
    </Sheet>
  );
}
