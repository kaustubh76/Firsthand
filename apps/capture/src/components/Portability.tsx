import type { Bytes32 } from "@firsthand/core";
import { exportLocker, importLocker, serialiseBundle } from "@firsthand/sdk/browser";
import { useState } from "react";
import { useAsyncActions } from "../hooks/useAsyncActions.js";
import type { AppConfig } from "../lib/config.js";
import { downloadJson } from "../lib/download.js";
import { explainFailure } from "../lib/failures.js";
import { pluralise } from "../lib/format.js";
import { Button, Card, Notice } from "../ui/index.js";

/**
 * README §4: "exit = keys + blobs walk away". The keys are the passkey; the blobs are what this
 * gateway holds for the locker — ciphertext, sidecars, grant wraps, all public and content-
 * addressed. One tap downloads them as a file; the same file re-publishes on any conformant
 * gateway (`?gateway=` points this app at one), which verifies every object against the chain
 * before hosting it. The chain is the source of truth; a gateway is a cache you can leave.
 */
export function Portability({
  config,
  principalId,
  grantIds,
}: {
  config: AppConfig;
  principalId: Bytes32;
  grantIds: readonly Bytes32[];
}) {
  const actions = useAsyncActions<"download" | "republish">({ explain: explainFailure });
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const download = () =>
    actions.run("download", async () => {
      setNote(null);
      setProgress("Reading…");
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const bundle = await exportLocker({
        gatewayUrl: config.gatewayUrl,
        principalId,
        chainId: config.chainId,
        grantIds,
        onProgress: (done, total) => setProgress(`Reading ${done}/${total}…`),
      });
      const name = `firsthand-locker-${principalId.slice(2, 10)}.json`;
      downloadJson(name, serialiseBundle(bundle));
      setNote(
        `${name}: ${pluralise(bundle.passports.length, "passport")} (ciphertext + sidecars) · ${pluralise(
          bundle.wraps.length,
          "grant wrap",
        )} — no plaintext, no key`,
      );
    });

  const republish = () =>
    actions.run("republish", async () => {
      setNote(null);
      setProgress("Publishing…");
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      if (!file) throw new Error("choose a locker bundle first");
      const report = await importLocker({
        gatewayUrl: config.gatewayUrl,
        bundle: await file.text(),
        onProgress: (done, total) => setProgress(`Publishing ${done}/${total}…`),
      });
      const skipped =
        report.skipped.length === 0
          ? ""
          : ` · ${report.skipped.length} refused by this gateway (${report.skipped[0]?.reason})`;
      setNote(
        `re-published here: ${pluralise(report.passports, "passport")}, ${report.blobs} blobs, ${pluralise(
          report.wraps,
          "wrap",
        )}${skipped}`,
      );
    });

  return (
    <Card
      id="locker-exit"
      icon="box"
      title="Take your locker with you"
      subtitle="Everything this gateway holds for you is public and content-addressed. Your keys are your passkey."
    >
      <p className="hint">
        Download ciphertext, sidecars and grant wraps as one file and re-publish it on any
        conformant gateway (open this app with <code>?gateway=…</code>); it verifies each object
        against the chain before hosting it. The chain is the source of truth; a gateway is a cache
        you can leave.
      </p>
      <div className="btn-row">
        <Button
          icon="download"
          onClick={download}
          pending={actions.is("download")}
          pendingLabel={progress ?? "Reading…"}
          disabled={actions.busy !== null || !config.live}
          data-testid="bundle-download"
        >
          Download bundle
        </Button>
      </div>
      <label className="dropzone">
        <span className="dropzone-title">Re-publish a bundle here</span>
        <input
          type="file"
          accept=".json,application/json"
          data-testid="bundle-input"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <span className="btn-row">
          <Button
            icon="upload"
            size="sm"
            onClick={republish}
            pending={actions.is("republish")}
            pendingLabel={progress ?? "Publishing…"}
            disabled={actions.busy !== null || !config.live || !file}
            data-testid="bundle-republish"
          >
            Re-publish here
          </Button>
          {file && <span className="hint">{file.name}</span>}
        </span>
      </label>
      {note && (
        <Notice tone="ok" data-testid="bundle-note">
          {note}
        </Notice>
      )}
      {actions.error && <Notice tone="bad">{actions.error}</Notice>}
    </Card>
  );
}
