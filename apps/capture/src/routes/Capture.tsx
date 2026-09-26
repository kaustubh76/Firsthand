import { AttestationClass, tag, ZERO_HASH } from "@firsthand/core";
import { parseExport } from "@firsthand/importers";
import {
  type DepositResult,
  Locker,
  type LockerSession,
  mintPassport,
} from "@firsthand/sdk/browser";
import { useEffect, useMemo, useState } from "react";
import { ActivationCard } from "../components/ActivationCard.js";
import { PassportCard, type Seal } from "../components/PassportCard.js";
import { useAsyncActions } from "../hooks/useAsyncActions.js";
import { useToasts } from "../hooks/useToasts.js";
import type { AppConfig } from "../lib/config.js";
import { type LandingPhase, type LandOptions, land } from "../lib/deposits.js";
import { reportFailure } from "../lib/failures.js";
import { formatBytes, pluralise } from "../lib/format.js";
import { type DepositEntry, updateJournal } from "../lib/journal.js";
import { canAnchor, type Liveness } from "../lib/liveness.js";
import type { CaptureClient } from "../lib/locker.js";
import { mediaCap, metaHashOf, readMedia } from "../lib/media.js";
import { describeUploadCap } from "../lib/settings.js";
import { NS, termsFor } from "../lib/terms.js";
import { useNavigation } from "../shell/navigation.js";
import { Button, Icon, Notice, Tabs } from "../ui/index.js";

type Mode = "text" | "media" | "import";
type Action = "text" | "media" | "import" | "forge";

const deviceClass = () => tag(navigator.userAgent.includes("Mobile") ? "mobile" : "desktop");
const now = () => BigInt(Math.floor(Date.now() / 1000));

const phaseToSeal = (phase: LandingPhase): Seal =>
  phase === "minted" ? "anchoring" : phase === "anchored" ? "publishing" : phase;

/**
 * The deposit verb, three ways in: a note, a photo or clip from the camera, a ChatGPT/Claude export.
 * Every path mints a passkey-signed passport, seals the bytes client-side, anchors the batch on chain
 * through the relay and publishes ciphertext + sidecar to the gateway. Below them, the refusal: a
 * datum signed by someone else's key is turned away at the door — that is what makes a locker worth
 * something to a buyer.
 */
export function Capture({
  session,
  config,
  client,
  liveness,
  onActivated,
}: {
  session: LockerSession;
  config: AppConfig;
  client: CaptureClient;
  liveness: Liveness;
  onActivated: () => void;
}) {
  const nav = useNavigation();
  const toasts = useToasts();
  const actions = useAsyncActions<Action>({ explain: reportFailure });
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [exportFile, setExportFile] = useState<File | null>(null);
  const [source, setSource] = useState<"chatgpt" | "claude">("chatgpt");
  // The latest landing only: each card moves sealing → anchored → published as land() reports.
  const [landed, setLanded] = useState<{ entry: DepositEntry; seal: Seal }[]>([]);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The rail can land on the refusal: open it when it is the target.
  const [refusalOpen, setRefusalOpen] = useState(false);
  useEffect(() => {
    if (nav.target === "capture-refusal") setRefusalOpen(true);
  }, [nav.target]);

  const preview = useMemo(
    () => (file?.type.startsWith("image/") ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const landing: LandOptions = {
    onPhase: (entry, phase) =>
      setLanded((list) => {
        const seal = phaseToSeal(phase);
        const i = list.findIndex((x) => x.entry.passportId === entry.passportId);
        if (i === -1) return [...list, { entry, seal }];
        return list.map((x, k) => (k === i ? { entry, seal } : x));
      }),
  };
  const toastLanded = (count: number, kindLabel: string) => {
    if (!config.live) return;
    toasts.push({
      tone: "success",
      title:
        count === 1 ? `${kindLabel} stamped` : `Import landed · ${pluralise(count, "passport")}`,
      detail: "sealed here, anchored on chain, published to the gateway",
      action: { label: "View", onClick: () => nav.go("locker", "locker-deposits") },
    });
  };

  const depositText = () =>
    actions.run("text", async () => {
      setLanded([]);
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
      await land(session, config, [{ result, label, kind: "text" }], ns, landing);
      toastLanded(1, "Note");
    });

  const depositMedia = () =>
    actions.run("media", async () => {
      if (!file) return;
      setLanded([]);
      const ns = NS.captures;
      const { bytes, meta } = await readMedia(file, mediaCap(config.maxUploadBytes));
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
      await land(
        session,
        config,
        [{ result, label: `${meta.name} · ${meta.mime} · ${meta.size} B`, kind: "media" }],
        ns,
        landing,
      );
      toastLanded(1, "Capture");
    });

  const depositImport = () =>
    actions.run("import", async () => {
      if (!exportFile) return;
      setLanded([]);
      setImportNote(null);
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
          refused.push(`${item.conversation.title || item.conversation.id}: ${reportFailure(e)}`);
        }
      }
      setExportFile(null);
      setImportNote(
        `${pluralise(results.length, "conversation")} minted${seen > LIMIT ? ` (first ${LIMIT})` : ""}${
          refused.length ? ` · ${refused.length} refused: ${refused.join("; ")}` : ""
        }`,
      );
      if (results.length > 0) {
        await land(session, config, results, ns, landing);
        toastLanded(results.length, "Conversation");
      }
    });

  const tryLaundering = () =>
    actions.run("forge", async () => {
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
        updateJournal(session.locker.principalId, (j) => {
          j.refusalAt = Date.now();
        });
      }
    });

  const busy = actions.busy !== null;
  // On a live chain a stamp ends in an anchor, so it needs this epoch's deposit-key root attested
  // (the card above says so). Offline there is nothing to anchor against, so sealing stays open.
  const stampBlocked = config.live && !canAnchor(liveness);
  const cap = mediaCap(config.maxUploadBytes);

  return (
    <section>
      <div className="screen-head">
        <span className="eyebrow">Deposit</span>
        <h1>Capture</h1>
        <p className="lede">
          Stamp what you make with a passport of origin, price and consent. Sealed here, anchored on
          Monad through the relay, served by the gateway only while your consent is live.
        </p>
      </div>

      {!config.live && (
        <Notice tone="warn">
          Offline: passports are minted and sealed locally but never anchored, so no buyer can fetch
          them ({config.reason}). Point the app at a gateway from Settings.
        </Notice>
      )}

      <ActivationCard
        id="capture-activation"
        session={session}
        config={config}
        client={client}
        liveness={liveness}
        onActivated={onActivated}
        what="Captures"
      />

      <Tabs
        aria-label="What to stamp"
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "text", label: "Note", icon: "file" },
          { id: "media", label: "Photo / clip", icon: "camera" },
          { id: "import", label: "Import export", icon: "inbox" },
        ]}
      />

      {mode === "text" && (
        <div className="card-body">
          <textarea
            id="capture-note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What did you observe?"
            rows={4}
            aria-label="Note"
          />
          <div className="btn-row">
            <Button
              variant="primary"
              icon="stamp"
              onClick={depositText}
              pending={actions.is("text")}
              pendingLabel="Sealing + anchoring…"
              disabled={text.trim() === "" || busy || stampBlocked}
            >
              Stamp passport
            </Button>
            <span className="hint">
              One passport per note · device-capture class ·{" "}
              {config.live ? "anchored on chain" : "sealed locally"}
            </span>
          </div>
        </div>
      )}

      {mode === "media" && (
        <div className="card-body">
          <label className="dropzone">
            <span className="dropzone-title">
              <Icon name="camera" />
              Take a photo or clip, or choose one
            </span>
            <input
              type="file"
              accept="image/*,video/*"
              capture="environment"
              data-testid="media-input"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <span className="file-meta">
                <Icon name={file.type.startsWith("video/") ? "eye" : "image"} />
                <span>{file.name}</span>
                <span>· {file.type || "unknown type"}</span>
                <span>· {formatBytes(file.size)}</span>
              </span>
            )}
            {preview && <img className="preview" alt="" src={preview} />}
            <span className="hint">
              {describeUploadCap(cap)}. The bytes are sealed client-side; mime, size and name are
              committed in the attestation, never sent in clear.
            </span>
          </label>
          <div className="btn-row">
            <Button
              variant="primary"
              icon="stamp"
              onClick={depositMedia}
              pending={actions.is("media")}
              pendingLabel="Sealing + anchoring…"
              disabled={!file || busy || stampBlocked}
            >
              Stamp passport
            </Button>
          </div>
        </div>
      )}

      {mode === "import" && (
        <div className="card-body">
          <Tabs
            aria-label="Export source"
            value={source}
            onChange={setSource}
            tabs={[
              { id: "chatgpt", label: "ChatGPT conversations.json" },
              { id: "claude", label: "Claude export" },
            ]}
          />
          <label className="dropzone">
            <span className="dropzone-title">
              <Icon name="inbox" />
              Choose the export file
            </span>
            <input
              type="file"
              accept=".json,.jsonl,application/json"
              data-testid="import-input"
              onChange={(e) => setExportFile(e.target.files?.[0] ?? null)}
            />
            {exportFile && (
              <span className="file-meta">
                <Icon name="file" />
                <span>{exportFile.name}</span>
                <span>· {formatBytes(exportFile.size)}</span>
              </span>
            )}
            <span className="hint">
              The first 25 conversations of the export, each its own passport under the{" "}
              <code>imports</code> namespace with an <code>IMPORT</code> attestation.
            </span>
          </label>
          <div className="btn-row">
            <Button
              variant="primary"
              icon="stamp"
              onClick={depositImport}
              pending={actions.is("import")}
              pendingLabel="Minting one passport per conversation…"
              disabled={!exportFile || busy || stampBlocked}
            >
              Mint one passport per conversation
            </Button>
          </div>
          {importNote && <Notice tone="info">{importNote}</Notice>}
        </div>
      )}

      {actions.error && actions.busy !== "forge" && <Notice tone="bad">{actions.error}</Notice>}

      {landed.length > 0 && (
        <ul className="cards" data-testid="landed">
          {landed.map(({ entry, seal }) => (
            <PassportCard
              key={entry.passportId}
              entry={entry}
              seal={seal}
              chainId={config.chainId}
              gatewayUrl={config.gatewayUrl}
            />
          ))}
        </ul>
      )}

      <details
        className="refusal"
        id="capture-refusal"
        open={refusalOpen}
        onToggle={(e) => setRefusalOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          <Icon name="ban" />
          The refusal — try to launder a scraped datum
        </summary>
        <div className="refusal-body">
          <p className="hint">
            Forges a well-formed passport signed by another locker's key and asks this locker to
            accept it. Origin proof is checked before anything is sealed — a locker is worth what
            you can prove about its contents.
          </p>
          <div className="btn-row">
            <Button
              variant="danger"
              icon="ban"
              onClick={tryLaundering}
              pending={actions.is("forge")}
              pendingLabel="Forging…"
              disabled={busy}
            >
              Inject a scraped datum
            </Button>
          </div>
          {refusal && (
            <Notice tone="bad" data-testid="refusal">
              {refusal}
            </Notice>
          )}
        </div>
      </details>
    </section>
  );
}
