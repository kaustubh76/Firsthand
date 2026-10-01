import { type Bytes32, LineageManifestSchema, type PassportSidecar } from "@firsthand/core";
import { type ManifestVerdict, verifyManifest } from "@firsthand/sdk/browser";
import { useEffect, useState } from "react";
import { ConsentTimeline } from "../components/ConsentTimeline.js";
import { useAsyncActions } from "../hooks/useAsyncActions.js";
import { type AgentInfo, fetchAgent } from "../lib/agents.js";
import { pacerForClient } from "../lib/chainPacer.js";
import type { AppConfig } from "../lib/config.js";
import { askDeviceRegistry, type DeviceReport } from "../lib/devices.js";
import { explainFailure } from "../lib/failures.js";
import { blockTime, pluralise } from "../lib/format.js";
import { describeScan, fetchTimeline, type TimelineScan } from "../lib/ledger.js";
import { mergeLedger } from "../lib/ledgerMerge.js";
import { askLens, describeLens, type LensReport } from "../lib/lens.js";
import type { CaptureClient } from "../lib/locker.js";
import {
  className,
  describeFreshness,
  listing as fetchListing,
  fetchSidecar,
  type Listing,
} from "../lib/sidecars.js";
import { Button, Card, EmptyState, Field, Hash, Icon, Notice, Pill } from "../ui/index.js";

type Action = "verify" | "list" | "agent" | "lookup" | "device";

/**
 * The buyer's one call, for anyone: no passkey, no locker. Paste a Lineage Manifest and it is
 * verified here against the chain — origin signatures, Merkle inclusion, anchoring, finality — or
 * look up a passport id the gateway hosts and see what a buyer would see before paying.
 */
export function Verify({
  config,
  client,
  principal,
}: {
  config: AppConfig;
  client: CaptureClient;
  /** A shared locker link opened this tab: list that principal's passports first. */
  principal?: Bytes32 | null;
}) {
  const actions = useAsyncActions<Action>({ explain: explainFailure });
  const [text, setText] = useState("");
  const [principalId, setPrincipalId] = useState<string>(principal ?? "");
  const [listing, setListing] = useState<Listing | null>(null);
  const [agentId, setAgentId] = useState("");
  const [agent, setAgent] = useState<AgentInfo | null | "missing">(null);
  const [deviceId, setDeviceId] = useState("");
  const [device, setDevice] = useState<DeviceReport | null | "missing">(null);
  const [verdict, setVerdict] = useState<ManifestVerdict | null>(null);
  // The chain's own answer, in the present tense — see `lib/lens.ts` for why it is a different
  // question from the manifest's, and why both belong on screen.
  const [lens, setLens] = useState<LensReport | null>(null);
  const [passportId, setPassportId] = useState("");
  // The Consent Ledger, for whoever holds the link. It lived only inside the passkey-gated Locker,
  // which put the timestamped end of consent out of reach of the auditor it is written for.
  const [timeline, setTimeline] = useState<{
    rows: ReturnType<typeof mergeLedger>;
    scan: TimelineScan | null;
  } | null>(null);
  const [sidecar, setSidecar] = useState<
    | { id: Bytes32; sidecar: PassportSidecar; anchored: boolean; block: bigint | null }
    | "missing"
    | null
  >(null);

  const verify = () =>
    actions.run("verify", async () => {
      setVerdict(null);
      setLens(null);
      const parsed = JSON.parse(text) as unknown;
      // A manifest is checked against the chain, so without a chain there is nothing to check
      // against. This used to default the head to 0, which made every asset report NOT_FINAL and
      // every root unknown — a wall of failures that said "this file is bad" when the truth was
      // "this browser has no RPC".
      if (!client.publicClient) {
        throw new Error(
          "verifying a manifest needs a chain to read: open this from a gateway that publishes an rpcUrl",
        );
      }
      const headBlock = await client.publicClient.getBlockNumber({ cacheTime: 0 });
      const checked = await verifyManifest(parsed, {
        anchors: client.anchors,
        headBlock,
        ...(client.receipts ? { receipts: client.receipts } : {}),
      });
      setVerdict(checked);
      // Whether the file verifies or not, the chain can still be asked whether consent stands; a
      // failed read is reported as a failed read and never softens either verdict.
      if (client.lens) {
        const manifest = LineageManifestSchema.parse(parsed);
        setLens(
          await askLens(client.lens, manifest, pacerForClient(client.publicClient)).catch(
            () => null,
          ),
        );
      }
    });

  const lookup = (id: string = passportId) =>
    actions.run("lookup", async () => {
      setSidecar(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const p = id.trim().toLowerCase() as Bytes32;
      if (!/^0x[0-9a-f]{64}$/.test(p)) throw new Error("a passport id is 32 bytes of hex");
      const found = await fetchSidecar(config.gatewayUrl, p);
      if (!found) {
        setSidecar("missing");
        return;
      }
      const [anchored, block] = await Promise.all([
        client.anchors.isAnchored(found.batchRoot),
        client.anchors.anchorBlock(found.batchRoot),
      ]);
      setSidecar({ id: p, sidecar: found, anchored, block });
    });

  const onFile = async (file: File | null) => {
    if (file) setText(await file.text());
  };

  const listPrincipal = (id: string = principalId) =>
    actions.run("list", async () => {
      setListing(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const p = id.trim().toLowerCase() as Bytes32;
      if (!/^0x[0-9a-f]{64}$/.test(p)) throw new Error("a principal id is 32 bytes of hex");
      setTimeline(null);
      setListing(await fetchListing(config.gatewayUrl, p));
      // Same id, same gateway, one more read: what this locker has consented to and withdrawn.
      const t = await fetchTimeline(config.gatewayUrl, p).catch(() => null);
      if (t) {
        setTimeline({
          // No journal to merge: a visitor has only what the chain says, which is the point.
          rows: mergeLedger(p, t.events, { deposits: [], grants: [], receipts: [] }),
          scan: t.scan,
        });
      }
    });

  const lookupAgent = () =>
    actions.run("agent", async () => {
      setAgent(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      if (!/^\d{1,20}$/.test(agentId.trim())) throw new Error("an ERC-8004 agent id is a number");
      const info = await fetchAgent(config.gatewayUrl, agentId.trim());
      setAgent(info ?? "missing");
    });

  const lookupDevice = () =>
    actions.run("device", async () => {
      setDevice(null);
      if (!client.devices) throw new Error("this chain names no hardware device registry");
      const id = deviceId.trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("a device id is a 32-byte key commitment");
      setDevice((await askDeviceRegistry(client.devices, id as Bytes32)) ?? "missing");
    });

  // A shared locker link lists on arrival (once per link; the button re-lists on demand).
  const [listedFor, setListedFor] = useState<string | null>(null);
  useEffect(() => {
    if (principal && config.live && listedFor !== principal) {
      setListedFor(principal);
      void listPrincipal(principal);
    }
  });

  const offline = !config.live;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    <section>
      <div className="screen-head">
        <span className="eyebrow">Verify</span>
        <h1>What a buyer checks before paying</h1>
        <p className="lede">
          With nothing but a browser: verify a Lineage Manifest against the chain, or inspect a
          passport the gateway hosts. No passkey, no account.
        </p>
      </div>
      {offline && (
        <Notice tone="warn">Offline ({config.reason}) — verification needs a chain to read.</Notice>
      )}

      <Card
        id="verify-manifest"
        icon="shield"
        title="Lineage Manifest"
        subtitle="Paste or upload the JSON a seller or buyer exported. Each asset is checked for its origin signature, Merkle inclusion under its batch root, that the root is anchored on chain, and finality — ≤ 8 hashes per asset."
      >
        <label className="dropzone">
          <span className="dropzone-title">
            <Icon name="upload" />
            Upload a manifest file
          </span>
          <input
            type="file"
            accept=".json,application/json"
            data-testid="manifest-input"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Field label="…or paste it">
          {(id) => (
            <textarea
              id={id}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{"version":1,"domain":…,"assets":[…]}'
              rows={6}
              data-testid="manifest-text"
              spellCheck={false}
            />
          )}
        </Field>
        <div className="btn-row">
          <Button
            variant="primary"
            icon="shield"
            onClick={verify}
            pending={actions.is("verify")}
            pendingLabel="Verifying…"
            disabled={text.trim() === "" || actions.busy !== null || offline}
          >
            Verify against the chain
          </Button>
        </div>
        {actions.errorFor("verify") && <Notice tone="bad">{actions.errorFor("verify")}</Notice>}
        {verdict && (
          <div className="verdict" data-testid="verdict" data-ok={verdict.ok}>
            <p className="verdict-line">
              <Pill tone={verdict.ok ? "ok" : "bad"} dot>
                <strong>{verdict.ok ? "verifies" : "FAILS"}</strong>
              </Pill>
              <span>· {pluralise(verdict.assets.length, "asset")}</span>
              <span>· {verdict.hashesPerAsset} hashes/asset</span>
              <span>
                · {verdict.ms.toFixed(0)} ms ({verdict.merkleMs.toFixed(0)} ms Merkle + anchoring,{" "}
                {verdict.signatureMs.toFixed(0)} ms signatures)
              </span>
            </p>
            {/*
              Payment, stated separately from the verdict. A manifest where nobody ever paid used to
              render exactly as green as one where everybody had; saying "0 of 5 paid" is the whole
              point of the file.
            */}
            <p className="muted" data-testid="receipt-coverage">
              {verdict.receipts.checked ? (
                <>
                  payment: {verdict.receipts.verified} of {verdict.assets.length} asset(s) proved
                  against ReceiptLedger
                  {verdict.receipts.carried > verdict.receipts.verified
                    ? ` · ${verdict.receipts.carried - verdict.receipts.verified} carried a receipt the chain did not confirm`
                    : ""}
                </>
              ) : (
                <>payment: not checked — no receipt ledger to read</>
              )}
              {verdict.receipts.carried === 0
                ? " · no asset in this file claims to have been paid for"
                : ""}
            </p>
            {/*
              The Lens, beside the local verdict rather than folded into it. A manifest of a
              rescinded grant still verifies — the sale happened — and the chain still refuses the
              next query. Both statements are true and a compliance file needs both.
            */}
            {describeLens(lens) && (
              <p className="muted" data-testid="lens-consent">
                {describeLens(lens)}
              </p>
            )}
            <ul className="asset-list">
              {verdict.assets.map((a) => (
                <li key={a.passportId}>
                  <Icon name={a.ok ? "check" : "x"} className={a.ok ? "ok" : "bad"} />
                  <Hash value={a.passportId} />
                  {a.ok ? (
                    <Pill tone="ok">ok</Pill>
                  ) : (
                    <Pill tone="bad">
                      <span className="error">{a.reason}</span>
                    </Pill>
                  )}
                  {(() => {
                    const row = lens?.rows.find((r) => r.passportId === a.passportId);
                    if (!row) return null;
                    return (
                      <Pill tone={row.ok ? "ok" : "warn"}>
                        chain: {row.ok ? "consent stands" : row.reason}
                      </Pill>
                    );
                  })()}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card
        id="verify-locker"
        icon="lock"
        title="A locker"
        subtitle="A human shares their locker as a link (?principal=…). Everything they published on this gateway is listed here — namespace, epoch, class, price — the buyer's starting point."
      >
        <div className="field-row">
          <Field label="Principal id">
            {(id) => (
              <input
                id={id}
                value={principalId}
                onChange={(e) => setPrincipalId(e.target.value)}
                placeholder="0x… principal id"
                data-testid="principal-input"
                spellCheck={false}
              />
            )}
          </Field>
          <Button
            icon="eye"
            onClick={() => listPrincipal()}
            pending={actions.is("list")}
            pendingLabel="Listing…"
            disabled={principalId.trim() === "" || actions.busy !== null || offline}
          >
            List passports
          </Button>
        </div>
        {actions.errorFor("list") && <Notice tone="bad">{actions.errorFor("list")}</Notice>}
        {listing && (
          <ul className="cards" data-testid="principal-listing">
            {listing.passports.length === 0 && (
              <li className="hint">nothing published on this gateway</li>
            )}
            {Object.entries(listing.freshness).map(([ns, f]) => (
              <li key={`fresh-${ns}`} className="hint" data-testid="freshness">
                <Icon name="clock" /> ns {ns}: {describeFreshness(f, nowSeconds)} — a market signal
                from the newest anchor's block time (README §7.3), not a protocol rule
              </li>
            ))}
            {listing.passports.map((p) => (
              <li key={p.passportId} className="listing-row">
                <div className="row-head">
                  <span className="row-meta">
                    <Hash value={p.passportId} n={8} copy />
                    <Pill tone="accent" data-testid="class">
                      {className(p.class)}
                    </Pill>
                  </span>
                  <Button
                    variant="inline"
                    onClick={() => {
                      setPassportId(p.passportId);
                      void lookup(p.passportId);
                    }}
                  >
                    look up
                  </Button>
                </div>
                <div className="row-meta">
                  <span>ns {p.ns}</span>
                  <span>epoch {p.epoch}</span>
                  <span>{p.price} units/query</span>
                  {p.capturedAt && blockTime(p.capturedAt) && (
                    <span>captured {blockTime(p.capturedAt)}</span>
                  )}
                  {p.sourceTag && (
                    <span>
                      source <Hash value={p.sourceTag} n={4} />
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {timeline && (
        <Card
          id="verify-ledger"
          icon="clock"
          title="Consent Ledger"
          subtitle="Every grant this locker gave and every one it withdrew, read from the chain's own event logs — including the block consent ended at. No passkey: this is the auditor's view, and it is the same ledger the owner sees."
        >
          {describeScan(timeline.scan) && (
            <p className="hint" data-testid="public-ledger-scan">
              {describeScan(timeline.scan)}
            </p>
          )}
          {timeline.rows.length === 0 ? (
            <p className="hint">no consent events in the gateway's scan window</p>
          ) : (
            <ConsentTimeline rows={timeline.rows} chainId={config.chainId} testId="public-ledger" />
          )}
        </Card>
      )}

      <Card
        id="verify-device"
        icon="lock"
        title="A device"
        subtitle="A class-3 passport is witnessed by a secure element whose attestation chain this chain verified. This is that record, read from the registry rather than from a gateway — what the chain knows about the hardware, and whether the human has since revoked it."
      >
        <div className="field-row">
          <Field label="Device key commitment">
            {(id) => (
              <input
                id={id}
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                placeholder="0x… (the attestation's deviceClass)"
                data-testid="device-input"
              />
            )}
          </Field>
          <Button
            icon="eye"
            onClick={lookupDevice}
            pending={actions.is("device")}
            pendingLabel="Looking up…"
            disabled={deviceId.trim() === "" || actions.busy !== null || offline}
          >
            Look up device
          </Button>
        </div>
        {actions.errorFor("device") && <Notice tone="bad">{actions.errorFor("device")}</Notice>}
        {!client.devices && !offline && (
          <Notice tone="warn">
            This chain names no hardware device registry, so no passport here can be class 3.
          </Notice>
        )}
        {device === "missing" && (
          <EmptyState
            icon="lock"
            title="No such device"
            hint="Never registered on this chain — a witness from it would be refused at ingest."
          />
        )}
        {device && device !== "missing" && (
          <dl className="kv" data-testid="device-view">
            <dt>principal</dt>
            <dd>
              <Hash value={device.principalId} n={6} copy />
            </dd>
            <dt>security level</dt>
            <dd>{device.level} — measured, read out of the certificate the chain verified</dd>
            <dt>verified boot</dt>
            <dd>
              {device.boot === null
                ? "not attested"
                : `${device.boot} — recorded by the chain, enforced by whichever gateway chooses to`}
            </dd>
            <dt>registered</dt>
            <dd>{blockTime(device.registeredAt)}</dd>
            <dt>consent</dt>
            <dd>
              {device.live ? (
                <Pill tone="ok">live</Pill>
              ) : (
                <>
                  <Pill tone="bad">revoked</Pill> {blockTime(device.revokedAt as bigint)}
                </>
              )}
            </dd>
          </dl>
        )}
      </Card>

      <Card
        id="verify-agent"
        icon="key"
        title="An agent (ERC-8004)"
        subtitle="Buyers can be ERC-8004 agents: an on-chain identity that names its FIRSTHAND card. The gateway credits every paid query to the agent's reputation — what a human sees before granting."
      >
        <div className="field-row">
          <Field label="Agent id">
            {(id) => (
              <input
                id={id}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="agent id (e.g. 42)"
                inputMode="numeric"
                data-testid="agent-input"
              />
            )}
          </Field>
          <Button
            icon="eye"
            onClick={lookupAgent}
            pending={actions.is("agent")}
            pendingLabel="Looking up…"
            disabled={agentId.trim() === "" || actions.busy !== null || offline}
          >
            Look up agent
          </Button>
        </div>
        {actions.errorFor("agent") && <Notice tone="bad">{actions.errorFor("agent")}</Notice>}
        {agent === "missing" && (
          <EmptyState
            icon="key"
            title="No such agent"
            hint="Not on this chain's registry — or this gateway names no registry."
          />
        )}
        {agent && agent !== "missing" && (
          <dl className="kv" data-testid="agent-view">
            <dt>agent</dt>
            <dd>
              #{agent.agentId}
              {agent.name ? ` “${agent.name}”` : ""}
            </dd>
            <dt>owner</dt>
            <dd>
              <Hash value={agent.owner} n={6} copy />
            </dd>
            <dt>card</dt>
            <dd>{agent.cardId ? <Hash value={agent.cardId} n={6} copy /> : "none bound"}</dd>
            <dt>reputation</dt>
            <dd>
              {agent.reputation.paidQueriesHere} paid queries credited by this gateway ·{" "}
              {agent.reputation.firsthandFeedbackAll} FIRSTHAND feedback entries overall
            </dd>
          </dl>
        )}
      </Card>

      <Card
        id="verify-passport"
        icon="stamp"
        title="A passport"
        subtitle="What the gateway hosts for one id: origin, terms, batch root and its anchor — everything but the plaintext."
      >
        <div className="field-row">
          <Field label="Passport id">
            {(id) => (
              <input
                id={id}
                value={passportId}
                onChange={(e) => setPassportId(e.target.value)}
                placeholder="0x… passport id"
                data-testid="passport-input"
                spellCheck={false}
              />
            )}
          </Field>
          <Button
            icon="eye"
            onClick={() => lookup()}
            pending={actions.is("lookup")}
            pendingLabel="Looking up…"
            disabled={passportId.trim() === "" || actions.busy !== null || offline}
          >
            Look up
          </Button>
        </div>
        {actions.errorFor("lookup") && <Notice tone="bad">{actions.errorFor("lookup")}</Notice>}
        {sidecar === "missing" && (
          <EmptyState
            icon="stamp"
            title="Not hosted here"
            hint="The gateway does not host that passport."
          />
        )}
        {sidecar && sidecar !== "missing" && (
          <dl className="kv" data-testid="passport-view">
            <dt>origin (deposit key)</dt>
            <dd>
              <Hash value={sidecar.sidecar.signed.passport.origin} n={8} copy />
            </dd>
            <dt>principal · namespace · epoch</dt>
            <dd>
              <Hash value={sidecar.sidecar.principalId} n={6} /> · {sidecar.sidecar.ns} ·{" "}
              {sidecar.sidecar.signed.passport.epoch.toString()}
            </dd>
            <dt>terms</dt>
            <dd>
              {sidecar.sidecar.terms.price.toString()} USDC units per query · scope{" "}
              {sidecar.sidecar.terms.scope} · rate limit {sidecar.sidecar.terms.rateLimit} · payee{" "}
              <Hash value={sidecar.sidecar.terms.payees[0] ?? ""} n={6} />
            </dd>
            <dt>batch root</dt>
            <dd>
              <Hash value={sidecar.sidecar.batchRoot} n={8} /> ·{" "}
              {sidecar.anchored ? (
                <Pill tone="ok" dot>
                  anchored at block {sidecar.block?.toString()}
                </Pill>
              ) : (
                <Pill tone="bad">NOT anchored</Pill>
              )}
            </dd>
            <dt>ciphertext</dt>
            <dd>
              <Hash value={sidecar.sidecar.blobRef} n={6} /> (served only to a live grant, paid per
              query)
            </dd>
          </dl>
        )}
      </Card>
    </section>
  );
}
