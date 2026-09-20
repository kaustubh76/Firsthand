import type { Bytes32 } from "@firsthand/core";
import { exportLocker, importLocker, serialiseBundle } from "@firsthand/sdk/browser";
import { useState } from "react";
import type { AppConfig } from "../lib/config.js";
import { downloadJson } from "../lib/download.js";
import { explainFailure } from "../lib/failures.js";

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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setError(explainFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const download = () =>
    run("Reading…", async () => {
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      const bundle = await exportLocker({
        gatewayUrl: config.gatewayUrl,
        principalId,
        chainId: config.chainId,
        grantIds,
        onProgress: (done, total) => setBusy(`Reading ${done}/${total}…`),
      });
      const name = `firsthand-locker-${principalId.slice(2, 10)}.json`;
      downloadJson(name, serialiseBundle(bundle));
      return `${name}: ${bundle.passports.length} passport${
        bundle.passports.length === 1 ? "" : "s"
      } (ciphertext + sidecars) · ${bundle.wraps.length} grant wrap${
        bundle.wraps.length === 1 ? "" : "s"
      } — no plaintext, no key`;
    });

  const republish = () =>
    run("Publishing…", async () => {
      if (!config.gatewayUrl) throw new Error("no gateway configured");
      if (!file) throw new Error("choose a locker bundle first");
      const report = await importLocker({
        gatewayUrl: config.gatewayUrl,
        bundle: await file.text(),
        onProgress: (done, total) => setBusy(`Publishing ${done}/${total}…`),
      });
      const skipped =
        report.skipped.length === 0
          ? ""
          : ` · ${report.skipped.length} refused by this gateway (${report.skipped[0]?.reason})`;
      return `re-published here: ${report.passports} passport${
        report.passports === 1 ? "" : "s"
      }, ${report.blobs} blobs, ${report.wraps} wrap${report.wraps === 1 ? "" : "s"}${skipped}`;
    });

  return (
    <>
      <h2>Take your locker with you</h2>
      <p className="hint">
        Everything this gateway holds for you is public and content-addressed: ciphertext, sidecars
        and grant wraps. Download it as one file — your keys are your passkey — and re-publish it on
        any conformant gateway (open this app with <code>?gateway=…</code>); it verifies each object
        against the chain before hosting it. The chain is the source of truth; a gateway is a cache
        you can leave.
      </p>
      <p>
        <button
          type="button"
          onClick={download}
          disabled={busy !== null || !config.live}
          data-testid="bundle-download"
        >
          {busy?.startsWith("Reading") ? busy : "Download bundle"}
        </button>
      </p>
      <p>
        <input
          type="file"
          accept=".json,application/json"
          data-testid="bundle-input"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />{" "}
        <button
          type="button"
          onClick={republish}
          disabled={busy !== null || !config.live || !file}
          data-testid="bundle-republish"
        >
          {busy?.startsWith("Publishing") ? busy : "Re-publish here"}
        </button>
      </p>
      {note && (
        <p className="hint" data-testid="bundle-note">
          {note}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
