import type { Bytes32, PassportSidecar } from "@firsthand/core";
import { type ManifestVerdict, verifyManifest } from "@firsthand/sdk/browser";
import { useEffect, useState } from "react";
import { Hex } from "../components/Tx.js";
import { type AgentInfo, fetchAgent } from "../lib/agents.js";
import type { AppConfig } from "../lib/config.js";
import { explainFailure } from "../lib/failures.js";
import type { CaptureClient } from "../lib/locker.js";
import { fetchSidecar, type ListedPassport, listPassports } from "../lib/sidecars.js";

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
  const [text, setText] = useState("");
  const [principalId, setPrincipalId] = useState<string>(principal ?? "");
  const [listing, setListing] = useState<ListedPassport[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [agent, setAgent] = useState<AgentInfo | null | "missing">(null);
  const [verdict, setVerdict] = useState<ManifestVerdict | null>(null);
  const [passportId, setPassportId] = useState("");
  const [sidecar, setSidecar] = useState<
    | { id: Bytes32; sidecar: PassportSidecar; anchored: boolean; block: bigint | null }
    | "missing"
    | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explainFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const verify = () =>
    run("verify", async () => {
      setVerdict(null);
      const parsed = JSON.parse(text) as unknown;
      const headBlock = client.publicClient
        ? await client.publicClient.getBlockNumber({ cacheTime: 0 })
        : 0n;
      setVerdict(await verifyManifest(parsed, { anchors: client.anchors, headBlock }));
    });

  const lookup = () =>
    run("lookup", async () => {
      setSidecar(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const id = passportId.trim().toLowerCase() as Bytes32;
      if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("a passport id is 32 bytes of hex");
      const found = await fetchSidecar(config.gatewayUrl, id);
      if (!found) {
        setSidecar("missing");
        return;
      }
      const [anchored, block] = await Promise.all([
        client.anchors.isAnchored(found.batchRoot),
        client.anchors.anchorBlock(found.batchRoot),
      ]);
      setSidecar({ id, sidecar: found, anchored, block });
    });

  const onFile = async (file: File | null) => {
    if (file) setText(await file.text());
  };

  const listPrincipal = (id: string = principalId) =>
    run("list", async () => {
      setListing(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const p = id.trim().toLowerCase() as Bytes32;
      if (!/^0x[0-9a-f]{64}$/.test(p)) throw new Error("a principal id is 32 bytes of hex");
      setListing(await listPassports(config.gatewayUrl, p));
    });
  const lookupAgent = () =>
    run("agent", async () => {
      setAgent(null);
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      if (!/^\d{1,20}$/.test(agentId.trim())) throw new Error("an ERC-8004 agent id is a number");
      const info = await fetchAgent(config.gatewayUrl, agentId.trim());
      setAgent(info ?? "missing");
    });

  // A shared locker link lists on arrival (once per link; the button re-lists on demand).
  const [listedFor, setListedFor] = useState<string | null>(null);
  useEffect(() => {
    if (principal && config.live && listedFor !== principal) {
      setListedFor(principal);
      void listPrincipal(principal);
    }
  });

  return (
    <section>
      <h1>Verify</h1>
      <p className="lede">
        What a buyer does before paying, with nothing but a browser: verify a Lineage Manifest
        against the chain, or inspect a passport the gateway hosts. No passkey, no account.
      </p>

      <h2>Lineage Manifest</h2>
      <p className="hint">
        Paste or upload the JSON a seller or buyer exported. Each asset is checked for its origin
        signature, Merkle inclusion under its batch root, that the root is anchored on chain, and
        finality — ≤ 8 hashes per asset.
      </p>
      <input
        type="file"
        accept=".json,application/json"
        data-testid="manifest-input"
        onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"version":1,"domain":…,"assets":[…]}'
        rows={6}
        data-testid="manifest-text"
      />
      <button
        type="button"
        onClick={verify}
        disabled={text.trim() === "" || busy !== null || !config.live}
      >
        {busy === "verify" ? "Verifying…" : "Verify against the chain"}
      </button>
      {verdict && (
        <div data-testid="verdict" data-ok={verdict.ok}>
          <p>
            <strong>{verdict.ok ? "verifies" : "FAILS"}</strong> · {verdict.assets.length} asset
            {verdict.assets.length === 1 ? "" : "s"} · {verdict.hashesPerAsset} hashes/asset ·{" "}
            {verdict.ms.toFixed(0)} ms ({verdict.merkleMs.toFixed(0)} ms Merkle + anchoring,{" "}
            {verdict.signatureMs.toFixed(0)} ms signatures)
          </p>
          <ul>
            {verdict.assets.map((a) => (
              <li key={a.passportId}>
                <Hex value={a.passportId} /> —{" "}
                {a.ok ? "ok" : <span className="error">{a.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>A locker</h2>
      <p className="hint">
        A human shares their locker as a link (<code>?principal=…</code>). Everything they published
        on this gateway is listed here — namespace, epoch, price — the buyer's starting point.
      </p>
      <input
        value={principalId}
        onChange={(e) => setPrincipalId(e.target.value)}
        placeholder="0x… principal id"
        data-testid="principal-input"
      />
      <button
        type="button"
        onClick={() => listPrincipal()}
        disabled={principalId.trim() === "" || busy !== null || !config.live}
      >
        {busy === "list" ? "Listing…" : "List passports"}
      </button>
      {listing && (
        <ul data-testid="principal-listing">
          {listing.length === 0 && <li className="hint">nothing published on this gateway</li>}
          {listing.map((p) => (
            <li key={p.passportId}>
              <Hex value={p.passportId} n={8} /> · ns {p.ns} · epoch {p.epoch} · {p.price}{" "}
              units/query{" "}
              <button
                type="button"
                className="inline"
                onClick={() => {
                  setPassportId(p.passportId);
                  void lookup();
                }}
              >
                look up
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>An agent (ERC-8004)</h2>
      <p className="hint">
        Buyers can be ERC-8004 agents: an on-chain identity that names its FIRSTHAND card. The
        gateway credits every paid query to the agent's reputation — what a human sees before
        granting.
      </p>
      <input
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        placeholder="agent id (e.g. 42)"
        data-testid="agent-input"
      />
      <button
        type="button"
        onClick={lookupAgent}
        disabled={agentId.trim() === "" || busy !== null || !config.live}
      >
        {busy === "agent" ? "Looking up…" : "Look up agent"}
      </button>
      {agent === "missing" && (
        <p className="hint">no such agent on this chain's registry (or no registry here)</p>
      )}
      {agent && agent !== "missing" && (
        <p data-testid="agent-view">
          #{agent.agentId}
          {agent.name ? ` “${agent.name}”` : ""} · owner <Hex value={agent.owner} n={6} /> · card{" "}
          {agent.cardId ? <Hex value={agent.cardId} n={6} /> : "none bound"} ·{" "}
          {agent.reputation.paidQueriesHere} paid queries credited by this gateway ·{" "}
          {agent.reputation.firsthandFeedbackAll} FIRSTHAND feedback entries overall
        </p>
      )}

      <h2>A passport</h2>
      <input
        value={passportId}
        onChange={(e) => setPassportId(e.target.value)}
        placeholder="0x… passport id"
        data-testid="passport-input"
      />
      <button
        type="button"
        onClick={lookup}
        disabled={passportId.trim() === "" || busy !== null || !config.live}
      >
        {busy === "lookup" ? "Looking up…" : "Look up"}
      </button>
      {sidecar === "missing" && <p className="hint">the gateway does not host that passport</p>}
      {sidecar && sidecar !== "missing" && (
        <dl data-testid="passport-view">
          <dt>origin (deposit key)</dt>
          <dd>
            <Hex value={sidecar.sidecar.signed.passport.origin} n={8} />
          </dd>
          <dt>principal · namespace · epoch</dt>
          <dd>
            <Hex value={sidecar.sidecar.principalId} n={6} /> · {sidecar.sidecar.ns} ·{" "}
            {sidecar.sidecar.signed.passport.epoch.toString()}
          </dd>
          <dt>terms</dt>
          <dd>
            {sidecar.sidecar.terms.price.toString()} USDC units per query · scope{" "}
            {sidecar.sidecar.terms.scope} · rate limit {sidecar.sidecar.terms.rateLimit} · payee{" "}
            <Hex value={sidecar.sidecar.terms.payees[0] ?? ""} n={6} />
          </dd>
          <dt>batch root</dt>
          <dd>
            <Hex value={sidecar.sidecar.batchRoot} n={8} /> —{" "}
            {sidecar.anchored ? `anchored at block ${sidecar.block?.toString()}` : "NOT anchored"}
          </dd>
          <dt>ciphertext</dt>
          <dd>
            <Hex value={sidecar.sidecar.blobRef} n={6} /> (served only to a live grant, paid per
            query)
          </dd>
        </dl>
      )}
      {error && <p className="error">{error}</p>}
      {!config.live && <p className="error">Offline ({config.reason}).</p>}
    </section>
  );
}
