import type { AppConfig } from "./config.js";

/** The gateway's own state that concerns a judge: whether its relayer can still pay for the demo. */
export interface GatewayHealth {
  readonly ok: boolean;
  readonly relayer: { address: string; balanceMon: number; low: boolean } | null;
  /** How the gateway is wired, for the settings sheet: payment scheme, settlement, blob store. */
  readonly x402?: X402Health | undefined;
  readonly settlement?: string | undefined;
  readonly blobs?: string | undefined;
}

/**
 * Who verifies a payment here. `/healthz` reported this as a bare string until the gateway learned
 * to fall back between verifiers; it has been an object since, and this type is what keeps the two
 * ends honest — `settings.test.ts` pins the rendering so a shape change fails a test rather than
 * quietly vanishing from the sheet.
 */
export interface X402Health {
  /** `memory` (offline double), `local` (this gateway verifies), `monad` (Monad's facilitator). */
  readonly mode: string;
  readonly network?: string | undefined;
  /** The verifier that answered the last payment, when one has been served. */
  readonly lastVerifiedBy?: string | undefined;
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
      x402?: { mode?: unknown; network?: unknown; lastVerifiedBy?: unknown } | string;
      settlement?: string;
      blobs?: string;
    };
    const r = body.relayer;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    // Older gateways answered with a bare mode string; read both rather than dropping one.
    const x402 =
      typeof body.x402 === "string"
        ? { mode: body.x402 }
        : body.x402 && typeof body.x402.mode === "string"
          ? {
              mode: body.x402.mode,
              ...(str(body.x402.network) ? { network: str(body.x402.network) } : {}),
              ...(str(body.x402.lastVerifiedBy)
                ? { lastVerifiedBy: str(body.x402.lastVerifiedBy) }
                : {}),
            }
          : undefined;
    return {
      ok: body.ok === true,
      relayer:
        r && typeof r.address === "string" && typeof r.balanceMon === "number"
          ? { address: r.address, balanceMon: r.balanceMon, low: r.low === true }
          : null,
      ...(x402 ? { x402 } : {}),
      settlement: str(body.settlement),
      blobs: str(body.blobs),
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
