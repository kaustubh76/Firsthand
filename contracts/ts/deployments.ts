import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deployment addresses written by `script/Deploy.s.sol` into `deployments/<chainId>.json`.
 * Loaded lazily from disk so redeploying never requires a rebuild.
 */
export interface Deployment {
  readonly chainId: number;
  readonly PrincipalRegistry: `0x${string}`;
  readonly Rescissions: `0x${string}`;
  /** Primary anchors deployment (per ANCHORS_LAYOUT at deploy time). */
  readonly PassportAnchors: `0x${string}`;
  readonly PassportAnchorsBaseline: `0x${string}`;
  readonly PassportAnchorsPaged: `0x${string}`;
  readonly GrantManager: `0x${string}`;
  readonly ReceiptLedger: `0x${string}`;
  readonly RoyaltyRouter: `0x${string}`;
  readonly FirsthandLens: `0x${string}`;
  readonly genesis: number;
  readonly epochLength: number;
  readonly anchorsLayout: "baseline" | "paged";
  /** USDC (EIP-3009) used by RoyaltyRouter; MockUSDC on local chains. */
  readonly USDC: `0x${string}`;
  readonly revealWindowBlocks: number;
}

const DEPLOYMENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deployments");

export function deploymentPath(chainId: number | bigint): string {
  return join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

/** Throws with a precise message when no deployment exists for `chainId`. */
export function getDeployment(chainId: number | bigint): Deployment {
  let text: string;
  try {
    text = readFileSync(deploymentPath(chainId), "utf8");
  } catch (cause) {
    throw new Error(`no deployment for chain ${chainId} (expected ${deploymentPath(chainId)})`, {
      cause,
    });
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  for (const key of [
    "PrincipalRegistry",
    "Rescissions",
    "PassportAnchors",
    "PassportAnchorsBaseline",
    "PassportAnchorsPaged",
    "GrantManager",
    "ReceiptLedger",
    "RoyaltyRouter",
    "FirsthandLens",
  ]) {
    if (typeof raw[key] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw[key] as string)) {
      throw new Error(`deployment ${chainId}: missing or malformed address for ${key}`);
    }
  }
  return raw as unknown as Deployment;
}
