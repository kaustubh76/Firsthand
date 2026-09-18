import type { ConsentEvent, ReceiptView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";

/** Wire shape of the gateway's audit routes: bigints arrive as decimal strings. */
type Wire<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };

const base = (gatewayUrl: string) => gatewayUrl.replace(/\/+$/, "");
const since = (fromBlock?: bigint) => (fromBlock === undefined ? "" : `?fromBlock=${fromBlock}`);

export async function fetchTimeline(
  gatewayUrl: string,
  principalId: Bytes32,
  fromBlock?: bigint,
): Promise<ConsentEvent[]> {
  const res = await fetch(
    `${base(gatewayUrl)}/v1/principals/${principalId}/timeline${since(fromBlock)}`,
  );
  if (!res.ok) throw new Error(`timeline: gateway answered ${res.status}`);
  const body = (await res.json()) as { events: Wire<ConsentEvent>[] };
  return body.events.map((e) => ({
    ...e,
    blockNumber: BigInt(e.blockNumber),
    timestamp: BigInt(e.timestamp),
  }));
}

export async function fetchReceipts(
  gatewayUrl: string,
  grantId: Bytes32,
  fromBlock?: bigint,
): Promise<ReceiptView[]> {
  const res = await fetch(`${base(gatewayUrl)}/v1/grants/${grantId}/receipts${since(fromBlock)}`);
  if (!res.ok) throw new Error(`receipts: gateway answered ${res.status}`);
  const body = (await res.json()) as { receipts: Wire<ReceiptView>[] };
  return body.receipts.map((r) => ({
    ...r,
    epoch: BigInt(r.epoch),
    blockNumber: BigInt(r.blockNumber),
  }));
}
