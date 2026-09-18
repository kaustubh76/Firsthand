import { AttestationClass, tag, ZERO_HASH } from "@firsthand/core";
import { parseExport } from "@firsthand/importers";
import {
  type DepositResult,
  Locker,
  type LockerSession,
  mintPassport,
} from "@firsthand/sdk/browser";
import { useState } from "react";
import { Hex, Tx } from "../components/Tx.js";
import type { AppConfig } from "../lib/config.js";
import { type Landed, land } from "../lib/deposits.js";
import { MAX_MEDIA_BYTES, metaHashOf, readMedia } from "../lib/media.js";
import { NS, termsFor } from "../lib/terms.js";

type Mode = "text" | "media" | "import";

const deviceClass = () => tag(navigator.userAgent.includes("Mobile") ? "mobile" : "desktop");
const now = () => BigInt(Math.floor(Date.now() / 1000));

/**
 * The deposit verb, three ways in: a note, a photo or clip from the camera, a ChatGPT/Claude export.
 * Every path mints a passkey-signed passport, seals the bytes client-side, anchors the batch on chain
 * through the relay and publishes ciphertext + sidecar to the gateway. Below them, the refusal: a
 * datum signed by someone else's key is turned away at the door — that is what makes a locker worth
 * something to a buyer.
 */
export function Capture({ session, config }: { session: LockerSession; config: AppConfig }) {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [exportFile, setExportFile] = useState<File | null>(null);
  const [source, setSource] = useState<"chatgpt" | "claude">("chatgpt");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landed, setLanded] = useState<Landed[]>([]);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

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

  const depositText = () =>
    run("Sealing + anchoring", async () => {
      const ns = NS.captures;
      const result = await session.deposit({
        ns,
        datum: { kind: "bytes", bytes: new TextEncoder().encode(text) },
        terms: termsFor(session, ns),
        attestation: {
          class: AttestationClass.DEVICE_CAPTURE,
          capturedAt: now(),
          sourceTag: tag("capture-pwa-v0"),
          deviceClass: deviceClass(),
          metaHash: ZERO_HASH,
        },
      });
      const label = text.length > 48 ? `${text.slice(0, 48)}…` : text;
      setText("");
      setLanded(await land(session, config, [{ result, label, kind: "text" }], ns));
    });

  const depositMedia = () =>
    run("Sealing + anchoring", async () => {
      if (!file) return;
      const ns = NS.captures;
      const { bytes, meta } = await readMedia(file);
      // The bytes are the datum; mime, size and name are committed through metaHash so a buyer can
      // check what kind of capture this was without the gateway ever learning it.
      const result = await session.deposit({
        ns,
        datum: { kind: "bytes", bytes },
        terms: termsFor(session, ns),
        attestation: {
          class: AttestationClass.DEVICE_CAPTURE,
          capturedAt: now(),
          sourceTag: tag("capture-pwa-v0"),
          deviceClass: deviceClass(),
          metaHash: metaHashOf(meta),
        },
      });
      setFile(null);
      setLanded(
        await land(
          session,
          config,
          [{ result, label: `${meta.name} · ${meta.mime} · ${meta.size} B`, kind: "media" }],
          ns,
        ),
      );
    });

  const depositImport = () =>
    run("Minting one passport per conversation", async () => {
      if (!exportFile) return;
      const ns = NS.imports;
      const contents = await exportFile.text();
      const terms = termsFor(session, ns);
      const results: { result: DepositResult; label: string; kind: "import" }[] = [];
      const refused: string[] = [];
      let seen = 0;
      const LIMIT = 25;
      for (const item of parseExport(source, contents)) {
        if (seen++ >= LIMIT) break;
        try {
          const result = await session.deposit({
            ns,
            datum: item.datum,
            terms,
            attestation: item.attestation,
          });
          results.push({
            result,
            label: item.conversation.title || item.conversation.id,
            kind: "import",
          });
        } catch (e) {
          // One unprovable or duplicate conversation must not abandon the rest.
          refused.push(
            `${item.conversation.title || item.conversation.id}: ${(e as Error).message}`,
          );
        }
      }
      setExportFile(null);
      setImportNote(
        `${results.length} conversation${results.length === 1 ? "" : "s"} minted${seen > LIMIT ? ` (first ${LIMIT})` : ""}${refused.length ? ` · ${refused.length} refused: ${refused.join("; ")}` : ""}`,
      );
      if (results.length > 0) setLanded(await land(session, config, results, ns));
    });

  const tryLaundering = () =>
    run("Forging", async () => {
      setRefusal(null);
      // Someone else's locker: a throwaway PRF, a real signature — over an origin key this locker
      // never enrolled. The passport is well-formed; only its provenance is wrong.
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const other = await Locker.open(
        { kind: "scraper", evaluate: async () => new Uint8Array(seed) },
        {
          domain: session.locker.domain,
          epochs: session.locker.epochs,
          anchors: session.locker.anchors,
          blobs: session.locker.blobs,
          namespaces: [{ ns: NS.captures, label: "captures" }],
        },
      );
      const plaintext = new TextEncoder().encode("a datum scraped from somewhere else");
      const forged = mintPassport(other, {
        ns: NS.captures,
        datum: { kind: "bytes", bytes: plaintext },
        terms: termsFor(session, NS.captures),
        attestation: {
          class: AttestationClass.DEVICE_CAPTURE,
          capturedAt: now(),
          sourceTag: tag("scraper"),
          deviceClass: ZERO_HASH,
          metaHash: ZERO_HASH,
        },
      });
      other.dispose();
      try {
        await session.acceptSigned(forged, NS.captures, plaintext);
        setRefusal("accepted — this should never happen");
      } catch (e) {
        const err = e as Error & { code?: string };
        setRefusal(`${err.code ?? "refused"}: ${err.message}`);
      }
    });

  return (
    <section>
      <h1>Capture</h1>
      <p className="lede">
        Stamp what you make with a passport of origin, price and consent. Sealed here, anchored on
        Monad through the relay, served by the gateway only while your consent is live.
      </p>
      <div className="segmented" role="tablist">
        {(["text", "media", "import"] as const).map((m) => (
          <button
            type="button"
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "text" ? "Note" : m === "media" ? "Photo / clip" : "Import export"}
          </button>
        ))}
      </div>

      {mode === "text" && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What did you observe?"
            rows={4}
          />
          <button
            type="button"
            onClick={depositText}
            disabled={text.trim() === "" || busy !== null}
          >
            {busy ?? "Stamp passport"}
          </button>
        </>
      )}

      {mode === "media" && (
        <>
          <input
            type="file"
            accept="image/*,video/*"
            capture="environment"
            data-testid="media-input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <p className="hint">
              {file.name} · {file.type || "unknown type"} · {(file.size / 1024).toFixed(0)} KiB
              {file.type.startsWith("image/") && (
                <img className="preview" alt="" src={URL.createObjectURL(file)} />
              )}
            </p>
          )}
          <button type="button" onClick={depositMedia} disabled={!file || busy !== null}>
            {busy ?? "Stamp passport"}
          </button>
          <p className="hint">
            Captures up to {MAX_MEDIA_BYTES / 1_048_576} MiB. The bytes are sealed client-side;
            mime, size and name are committed in the attestation, never sent in clear.
          </p>
        </>
      )}

      {mode === "import" && (
        <>
          <div className="segmented" role="tablist">
            {(["chatgpt", "claude"] as const).map((s) => (
              <button
                type="button"
                key={s}
                role="tab"
                aria-selected={source === s}
                onClick={() => setSource(s)}
              >
                {s === "chatgpt" ? "ChatGPT conversations.json" : "Claude export"}
              </button>
            ))}
          </div>
          <input
            type="file"
            accept=".json,.jsonl,application/json"
            data-testid="import-input"
            onChange={(e) => setExportFile(e.target.files?.[0] ?? null)}
          />
          <button type="button" onClick={depositImport} disabled={!exportFile || busy !== null}>
            {busy ?? "Mint one passport per conversation"}
          </button>
          {importNote && <p className="hint">{importNote}</p>}
          <p className="hint">
            The first 25 conversations of the export, each its own passport under the{" "}
            <code>imports</code> namespace with an <code>IMPORT</code> attestation.
          </p>
        </>
      )}

      {!config.live && (
        <p className="error">
          Offline: passports are minted and sealed locally but never anchored, so no buyer can fetch
          them ({config.reason}). Open the app with <code>?gateway=https://…</code> to use another
          gateway.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {landed.length > 0 && (
        <ul className="landed" data-testid="landed">
          {landed.map(({ entry }) => (
            <li key={entry.passportId}>
              <strong>{entry.label}</strong>
              <br />
              passport <Hex value={entry.passportId} /> · blob <Hex value={entry.blobId} n={6} />
              {entry.anchorTx && (
                <>
                  {" "}
                  · <Tx hash={entry.anchorTx} chainId={config.chainId} label="anchored" />
                </>
              )}
              {entry.published && config.gatewayUrl && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={`${config.gatewayUrl}/v1/passports/${entry.passportId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    published ↗
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="refusal">
        <summary>The refusal — try to launder a scraped datum</summary>
        <p className="hint">
          Forges a well-formed passport signed by another locker's key and asks this locker to
          accept it. Origin proof is checked before anything is sealed.
        </p>
        <button type="button" onClick={tryLaundering} disabled={busy !== null}>
          {busy === "Forging" ? "Forging…" : "Inject a scraped datum"}
        </button>
        {refusal && (
          <p className="error" data-testid="refusal">
            {refusal}
          </p>
        )}
      </details>
    </section>
  );
}
