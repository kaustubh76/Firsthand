import {
  anvil,
  createChainClients,
  HttpRelayTransport,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
  monadTestnet,
  OnchainAnchorWriter,
} from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import type { PrfSource } from "@firsthand/crypto";
import { FirsthandClient, type LockerSession } from "@firsthand/sdk/browser";
import type { AppConfig } from "./config.js";

export interface CaptureClient {
  readonly client: FirsthandClient;
  /**
   * Waits for a relayed transaction to be mined. Relaying returns as soon as the gateway accepts the
   * transaction, so dependent calls — attest after enroll, anchor after attest — must wait, or they
   * simulate against state that does not exist yet and are refused.
   */
  readonly waitForTx: ((hash: Bytes32) => Promise<void>) | null;
}

/**
 * Client assembly for the PWA. Live mode reads through a key-less viem client and writes through the
 * gateway's relay — the browser never holds a key, and it does not need one: every authority-signed
 * entry point authorises by the signature inside the calldata, not by `msg.sender` (ADR-0009).
 * Without a gateway it falls back to memory doubles so `pnpm dev` still works offline.
 */
export function createClient(config: AppConfig): CaptureClient {
  const live = config.live && config.gatewayUrl !== null && config.rpcUrl !== null;
  const transport = live
    ? new HttpRelayTransport({ baseUrl: config.gatewayUrl as string })
    : new MemoryTransport();

  const publicClient = live
    ? createChainClients({
        rpcUrl: config.rpcUrl as string,
        chain: config.chainId === 31337n ? anvil : monadTestnet,
      }).publicClient
    : null;
  const anchors = publicClient
    ? new OnchainAnchorWriter({
        address: config.passportAnchors,
        layout: config.anchorsLayout,
        publicClient,
        transport,
      })
    : new MemoryAnchorWriter();
  const client = new FirsthandClient({
    domain: { chainId: config.chainId, verifyingContract: config.passportAnchors },
    epochs: config.epochs,
    anchors,
    // Ciphertext is sealed here and pushed to the gateway on publish; nothing plaintext leaves.
    blobs: new MemoryBlobStore(),
    transport,
    facilitator: new MemoryFacilitator(),
    addresses: {
      grantManager: config.grantManager,
      rescissions: config.rescissions,
      principalRegistry: config.principalRegistry,
    },
    namespaces: [
      { ns: 0, label: "captures" },
      { ns: 1, label: "notes" },
    ],
  });
  return {
    client,
    waitForTx: publicClient
      ? async (hash) => {
          await publicClient.waitForTransactionReceipt({ hash });
        }
      : null,
  };
}

export function openSession(client: FirsthandClient, source: PrfSource): Promise<LockerSession> {
  return client.open(source);
}
