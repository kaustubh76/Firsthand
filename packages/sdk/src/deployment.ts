import {
  type BlobStore,
  MemoryFacilitator,
  OnchainAnchorWriter,
  PublicMempoolTransport,
  type TxTransport,
  type X402Facilitator,
} from "@firsthand/adapters";
import type { Deployment } from "@firsthand/contracts/deployments";
import type { Address } from "@firsthand/core";
import { ConfigError } from "@firsthand/core";
import type { Chain, PublicClient, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { FirsthandClientOptions } from "./client/FirsthandClient.js";
import type { NamespaceInfo } from "./locker/Locker.js";

export { type Deployment, loadDeployment } from "@firsthand/contracts/deployments";

/**
 * Node-only: builds every address, domain and epoch parameter a client needs from one
 * `deployments/<chainId>.json`, so no app has to transcribe them into its own env vars. The
 * browser has no filesystem — the capture PWA takes the same shape from the gateway's
 * `/.well-known/firsthand.json` instead.
 */
export interface DeploymentClientOptions {
  readonly deployment: Deployment;
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Anchors sign and broadcast through this wallet; without one they ride `transport` (a relay). */
  readonly walletClient?: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly blobs: BlobStore;
  /** Defaults to a public-mempool transport over `walletClient`; pass BTX or a relay explicitly. */
  readonly transport?: TxTransport;
  readonly facilitator?: X402Facilitator;
  readonly namespaces?: readonly NamespaceInfo[];
  readonly logger?: FirsthandClientOptions["logger"];
  readonly clock?: () => bigint;
}

export function clientOptionsFromDeployment(
  options: DeploymentClientOptions,
): FirsthandClientOptions {
  const d = options.deployment;
  const transport =
    options.transport ??
    (options.walletClient
      ? new PublicMempoolTransport(options.walletClient)
      : (() => {
          throw new ConfigError(
            "clientOptionsFromDeployment needs a walletClient or an explicit transport",
          );
        })());
  return {
    // The anchors contract is the EIP-712 verifyingContract for passports (ADR-0002/0009).
    domain: { chainId: BigInt(d.chainId), verifyingContract: d.PassportAnchors as Address },
    epochs: { genesis: BigInt(d.genesis), length: BigInt(d.epochLength) },
    // A key-less client (the MCP as a pure buyer/relayed seller) anchors through the same relay
    // its other verbs use; with a wallet the writer signs and broadcasts itself.
    anchors: new OnchainAnchorWriter({
      address: d.PassportAnchors as Address,
      layout: d.anchorsLayout,
      publicClient: options.publicClient,
      ...(options.walletClient ? { walletClient: options.walletClient } : { transport }),
    }),
    blobs: options.blobs,
    transport,
    facilitator: options.facilitator ?? new MemoryFacilitator(),
    addresses: {
      grantManager: d.GrantManager as Address,
      rescissions: d.Rescissions as Address,
      principalRegistry: d.PrincipalRegistry as Address,
    },
    ...(options.namespaces ? { namespaces: options.namespaces } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}

/** Fails loudly when the node we are talking to is not the chain the deployment describes. */
export async function assertChain(
  publicClient: PublicClient<Transport, Chain>,
  deployment: Deployment,
  source: string,
): Promise<void> {
  const live = await publicClient.getChainId();
  if (live !== deployment.chainId) {
    throw new ConfigError(
      `RPC reports chain ${live} but ${source} describes chain ${deployment.chainId}`,
    );
  }
}
