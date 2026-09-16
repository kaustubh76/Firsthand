import type { Address } from "@firsthand/core";

/**
 * Where the app gets its addresses. A browser cannot read `deployments/<chainId>.json`, so the
 * gateway's discovery document is the substitute — one fetch and the app knows every contract, the
 * epoch parameters and whether it may relay transactions. `VITE_*` remains the offline fallback.
 */
export interface AppConfig {
  readonly gatewayUrl: string | null;
  readonly rpcUrl: string | null;
  readonly chainId: bigint;
  readonly passportAnchors: Address;
  readonly grantManager: Address;
  readonly rescissions: Address;
  readonly principalRegistry: Address;
  readonly epochs: { genesis: bigint; length: bigint };
  readonly anchorsLayout: "baseline" | "paged";
  readonly relayEnabled: boolean;
  /** True when the app can actually reach a chain; false means memory doubles (offline dev). */
  readonly live: boolean;
}

interface Discovery {
  chainId?: string;
  rpcUrl?: string | null;
  anchorsLayout?: "baseline" | "paged" | null;
  relay?: { enabled?: boolean };
  contracts?: Record<string, string> | null;
  epochs?: { genesis: string; length: string } | null;
}

const ZERO = `0x${"00".repeat(20)}` as Address;
const env = (k: string): string | undefined => import.meta.env[k] as string | undefined;

function fallback(): AppConfig {
  return {
    gatewayUrl: env("VITE_GATEWAY_URL") ?? null,
    rpcUrl: env("VITE_RPC_URL") ?? null,
    chainId: BigInt(env("VITE_CHAIN_ID") ?? "10143"),
    passportAnchors: (env("VITE_PASSPORT_ANCHORS") ?? ZERO) as Address,
    grantManager: (env("VITE_GRANT_MANAGER") ?? ZERO) as Address,
    rescissions: (env("VITE_RESCISSIONS") ?? ZERO) as Address,
    principalRegistry: (env("VITE_PRINCIPAL_REGISTRY") ?? ZERO) as Address,
    epochs: {
      genesis: BigInt(env("VITE_EPOCH_GENESIS") ?? "0"),
      length: BigInt(env("VITE_EPOCH_LENGTH") ?? "604800"),
    },
    anchorsLayout: "baseline",
    relayEnabled: false,
    live: false,
  };
}

/** Never throws: a gateway that is down or misconfigured degrades to offline mode, not a blank screen. */
export async function loadConfig(): Promise<AppConfig> {
  const base = fallback();
  const gatewayUrl = base.gatewayUrl;
  if (!gatewayUrl) return base;
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/.well-known/firsthand.json`);
    if (!res.ok) return base;
    const d = (await res.json()) as Discovery;
    const c = d.contracts;
    if (!c || !d.epochs) return { ...base, gatewayUrl };
    return {
      gatewayUrl,
      rpcUrl: d.rpcUrl ?? base.rpcUrl,
      chainId: BigInt(d.chainId ?? String(base.chainId)),
      passportAnchors: c["PassportAnchors"] as Address,
      grantManager: c["GrantManager"] as Address,
      rescissions: c["Rescissions"] as Address,
      principalRegistry: c["PrincipalRegistry"] as Address,
      epochs: { genesis: BigInt(d.epochs.genesis), length: BigInt(d.epochs.length) },
      anchorsLayout: d.anchorsLayout ?? "baseline",
      relayEnabled: d.relay?.enabled === true,
      // Anchoring needs both a relay to write through and an RPC to read receipts from.
      live: d.relay?.enabled === true && Boolean(d.rpcUrl ?? base.rpcUrl),
    };
  } catch {
    return base;
  }
}
