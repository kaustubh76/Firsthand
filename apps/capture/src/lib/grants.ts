import type { ConsentEvent, OnchainGrantReader } from "@firsthand/adapters/client";
import { type Bytes32, GrantStatus } from "@firsthand/core";
import type { GrantEntry } from "./journal.js";

/** A grant's state in the words the Locker uses; "withdrawn" is the one the browser tier reads. */
export type GrantChainStatus = "live" | "withdrawn" | "expired" | "frozen" | "unknown";

export function grantStatusLabel(status: GrantStatus): GrantChainStatus {
  switch (status) {
    case GrantStatus.ACTIVE:
      return "live";
    case GrantStatus.RESCINDED:
      return "withdrawn";
    case GrantStatus.EXPIRED:
      return "expired";
    case GrantStatus.FROZEN:
      return "frozen";
    default:
      return "unknown";
  }
}

/**
 * What to show for a grant: the browser's own record and the gateway's events answer at once
 * (a withdrawal this tab sent is "withdrawn" the moment it lands); a contract read refines the
 * rest — expiry and freezes leave no event this tab would have seen.
 */
export function grantView(
  g: GrantEntry,
  events: readonly ConsentEvent[],
  chain: GrantChainStatus | null,
): { status: GrantChainStatus; tone: "ok" | "bad" | "warn" } {
  const rescinded =
    g.rescindTx !== undefined ||
    events.some((e) => e.kind === "rescinded" && e.grantId === g.grantId);
  const status: GrantChainStatus = rescinded
    ? "withdrawn"
    : chain && chain !== "unknown"
      ? chain
      : "live";
  const tone = status === "live" ? "ok" : status === "withdrawn" ? "bad" : "warn";
  return { status, tone };
}

/** Effective status per grant from the chain; a failed read is "unknown", never an exception. */
export async function fetchGrantStatuses(
  reader: Pick<OnchainGrantReader, "effectiveStatus">,
  ids: readonly Bytes32[],
): Promise<Map<Bytes32, GrantChainStatus>> {
  const out = new Map<Bytes32, GrantChainStatus>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        out.set(id, grantStatusLabel(await reader.effectiveStatus(id)));
      } catch {
        out.set(id, "unknown");
      }
    }),
  );
  return out;
}
