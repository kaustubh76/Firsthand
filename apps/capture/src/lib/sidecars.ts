import type { Bytes32, PassportSidecar } from "@firsthand/core";
import { parseSidecar } from "@firsthand/core";

/** A published passport, as the gateway serves it to anyone; `null` when it does not host it. */
export async function fetchSidecar(
  gatewayUrl: string,
  passportId: Bytes32,
): Promise<PassportSidecar | null> {
  const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/passports/${passportId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway answered ${res.status} for ${passportId}`);
  return parseSidecar(await res.json());
}

export interface ListedPassport {
  readonly passportId: Bytes32;
  readonly ns: number;
  readonly epoch: string;
  readonly batchRoot: Bytes32;
  readonly termsHash: Bytes32;
  readonly price: string;
}

/** What a principal has published on this gateway — the buyer's starting point from a locker link. */
export async function listPassports(
  gatewayUrl: string,
  principalId: Bytes32,
  ns?: number,
): Promise<ListedPassport[]> {
  const q = new URLSearchParams();
  if (ns !== undefined) q.set("ns", String(ns));
  const res = await fetch(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/principals/${principalId}/passports?${q.toString()}`,
  );
  if (!res.ok) throw new Error(`gateway answered ${res.status} listing ${principalId}`);
  return ((await res.json()) as { passports: ListedPassport[] }).passports;
}
