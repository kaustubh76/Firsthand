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
  readonly receiptLedger: Address;
  /** The chain's own copy of the verification predicate; zero when discovery does not name it. */
  readonly firsthandLens: Address;
  readonly epochs: { genesis: bigint; length: bigint };
  readonly anchorsLayout: "baseline" | "paged";
  readonly relayEnabled: boolean;
  /** The payment asset buyers sign for (x402); on testnet the MockUSDC faucet double. */
  readonly usdc: Address | null;
  /** True when the gateway relays MockUSDC.mint — a demo buyer can fund itself. */
  readonly faucet: boolean;
  /** Largest ciphertext the gateway accepts; captures are sized under it (null: unknown). */
  readonly maxUploadBytes: number | null;
  /** What the relay will carry (`<address>` or `<address>:<selector>`), as discovery lists it. */
  readonly relayAllow: readonly string[];
  /** True when the gateway names ERC-8004 registries: buyers can be identified agents. */
  readonly erc8004: boolean;
  /** True when the app can actually reach a chain; false means memory doubles (offline dev). */
  readonly live: boolean;
  /** Why `live` is false, in words a judge can act on. `null` when live. */
  readonly reason: string | null;
}

/** A dead gateway must degrade to offline mode within seconds, not leave "Loading…" on screen. */
const DISCOVERY_TIMEOUT_MS = 8_000;

interface Discovery {
  chainId?: string;
  rpcUrl?: string | null;
  anchorsLayout?: "baseline" | "paged" | null;
  relay?: { enabled?: boolean; allow?: string[] };
  x402?: { asset?: string };
  limits?: { maxUploadBytes?: number };
  contracts?: Record<string, string> | null;
  epochs?: { genesis: string; length: string } | null;
  erc8004?: { identityRegistry?: string; reputationRegistry?: string } | null;
}

const ZERO = `0x${"00".repeat(20)}` as Address;
const env = (k: string): string | undefined => import.meta.env[k] as string | undefined;
const GATEWAY_KEY = "firsthand.gateway";

/**
 * The gateway to talk to: `?gateway=https://…` in the URL wins and is remembered for the next
 * visit (so one hosted build can be pointed at a local or a staging gateway), else the build-time
 * `VITE_GATEWAY_URL`. `?gateway=` (empty) forgets the override.
 */
export function resolveGatewayUrl(
  search: string = typeof location === "undefined" ? "" : location.search,
): string | null {
  const fromQuery = new URLSearchParams(search).get("gateway");
  try {
    if (fromQuery !== null) {
      if (fromQuery === "") localStorage.removeItem(GATEWAY_KEY);
      else localStorage.setItem(GATEWAY_KEY, fromQuery);
    }
    const stored = localStorage.getItem(GATEWAY_KEY);
    if (stored) return stored;
  } catch {
    // Storage may be unavailable (private mode); the query override still applies for this load.
    if (fromQuery) return fromQuery;
  }
  return env("VITE_GATEWAY_URL") ?? null;
}

function fallback(): AppConfig {
  return {
    gatewayUrl: resolveGatewayUrl(),
    rpcUrl: env("VITE_RPC_URL") ?? null,
    chainId: BigInt(env("VITE_CHAIN_ID") ?? "10143"),
    passportAnchors: (env("VITE_PASSPORT_ANCHORS") ?? ZERO) as Address,
    grantManager: (env("VITE_GRANT_MANAGER") ?? ZERO) as Address,
    rescissions: (env("VITE_RESCISSIONS") ?? ZERO) as Address,
    principalRegistry: (env("VITE_PRINCIPAL_REGISTRY") ?? ZERO) as Address,
    receiptLedger: ZERO,
    firsthandLens: ZERO,
    epochs: {
      genesis: BigInt(env("VITE_EPOCH_GENESIS") ?? "0"),
      length: BigInt(env("VITE_EPOCH_LENGTH") ?? "604800"),
    },
    anchorsLayout: "baseline",
    relayEnabled: false,
    usdc: null,
    faucet: false,
    maxUploadBytes: null,
    relayAllow: [],
    erc8004: false,
    live: false,
    reason: "no gateway configured — set VITE_GATEWAY_URL or open with ?gateway=https://…",
  };
}

export interface LoadConfigOptions {
  /** Discovery attempts before giving up (default 3): a serverless gateway can take a cold start. */
  readonly attempts?: number;
  readonly onAttempt?: (attempt: number, of: number) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Never throws: a gateway that is down or misconfigured degrades to offline mode, not a blank
 * screen. A gateway that is merely slow to wake — a hosted function's cold start — gets up to
 * `attempts` tries before the app calls it offline, and says which attempt it is on.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: AppConfig | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.onAttempt?.(attempt, attempts);
    last = await discoverOnce(options.fetch ?? fetch.bind(globalThis));
    if (last.live || !last.reason || !RETRYABLE.test(last.reason)) return last;
    if (attempt < attempts) await sleep(1_000 * attempt);
  }
  return last as AppConfig;
}

/** Reasons worth another try: the gateway not answering, or answering with a server-side status. */
const RETRYABLE = /did not answer|is unreachable|answered 5\d\d/;

async function discoverOnce(doFetch: typeof fetch): Promise<AppConfig> {
  const base = fallback();
  const gatewayUrl = base.gatewayUrl;
  if (!gatewayUrl) return base;
  const host = gatewayUrl.replace(/\/+$/, "");
  try {
    const res = await doFetch(`${host}/.well-known/firsthand.json`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return { ...base, reason: `gateway ${host} answered ${res.status} to discovery` };
    const d = (await res.json()) as Discovery;
    const c = d.contracts;
    if (!c || !d.epochs) {
      return { ...base, gatewayUrl, reason: `gateway ${host} runs in memory mode (no deployment)` };
    }
    const relay = d.relay?.enabled === true;
    const rpcUrl = d.rpcUrl ?? base.rpcUrl;
    const usdc = (d.x402?.asset?.toLowerCase() ?? null) as Address | null;
    // Selector-scoped allow entries read `<address>:<selector>`; mint(address,uint256) is 0x40c10f19.
    const faucet = usdc !== null && (d.relay?.allow ?? []).some((a) => a === `${usdc}:0x40c10f19`);
    return {
      gatewayUrl,
      rpcUrl: d.rpcUrl ?? base.rpcUrl,
      chainId: BigInt(d.chainId ?? String(base.chainId)),
      passportAnchors: c["PassportAnchors"] as Address,
      grantManager: c["GrantManager"] as Address,
      rescissions: c["Rescissions"] as Address,
      principalRegistry: c["PrincipalRegistry"] as Address,
      receiptLedger: (c["ReceiptLedger"] ?? ZERO) as Address,
      firsthandLens: (c["FirsthandLens"] ?? ZERO) as Address,
      epochs: { genesis: BigInt(d.epochs.genesis), length: BigInt(d.epochs.length) },
      anchorsLayout: d.anchorsLayout ?? "baseline",
      relayEnabled: relay,
      usdc,
      faucet,
      maxUploadBytes: typeof d.limits?.maxUploadBytes === "number" ? d.limits.maxUploadBytes : null,
      relayAllow: d.relay?.allow ?? [],
      erc8004: Boolean(d.erc8004?.identityRegistry),
      // Anchoring needs both a relay to write through and an RPC to read receipts from.
      live: relay && Boolean(rpcUrl),
      reason: relay
        ? rpcUrl
          ? null
          : `gateway ${host} publishes no rpcUrl`
        : `gateway ${host} has RELAY_ENABLED=false — nothing can reach the chain`,
    };
  } catch (error) {
    const why =
      (error as Error).name === "TimeoutError" ? "did not answer in 8 s" : "is unreachable";
    return { ...base, reason: `gateway ${host} ${why}` };
  }
}
