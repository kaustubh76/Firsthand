import type { ReceiptView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import {
  type ManifestVerdict,
  manifestFromSidecars,
  serialiseManifest,
  verifyManifest,
} from "@firsthand/sdk/browser";
import { useState } from "react";
import { useToasts } from "../../hooks/useToasts.js";
import { downloadJson } from "../../lib/download.js";
import { pluralise } from "../../lib/format.js";
import { fetchReceipts } from "../../lib/ledger.js";
import { honestFinalityDepth } from "../../lib/manifest.js";
import { fetchSidecar } from "../../lib/sidecars.js";
import { NS } from "../../lib/terms.js";
import { Button, Card, Hash, Notice, Pill } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/**
 * The Lineage Manifest: one file that answers per-asset diligence — origin signature, batch proof,
 * anchor, receipt — rebuilt from what the gateway publishes and verified here against the chain.
 */
export function ManifestCard({ ctx }: { ctx: LockerCtx }) {
  const { session, config, client, journal, mutate, actions } = ctx;
  const toasts = useToasts();
  const principalId = session.locker.principalId;
  const [manifest, setManifest] = useState<{ text: string; verdict: ManifestVerdict } | null>(null);

  const build = () =>
    actions.run("manifest", async () => {
      if (!config.gatewayUrl) throw new Error("no gateway");
      // Rebuilt from what the gateway publishes, not from this session's memory: the same file a
      // buyer could assemble, and it survives a reload.
      const receipts = new Map<Bytes32, ReceiptView>();
      const from = journal.enrolBlock ? BigInt(journal.enrolBlock) : undefined;
      for (const g of journal.grants) {
        for (const r of await fetchReceipts(config.gatewayUrl, g.grantId, from)) {
          const entry = journal.receipts.find((x) => x.receiptId === r.receiptId);
          if (entry) receipts.set(entry.passportId, r);
        }
      }
      const sidecars = [];
      for (const d of journal.deposits) {
        if (d.ns !== NS.captures || !d.published) continue;
        const sc = await fetchSidecar(config.gatewayUrl, d.passportId);
        if (sc) sidecars.push(sc);
      }
      if (sidecars.length === 0) throw new Error("no published captures to export yet");
      const head = client.publicClient
        ? await client.publicClient.getBlockNumber({ cacheTime: 0 })
        : 0n;
      const m = await manifestFromSidecars({
        domain: session.locker.domain,
        principalId,
        ns: NS.captures,
        sidecars,
        anchors: client.anchors,
        receipts,
        // Claim the depth the anchors have actually reached, never a flat zero — see lib/manifest.ts.
        finalityDepth: await honestFinalityDepth(
          client.anchors,
          sidecars.map((sc) => sc.batchRoot),
          head,
        ),
      });
      const verdict = await verifyManifest(m, {
        anchors: client.anchors,
        headBlock: head,
        ...(client.receipts ? { receipts: client.receipts } : {}),
      });
      setManifest({ text: serialiseManifest(m), verdict });
      if (verdict.ok) {
        mutate((j) => {
          j.manifestAt = Date.now();
        });
        toasts.push({
          tone: "success",
          title: "Lineage Manifest verifies",
          detail: `${pluralise(verdict.assets.length, "asset")} · ${verdict.ms.toFixed(0)} ms against the chain`,
        });
      }
    });

  const download = () => {
    if (manifest) downloadJson(`lineage-${principalId.slice(2, 10)}.json`, manifest.text);
  };
  const err = actions.errorFor("manifest");

  return (
    <Card
      id="locker-manifest"
      icon="shield"
      title="Lineage Manifest"
      subtitle="One file that answers per-asset diligence: origin signature, batch proof, anchor, receipt. Verified here against the chain — no gateway in the loop."
    >
      <div className="btn-row">
        <Button
          variant="primary"
          icon="shield"
          onClick={build}
          pending={actions.is("manifest")}
          pendingLabel="Verifying…"
          disabled={!config.live || journal.deposits.length === 0 || actions.busy !== null}
        >
          Export + verify manifest
        </Button>
      </div>
      {manifest && (
        <div className="verdict">
          <p className="manifest-line" data-testid="manifest">
            <Pill tone={manifest.verdict.ok ? "ok" : "bad"} dot>
              {manifest.verdict.ok ? "verifies" : "FAILS"}
            </Pill>
            <span>· {pluralise(manifest.verdict.assets.length, "asset")}</span>
            <span>· {manifest.verdict.hashesPerAsset} hashes/asset</span>
            <span>
              · {manifest.verdict.ms.toFixed(0)} ms ({manifest.verdict.merkleMs.toFixed(0)} Merkle +
              anchoring, {manifest.verdict.signatureMs.toFixed(0)} signatures)
            </span>
            {/* Payment, said out loud: a seller's file usually carries none, and that is not a pass. */}
            <span data-testid="receipt-coverage">
              {manifest.verdict.receipts.checked
                ? ` · ${manifest.verdict.receipts.verified} paid read(s) proved on chain`
                : " · payment not checked"}
            </span>
            <Button variant="inline" icon="download" onClick={download}>
              download JSON
            </Button>
          </p>
          {!manifest.verdict.ok && (
            <ul className="asset-list">
              {manifest.verdict.assets
                .filter((a) => !a.ok)
                .map((a) => (
                  <li key={a.passportId}>
                    <Hash value={a.passportId} />
                    <span className="error">{a.reason}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
    </Card>
  );
}
