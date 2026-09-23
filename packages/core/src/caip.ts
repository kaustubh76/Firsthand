import { MONAD_TESTNET_CHAIN_ID } from "./constants.js";
import { ValidationError } from "./errors.js";

/**
 * CAIP-2 chain identifiers for x402 (README §8 claim 4).
 *
 * x402 v2 replaced casual network names (`monad-testnet`) with CAIP-2 (`eip155:10143`), and Monad's
 * facilitator speaks only v2 — `GET /supported` lists `{network: "eip155:10143", scheme: "exact",
 * x402Version: 2}` (probed 2026-09-23). FIRSTHAND still has the legacy spelling in deployed
 * environments and in every 402 it has ever served, so both are accepted everywhere and the pair
 * travels together: `caip2` is what a facilitator is told, `legacy` is what older clients match on.
 *
 * Lives in core because the gateway, the SDK buyer and the browser all need it, and none of them
 * may depend on another (ADR-0001).
 */
export const MONAD_MAINNET_CHAIN_ID = 143n;

export const caip2 = (chainId: bigint): string => `eip155:${chainId}`;

export const MONAD_TESTNET_CAIP2 = caip2(MONAD_TESTNET_CHAIN_ID);
export const MONAD_MAINNET_CAIP2 = caip2(MONAD_MAINNET_CHAIN_ID);

/** The chain id of a CAIP-2 `eip155:` identifier, or null for anything else (solana:…, garbage). */
export function chainIdOfCaip2(network: string): bigint | null {
  const match = /^eip155:(\d{1,20})$/.exec(network.trim());
  return match?.[1] === undefined ? null : BigInt(match[1]);
}

/** Legacy x402 v1 network names FIRSTHAND has used, by chain id. */
const LEGACY_NAMES: ReadonlyMap<bigint, string> = new Map([
  [MONAD_TESTNET_CHAIN_ID, "monad-testnet"],
  [MONAD_MAINNET_CHAIN_ID, "monad"],
  [31337n, "anvil"],
]);
const CHAIN_IDS: ReadonlyMap<string, bigint> = new Map(
  [...LEGACY_NAMES].map(([id, name]) => [name, id] as const),
);

export interface NetworkId {
  /** x402 v2 / CAIP-2, e.g. `eip155:10143` — what a facilitator is told. */
  readonly caip2: string;
  /** x402 v1 name, e.g. `monad-testnet` — what older clients match on. */
  readonly legacy: string;
  readonly chainId: bigint;
}

/**
 * Accepts either spelling (`eip155:10143`, `monad-testnet`, `10143`) and returns both, so a
 * config value written months ago keeps working against a v2-only facilitator.
 */
export function normalizeNetwork(network: string): NetworkId {
  const raw = network.trim();
  const chainId =
    chainIdOfCaip2(raw) ??
    CHAIN_IDS.get(raw.toLowerCase()) ??
    (/^\d{1,20}$/.test(raw) ? BigInt(raw) : null);
  if (chainId === null) {
    throw new ValidationError(
      `unknown x402 network "${network}" (expected eip155:<chainId>, a chain id, or a known name)`,
      {
        context: { network },
      },
    );
  }
  return { caip2: caip2(chainId), legacy: LEGACY_NAMES.get(chainId) ?? caip2(chainId), chainId };
}

/** True when two network identifiers name the same chain, whichever spelling each uses. */
export function sameNetwork(a: string, b: string): boolean {
  try {
    return normalizeNetwork(a).chainId === normalizeNetwork(b).chainId;
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}
