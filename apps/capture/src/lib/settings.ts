import { formatBytes } from "./format.js";
import type { GatewayHealth } from "./health.js";

/**
 * The gateway switcher rides the mechanism that already exists: `?gateway=<url>` is remembered
 * by resolveGatewayUrl on the next load and `?gateway=` (empty) forgets it. This builds that URL
 * from the current one, keeping any other query and dropping the hash (the route restarts).
 */
export function gatewayHref(currentHref: string, gateway: string | null): string {
  const url = new URL(currentHref);
  url.hash = "";
  url.searchParams.set("gateway", gateway ? gateway.trim().replace(/\/+$/, "") : "");
  return url.toString();
}

/** A URL a person typed: https (or http on localhost) with a host, nothing else. */
export function validGatewayUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (!u.host) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function describeUploadCap(maxUploadBytes: number | null): string {
  return maxUploadBytes === null
    ? "upload limit not published"
    : `${formatBytes(maxUploadBytes)} per capture (gateway limit)`;
}

export function describeSettlement(h: GatewayHealth | null): string {
  if (!h) return "unknown";
  const parts = [
    // Who checks a payment, and — once one has been served — who actually answered.
    h.x402
      ? `x402 ${h.x402.mode}${
          h.x402.lastVerifiedBy && h.x402.lastVerifiedBy !== h.x402.mode
            ? ` (verified by ${h.x402.lastVerifiedBy})`
            : ""
        }`
      : null,
    h.settlement ? `settlement ${h.settlement}` : null,
    h.blobs ? `blobs ${h.blobs}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : "unknown";
}
