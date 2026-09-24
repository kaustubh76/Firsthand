import { readFileSync } from "node:fs";

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

const ADDRESS_KEYS = [
  "PrincipalRegistry",
  "Rescissions",
  "PassportAnchors",
  "PassportAnchorsBaseline",
  "PassportAnchorsPaged",
  "GrantManager",
  "ReceiptLedger",
  "RoyaltyRouter",
  "FirsthandLens",
  "USDC",
] as const;

const NUMBER_KEYS = ["chainId", "genesis", "epochLength", "revealWindowBlocks"] as const;

/**
 * Validates every field the apps rely on, not just the addresses: a truncated or hand-edited file
 * should fail here with the offending key rather than produce an EIP-712 domain mismatch later.
 */
export function parseDeployment(raw: unknown, source: string): Deployment {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: not a JSON object`);
  const d = raw as Record<string, unknown>;
  for (const key of ADDRESS_KEYS) {
    if (typeof d[key] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d[key] as string)) {
      throw new Error(`${source}: missing or malformed address for ${key}`);
    }
  }
  for (const key of NUMBER_KEYS) {
    if (typeof d[key] !== "number" || !Number.isFinite(d[key] as number)) {
      throw new Error(`${source}: missing or malformed number for ${key}`);
    }
  }
  if (d["anchorsLayout"] !== "baseline" && d["anchorsLayout"] !== "paged") {
    throw new Error(`${source}: anchorsLayout must be "baseline" or "paged"`);
  }
  const lower = Object.fromEntries(
    Object.entries(d).map(([k, v]) => [
      k,
      (ADDRESS_KEYS as readonly string[]).includes(k) ? (v as string).toLowerCase() : v,
    ]),
  );
  return lower as unknown as Deployment;
}

/** Reads and validates a deployment file by path — what `DEPLOYMENTS_FILE` points at. */
export function loadDeployment(path: string): Deployment {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read deployment file ${path}`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`deployment file ${path} is not valid JSON`, { cause });
  }
  return parseDeployment(raw, `deployment ${path}`);
}
