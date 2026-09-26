import type { ConsentEvent } from "@firsthand/adapters/client";
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

/**
 * Effective status per grant from the chain; a failed read is "unknown", never an exception.
 *
 * The reader is a function rather than an object so the caller can choose which contract answers:
 * `FirsthandLens.grantStatus` — the read-only view the Lens exists to offer a dashboard — where
 * discovery names the Lens, and `GrantManager.effectiveStatus` where it does not. Both compute the
 * same lazy precedence (RESCINDED > EXPIRED > FROZEN > ACTIVE); the Lens is simply the address
 * published for being asked.
 */
export async function fetchGrantStatuses(
  statusOf: (grantId: Bytes32) => Promise<GrantStatus>,
  ids: readonly Bytes32[],
): Promise<Map<Bytes32, GrantChainStatus>> {
  const out = new Map<Bytes32, GrantChainStatus>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        out.set(id, grantStatusLabel(await statusOf(id)));
      } catch {
        out.set(id, "unknown");
      }
    }),
  );
  return out;
}
