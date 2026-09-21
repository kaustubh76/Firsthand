import type { LandingPhase } from "../lib/deposits.js";
import { relativeTime } from "../lib/format.js";
import type { DepositEntry } from "../lib/journal.js";
import { Hash, Icon, type IconName, Pill, Tx } from "../ui/index.js";

/** What a deposit's kind says about its attestation class, in the words the Verify tab uses. */
const KIND: Record<DepositEntry["kind"], { icon: IconName; label: string; klass: string }> = {
  text: { icon: "file", label: "note", klass: "device capture" },
  media: { icon: "image", label: "photo / clip", klass: "device capture" },
  import: { icon: "inbox", label: "conversation", klass: "import" },
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
          <Pill tone="accent">{kind.klass}</Pill>
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
        <span>{relativeTime(entry.at, now)}</span>
        {entry.anchorTx && <Tx hash={entry.anchorTx} chainId={chainId} label="anchored" />}
      </div>
    </li>
  );
}
