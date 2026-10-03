import type { ConsentEvent } from "@firsthand/adapters/client";
import { type Bytes32, GrantStatus } from "@firsthand/core";
import type { GrantEntry } from "./journal.js";

/** A grant whose outcome is already settled cannot change, so it is never worth a chain read. */
export const isTerminal = (g: GrantEntry): boolean => g.rescindTx !== undefined;

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
  grants: readonly GrantEntry[],
): Promise<{ statuses: Map<Bytes32, GrantChainStatus>; rateLimited: boolean }> {
  const statuses = new Map<Bytes32, GrantChainStatus>();
  // A grant this browser withdrew is settled; the chain cannot contradict it, so do not ask.
  const ask = grants.filter((g) => !isTerminal(g));
  for (const g of grants) if (isTerminal(g)) statuses.set(g.grantId, "withdrawn");
  let rateLimited = false;
  // Fanned out freely: the reader underneath paces the wire, so this queues rather than bursts.
  await Promise.all(
    ask.map(async (g) => {
      try {
        statuses.set(g.grantId, grantStatusLabel(await statusOf(g.grantId)));
      } catch (error) {
        // A refused read is not a state. Reporting it as "unknown" rendered a rate limit as if the
        // chain had answered, which is the one thing a consent ledger must never do.
        if (isRateLimited(error)) rateLimited = true;
        else statuses.set(g.grantId, "unknown");
      }
    }),
  );
  return { statuses, rateLimited };
}

/**
 * Monad answers over its per-second window with a JSON-RPC error inside a 200, so this is message
 * shape, not status code. `-32007` is its code; the words are matched too because the code is not
 * always carried up through viem's error wrapping.
 */
export function isRateLimited(error: unknown): boolean {
  const text = [
    (error as { message?: unknown })?.message,
    (error as { details?: unknown })?.details,
    (error as { shortMessage?: unknown })?.shortMessage,
  ]
    .filter((m): m is string => typeof m === "string")
    .join(" | ");
  return /rate limit|too many requests|requests limited|request limit|\b429\b|-32007/i.test(text);
}

/**
 * When consent lapses on its own, per grant: a grant expires at `epochStart + term` and the chain
 * stores `epochEnd` only once it is rescinded, so the expiry has to be derived — which is why the
 * app showed a status of "expired" after the fact and never a date before it. A principal
 * approving a request should be able to see how long they are agreeing to.
 */
export async function fetchGrantExpiries(
  stateOf: (grantId: Bytes32) => Promise<{ epochStart: bigint; term: bigint } | null>,
  grants: readonly GrantEntry[],
): Promise<Map<Bytes32, bigint>> {
  const out = new Map<Bytes32, bigint>();
  // This browser chose the window when it granted, so for its own grants the answer is already
  // written down — four `eth_call`s each, saved. The chain is only asked about the rest.
  const ask: GrantEntry[] = [];
  for (const g of grants) {
    if (g.epochStart !== undefined && g.term !== undefined) {
      out.set(g.grantId, BigInt(g.epochStart) + BigInt(g.term));
    } else if (!isTerminal(g)) {
      ask.push(g);
    }
  }
  await Promise.all(
    ask.map(async (g) => {
      const state = await stateOf(g.grantId).catch(() => null);
      if (state) out.set(g.grantId, state.epochStart + state.term);
    }),
  );
  return out;
}
