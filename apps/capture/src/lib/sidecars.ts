import type { Bytes32, PassportSidecar } from "@firsthand/core";
import { parseSidecar } from "@firsthand/core";
import { readFetch } from "./fetch.js";

/** A published passport, as the gateway serves it to anyone; `null` when it does not host it. */
export async function fetchSidecar(
  gatewayUrl: string,
  passportId: Bytes32,
): Promise<PassportSidecar | null> {
  const res = await readFetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/passports/${passportId}`);
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
  /** Attestation class (0 unattested · 1 import · 2 device_capture · 3 hardware); null on older sidecars. */
  readonly class: number | null;
  readonly capturedAt: string | null;
  readonly sourceTag: Bytes32 | null;
}

/** README §7.3's staleness signal for a namespace, as the gateway publishes it. */
export interface Freshness {
  readonly lastAnchoredAt: string | null;
  readonly halfLifeSeconds: string;
  readonly staleness: number;
}

export interface Listing {
  readonly passports: ListedPassport[];
  readonly freshness: Record<string, Freshness>;
}

export const CLASS_NAMES = ["unattested", "import", "device capture", "hardware"] as const;

export function className(klass: number | null): string {
  return klass === null ? "class unknown" : (CLASS_NAMES[klass] ?? `class ${klass}`);
}

/** What a principal has published on this gateway — the buyer's starting point from a locker link. */
export async function listPassports(
  gatewayUrl: string,
  principalId: Bytes32,
  ns?: number,
): Promise<ListedPassport[]> {
  return (await listing(gatewayUrl, principalId, ns)).passports;
}

export async function listing(
  gatewayUrl: string,
  principalId: Bytes32,
  ns?: number,
): Promise<Listing> {
  const q = new URLSearchParams();
  if (ns !== undefined) q.set("ns", String(ns));
  const res = await readFetch(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/principals/${principalId}/passports?${q.toString()}`,
  );
  if (!res.ok) throw new Error(`gateway answered ${res.status} listing ${principalId}`);
  const body = (await res.json()) as {
    passports: ListedPassport[];
    freshness?: Record<string, Freshness>;
  };
  return { passports: body.passports, freshness: body.freshness ?? {} };
}

/** "fresh" · "3 d since the last deposit · staleness 0.26" — for a listing header. */
export function describeFreshness(f: Freshness | undefined, nowSeconds: number): string | null {
  if (!f) return null;
  if (f.lastAnchoredAt === null) return "no anchored deposit dated yet";
  const ago = Math.max(0, nowSeconds - Number(f.lastAnchoredAt));
  const when =
    ago < 3_600
      ? `${Math.max(1, Math.round(ago / 60))} min`
      : ago < 86_400
        ? `${Math.round(ago / 3_600)} h`
        : `${Math.round(ago / 86_400)} d`;
  return `last deposit ${when} ago · staleness ${f.staleness.toFixed(2)}`;
}
