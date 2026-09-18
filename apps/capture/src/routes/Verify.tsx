import type { Bytes32, PassportSidecar } from "@firsthand/core";
import { type ManifestVerdict, verifyManifest } from "@firsthand/sdk/browser";
import { useState } from "react";
import { Hex } from "../components/Tx.js";
import type { AppConfig } from "../lib/config.js";
import type { CaptureClient } from "../lib/locker.js";
import { fetchSidecar } from "../lib/sidecars.js";

/**
 * The buyer's one call, for anyone: no passkey, no locker. Paste a Lineage Manifest and it is
 * verified here against the chain — origin signatures, Merkle inclusion, anchoring, finality — or
 * look up a passport id the gateway hosts and see what a buyer would see before paying.
 */
export function Verify({ config, client }: { config: AppConfig; client: CaptureClient }) {
  const [text, setText] = useState("");
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
      setError((e as Error).message);
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
