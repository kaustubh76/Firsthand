import { AttestationClass } from "@firsthand/core";
import type { LandingPhase } from "../lib/deposits.js";
import { relativeTime } from "../lib/format.js";
import type { DepositEntry } from "../lib/journal.js";
import { className } from "../lib/sidecars.js";
import { Hash, Icon, type IconName, Pill, Tx } from "../ui/index.js";

/** Which tab produced a deposit — an icon and a noun, and nothing about its attestation. */
const KIND: Record<DepositEntry["kind"], { icon: IconName; label: string; legacyClass: number }> = {
  text: { icon: "file", label: "note", legacyClass: AttestationClass.DEVICE_CAPTURE },
  media: { icon: "image", label: "photo / clip", legacyClass: AttestationClass.DEVICE_CAPTURE },
  import: { icon: "inbox", label: "conversation", legacyClass: AttestationClass.IMPORT },
};

export type Seal = LandingPhase | "anchoring" | "publishing";

/** Where a journal entry stands, when no landing is in progress. */
export const sealOf = (d: DepositEntry): Seal =>
  d.published ? "published" : d.anchorTx ? "anchored" : "local";

/**
 * The Data Passport as an object: what was stamped, under which class, and its seal — sealing,
 * anchored, published — with the ids a buyer would ask for. The passport id is the first <code>
 * in the card (the browser tier reads it from there), and "published" appears exactly once.
 */
export function PassportCard({
  entry,
  seal,
  chainId,
  gatewayUrl,
  now,
}: {
  entry: DepositEntry;
  seal: Seal;
  chainId: bigint;
  gatewayUrl: string | null;
  now?: number | undefined;
}) {
  const kind = KIND[entry.kind];
  // `entry.class` is what this deposit was actually minted under. Entries written before the
  // field existed fall back to the map above — not a guess: that is precisely what this app
  // minted for each tab at the time.
  const klass = entry.class ?? kind.legacyClass;
  const hardware = klass === AttestationClass.HARDWARE;
  const sealPill =
    seal === "published" && gatewayUrl ? (
      <a
        className="pill"
        data-tone="ok"
        href={`${gatewayUrl}/v1/passports/${entry.passportId}`}
        target="_blank"
        rel="noreferrer"
      >
        published ↗
      </a>
    ) : seal === "published" ? (
      <Pill tone="ok">published</Pill>
    ) : seal === "anchored" ? (
      <Pill tone="ok" dot>
        anchored
      </Pill>
    ) : seal === "publishing" ? (
      <Pill tone="pending" dot>
        publishing…
      </Pill>
    ) : seal === "minted" || seal === "anchoring" ? (
      <Pill tone="pending" dot>
        anchoring…
      </Pill>
    ) : (
      <Pill tone="neutral">sealed locally · not anchored</Pill>
    );
  return (
    <li className="passport" data-seal={seal}>
      <div className="passport-head">
        <span className="passport-title">
          <Icon name={kind.icon} />
          <span>{entry.label}</span>
          <Pill tone={hardware ? "ok" : "accent"}>{className(klass)}</Pill>
        </span>
        <span className="passport-seal">{sealPill}</span>
      </div>
      <div className="passport-meta">
        <span>
          passport <Hash value={entry.passportId} copy />
        </span>
        <span>
          blob <Hash value={entry.blobId} n={6} />
        </span>
        <span>ns {entry.ns}</span>
        <span>{kind.label}</span>
        {entry.deviceClass && (
          <span>
            device <Hash value={entry.deviceClass} n={6} />
          </span>
        )}
        <span>{relativeTime(entry.at, now)}</span>
        {entry.anchorTx && <Tx hash={entry.anchorTx} chainId={chainId} label="anchored" />}
      </div>
    </li>
  );
}
