import type { AppConfig } from "./config.js";

/** The gateway's own state that concerns a judge: whether its relayer can still pay for the demo. */
export interface GatewayHealth {
  readonly ok: boolean;
  readonly relayer: { address: string; balanceMon: number; low: boolean } | null;
}

const HEALTH_TIMEOUT_MS = 6_000;

export async function fetchHealth(config: AppConfig): Promise<GatewayHealth | null> {
  if (!config.gatewayUrl) return null;
  try {
    const res = await fetch(`${config.gatewayUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, relayer: null };
    const body = (await res.json()) as {
      ok?: boolean;
      relayer?: { address?: string; balanceMon?: number; low?: boolean } | null;
    };
    const r = body.relayer;
    return {
      ok: body.ok === true,
      relayer:
        r && typeof r.address === "string" && typeof r.balanceMon === "number"
          ? { address: r.address, balanceMon: r.balanceMon, low: r.low === true }
          : null,
    };
  } catch {
    return null;
  }
}

/** How the strip words the float: nothing while healthy, the number once it is low. */
export function describeFloat(h: GatewayHealth | null): string | null {
  if (!h?.relayer) return null;
  if (h.relayer.balanceMon <= 0.001)
    return `relayer out of gas (${h.relayer.balanceMon.toFixed(3)} MON)`;
  if (h.relayer.low) return `relayer low (${h.relayer.balanceMon.toFixed(2)} MON)`;
  return null;
}

/** Time to the next epoch boundary, or null when more than `withinSeconds` away. */
export function rolloverIn(
  epochs: { genesis: bigint; length: bigint },
  nowSeconds: bigint,
  withinSeconds = 6n * 3600n,
): bigint | null {
  if (epochs.length <= 0n || nowSeconds < epochs.genesis) return null;
  const into = (nowSeconds - epochs.genesis) % epochs.length;
  const left = epochs.length - into;
  return left <= withinSeconds ? left : null;
}

export function describeRollover(left: bigint): string {
  const hours = Number(left / 3600n);
  const minutes = Number((left % 3600n) / 60n);
  return hours >= 1
    ? `epoch rolls over in ${hours} h ${minutes} min`
    : `epoch rolls over in ${minutes} min`;
}
