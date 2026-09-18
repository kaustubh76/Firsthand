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
