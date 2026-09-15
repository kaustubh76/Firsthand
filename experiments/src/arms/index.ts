import { readFileSync } from "node:fs";
import {
  type AnchorWriter,
  anvil,
  BtxTransport,
  createChainClients,
  MemoryAnchorWriter,
  MemoryTransport,
  monadTestnet,
  OnchainAnchorWriter,
  PublicMempoolTransport,
  type TxTransport,
} from "@firsthand/adapters";
import type { Address, Eip712Domain, EpochParams } from "@firsthand/core";
import { type Locker, planAttest, planEnroll, sendAttest, sendEnroll } from "@firsthand/sdk";

/**
 * Arms are adapter selections (ADR-0006): same code, different port implementations.
 *
 *   B1 naive-acl        — no passports at all (baseline for verification cost; simulated)
 *   B2 public-mempool   — rescission over the public mempool (observer can race)
 *   btx                 — rescission over Monad's encrypted mempool (needs BTX_RPC_URL; not on testnet 2026-09)
 *   btx-blind           — NOT BTX: the public mempool with a bot that gets no signal — the no-signal bound
 *   commit-reveal       — rescission via Rescissions.commit + reveal (the fallback that works everywhere)
 *   anchors-baseline    — PassportAnchorsBaseline on a live chain (H1 baseline arm)
 *   anchors-paged       — PassportAnchorsPaged on a live chain (H1 MIP-8 arm)
 *   memory              — in-memory doubles
 */
export const Arms = {
  B1_NAIVE_ACL: "B1-naive-acl",
  B2_PUBLIC_MEMPOOL: "B2-public-mempool",
  BTX: "btx",
  BTX_BLIND: "btx-blind",
  COMMIT_REVEAL: "commit-reveal",
  ANCHORS_BASELINE: "anchors-baseline",
  ANCHORS_PAGED: "anchors-paged",
  MEMORY: "memory",
} as const;
export type Arm = (typeof Arms)[keyof typeof Arms];

export interface ArmAdapters {
  readonly arm: Arm;
  readonly anchors: AnchorWriter;
  readonly transport: TxTransport;
  readonly onChain: boolean;
  /** Present on live-chain arms: the deployment's domain / epochs / clock the locker must use. */
  readonly domain?: Eip712Domain;
  readonly epochs?: EpochParams;
  readonly clock?: () => bigint;
  /** Live-chain arms enrol + attest the locker before it can anchor; memory arms do nothing. */
  readonly prepare: (locker: Locker) => Promise<void>;
  /** Live-chain arms need a unique principal per run. */
  readonly uniqueSeeds: boolean;
  /** Current head block, for finality-depth checks in manifest verification. */
  readonly headBlock: () => Promise<bigint>;
  /** Live-chain arms expose their clients and deployment so demand-side scenarios can build settlement. */
  readonly chain?: {
    readonly clients: ReturnType<typeof createChainClients>;
    readonly deployment: Deployment;
    readonly env: ChainEnv;
  };
}

/** Memory-backed arms available everywhere. */
export function memoryArm(arm: Arm): ArmAdapters {
  const anchors = new MemoryAnchorWriter();
  return {
    arm,
    anchors,
    transport: new MemoryTransport({ encryptedMempool: arm === Arms.BTX }),
    onChain: false,
    prepare: async () => {},
    uniqueSeeds: false,
    headBlock: async () => anchors.head,
  };
}

export interface ChainEnv {
  readonly rpcUrl: string;
  readonly deploymentsFile: string;
  readonly relayerKey: `0x${string}`;
  /** BTX submission endpoint + method; absent means the `btx` arm is skipped with a reason. */
  readonly btxRpcUrl?: string;
  readonly btxMethod?: string;
}

/** Reads the live-chain environment (same variables as the SDK's test:anvil tier); null when absent. */
export function chainEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChainEnv | null {
  const rpcUrl = env["ANVIL_RPC_URL"];
  const deploymentsFile = env["DEPLOYMENTS_FILE"];
  const relayerKey = env["RELAYER_PRIVATE_KEY"];
  if (!rpcUrl || !deploymentsFile || !relayerKey) return null;
  const btxRpcUrl = env["BTX_RPC_URL"];
  const btxMethod = env["BTX_METHOD"];
  return {
    rpcUrl,
    deploymentsFile,
    relayerKey: relayerKey as `0x${string}`,
    ...(btxRpcUrl ? { btxRpcUrl } : {}),
    ...(btxMethod ? { btxMethod } : {}),
  };
}

export interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  PassportAnchorsBaseline: Address;
  PassportAnchorsPaged: Address;
  GrantManager: Address;
  ReceiptLedger: Address;
  RoyaltyRouter: Address;
  Rescissions: Address;
  USDC: Address;
  genesis: number;
  epochLength: number;
  revealWindowBlocks: number;
}

export function isOnchainArm(
  arm: string,
): arm is typeof Arms.ANCHORS_BASELINE | typeof Arms.ANCHORS_PAGED {
  return arm === Arms.ANCHORS_BASELINE || arm === Arms.ANCHORS_PAGED;
}

export type RaceArm =
  | typeof Arms.B2_PUBLIC_MEMPOOL
  | typeof Arms.BTX
  | typeof Arms.BTX_BLIND
  | typeof Arms.COMMIT_REVEAL;

export function isRaceArm(arm: string): arm is RaceArm {
  return (
    arm === Arms.B2_PUBLIC_MEMPOOL ||
    arm === Arms.BTX ||
    arm === Arms.BTX_BLIND ||
    arm === Arms.COMMIT_REVEAL
  );
}

export const BTX_STATUS =
  "BTX (Category Labs' batched threshold encryption) is not deployed on Monad testnet as of 2026-09; set BTX_RPC_URL (+ BTX_METHOD) to run this arm";

/**
 * Race arms (S3) are the baseline anchors arm with the principal's rescission transport swapped:
 * the public mempool for B2 / commit-reveal / btx-blind, a probe-gated BtxTransport for `btx`.
 * Clients poll fast (25 ms) because race timing is the measurement.
 */
export async function raceArm(arm: RaceArm, env: ChainEnv): Promise<ArmAdapters> {
  const base = await onchainArm(Arms.ANCHORS_BASELINE, env, 25);
  if (!base.chain?.clients.walletClient) throw new Error("relayer wallet missing");
  if (arm === Arms.BTX) {
    if (!env.btxRpcUrl) throw new ArmUnavailableError(arm, BTX_STATUS);
    const btx = new BtxTransport({
      rpcUrl: env.btxRpcUrl,
      wallet: base.chain.clients.walletClient,
      ...(env.btxMethod ? { method: env.btxMethod } : {}),
    });
    const caps = await btx.capabilities();
    if (!caps.encryptedMempool) {
      throw new ArmUnavailableError(arm, `${caps.detail ?? "BTX unavailable"} — ${BTX_STATUS}`);
    }
    return { ...base, arm, transport: btx };
  }
  return { ...base, arm };
}

/** Live-chain arm: OnchainAnchorWriter for the chosen layout + relayer transport + registry prep. */
export async function onchainArm(
  arm: typeof Arms.ANCHORS_BASELINE | typeof Arms.ANCHORS_PAGED,
  env: ChainEnv,
  pollingInterval?: number,
): Promise<ArmAdapters> {
  const deployment = JSON.parse(readFileSync(env.deploymentsFile, "utf8")) as Deployment;
  const clients = createChainClients({
    rpcUrl: env.rpcUrl,
    chain: deployment.chainId === 31337 ? anvil : monadTestnet,
    privateKey: env.relayerKey,
    ...(pollingInterval === undefined ? {} : { pollingInterval }),
  });
  if (!clients.walletClient) throw new Error("relayer wallet missing");
  const layout = arm === Arms.ANCHORS_PAGED ? "paged" : "baseline";
  const address = (
    layout === "paged" ? deployment.PassportAnchorsPaged : deployment.PassportAnchorsBaseline
  ).toLowerCase() as Address;
  const anchors = new OnchainAnchorWriter({
    address,
    layout,
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
  });
  const transport = new PublicMempoolTransport(clients.walletClient);
  const registry = deployment.PrincipalRegistry.toLowerCase() as Address;
  const block = await clients.publicClient.getBlock();
  return {
    arm,
    anchors,
    transport,
    onChain: true,
    domain: { chainId: BigInt(deployment.chainId), verifyingContract: address },
    epochs: { genesis: BigInt(deployment.genesis), length: BigInt(deployment.epochLength) },
    clock: () => block.timestamp,
    uniqueSeeds: true,
    chain: { clients, deployment, env },
    headBlock: () => clients.publicClient.getBlockNumber({ cacheTime: 0 }),
    prepare: async (locker) => {
      const e = await sendEnroll(locker, transport, planEnroll(locker, registry));
      await clients.publicClient.waitForTransactionReceipt({ hash: e.txHash });
      const a = await sendAttest(locker, transport, planAttest(locker, registry));
      await clients.publicClient.waitForTransactionReceipt({ hash: a.txHash });
    },
  };
}

/** Thrown when an arm cannot run in this environment; the Runner records a skip rather than failing. */
export class ArmUnavailableError extends Error {
  constructor(arm: string, reason: string) {
    super(`${arm}: ${reason}`);
    this.name = "ArmUnavailableError";
  }
}

/** Picks the adapters for an arm; on-chain arms need the chain env and say so precisely. */
export async function resolveArm(arm: string): Promise<ArmAdapters> {
  if (isOnchainArm(arm) || isRaceArm(arm)) {
    const env = chainEnv();
    if (env === null) {
      throw new ArmUnavailableError(
        arm,
        "needs ANVIL_RPC_URL, DEPLOYMENTS_FILE and RELAYER_PRIVATE_KEY (docs/DEVELOPMENT.md)",
      );
    }
    return isRaceArm(arm) ? raceArm(arm, env) : onchainArm(arm, env);
  }
  return memoryArm(arm as Arm);
}
