import type { ConsentEvent, ReceiptView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import { readFetch } from "./fetch.js";

/**
 * Wire shape of the gateway's audit routes: bigints arrive as decimal strings. The optional arm
 * matters — `recordedBlock` is `bigint | undefined`, which does not extend `bigint`, so without it
 * the field would type as a bigint that is in fact a string.
 */
type Wire<T> = {
  [K in keyof T]: [T[K]] extends [bigint]
    ? string
    : [T[K]] extends [bigint | undefined]
      ? string | undefined
      : T[K];
};

const base = (gatewayUrl: string) => gatewayUrl.replace(/\/+$/, "");
const since = (fromBlock?: bigint) => (fromBlock === undefined ? "" : `?fromBlock=${fromBlock}`);

/** What the gateway's scan covered — so the screen can say "older rows are from the journal". */
export interface TimelineScan {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** The scan budget ran out before `fromBlock` (newest history first). */
  readonly partial: boolean;
  /** The requested `fromBlock` was older than the gateway's scan window. */
  readonly clamped: boolean;
}

export interface Timeline {
  readonly events: ConsentEvent[];
  readonly scan: TimelineScan | null;
}

export async function fetchTimeline(
  gatewayUrl: string,
  principalId: Bytes32,
  fromBlock?: bigint,
): Promise<Timeline> {
  const res = await readFetch(
    `${base(gatewayUrl)}/v1/principals/${principalId}/timeline${since(fromBlock)}`,
  );
  if (!res.ok) throw new Error(`timeline: gateway answered ${res.status}`);
  const body = (await res.json()) as {
    events: Wire<ConsentEvent>[];
    scan?: { fromBlock: string; toBlock: string; partial: boolean; clamped: boolean };
  };
  return {
    // `recordedBlock` is lifted out of the spread: a conditional spread over it would widen the
    // field to `string | bigint | undefined` rather than narrowing it.
    events: body.events.map(({ recordedBlock, ...e }) => ({
      ...e,
      blockNumber: BigInt(e.blockNumber),
      timestamp: BigInt(e.timestamp),
      ...(recordedBlock === undefined ? {} : { recordedBlock: BigInt(recordedBlock) }),
    })),
    scan: body.scan
      ? {
          fromBlock: BigInt(body.scan.fromBlock),
          toBlock: BigInt(body.scan.toBlock),
          partial: body.scan.partial === true,
          clamped: body.scan.clamped === true,
        }
      : null,
  };
}

/** One sentence about the window, or null when the scan covered everything asked for. */
export function describeScan(scan: TimelineScan | null): string | null {
  if (!scan || (!scan.partial && !scan.clamped)) return null;
  return `chain rows from block ${scan.fromBlock} to ${scan.toBlock}${
    scan.partial ? " (the scan budget ran out)" : " (older than the gateway's scan window)"
  }; older rows come from this browser's journal`;
}

export async function fetchReceipts(
  gatewayUrl: string,
  grantId: Bytes32,
  fromBlock?: bigint,
): Promise<ReceiptView[]> {
  const res = await readFetch(
    `${base(gatewayUrl)}/v1/grants/${grantId}/receipts${since(fromBlock)}`,
  );
  if (!res.ok) throw new Error(`receipts: gateway answered ${res.status}`);
  const body = (await res.json()) as { receipts: Wire<ReceiptView>[] };
  return body.receipts.map((r) => ({
    ...r,
    epoch: BigInt(r.epoch),
    blockNumber: BigInt(r.blockNumber),
  }));
}
