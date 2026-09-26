import type { AnchorWriter } from "@firsthand/adapters/client";
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
  OnchainReceiptReader,
} from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import type { PrfSource } from "@firsthand/crypto";
import { FirsthandClient, type LockerSession } from "@firsthand/sdk/browser";
import type { PublicClient } from "viem";
import type { AppConfig } from "./config.js";
import { NS } from "./terms.js";

export interface CaptureClient {
  readonly client: FirsthandClient;
  /** Live mode only: the relay every write rides, the key-less reader, and the anchors reader. */
  readonly relay: HttpRelayTransport | null;
  readonly publicClient: PublicClient | null;
  readonly anchors: AnchorWriter;
  /**
   * Proves a Lineage Manifest's receipts against `ReceiptLedger` — null offline, and the manifest
   * verdict then says the payment check did not run rather than implying it passed.
   */
  readonly receipts: OnchainReceiptReader | null;
  /**
   * Waits for a relayed transaction to be mined. Relaying returns as soon as the gateway accepts the
   * transaction, so dependent calls — attest after enroll, anchor after attest — must wait, or they
   * simulate against state that does not exist yet and are refused.
   */
  /**
   * Wait for a relayed transaction to be included. The label is what the app shows for it while
   * it waits ("enrolled", "granted"…); the shell wraps this to raise toasts and a timeline row.
   */
  readonly waitForTx: ((hash: Bytes32, label?: string) => Promise<void>) | null;
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
  // Read from the chain, not from the gateway: a manifest is audited because the gateway's word is
  // what is in question. Discovery publishes the address; `config.receiptLedger` already parses it.
  const receipts =
    publicClient && config.receiptLedger !== `0x${"00".repeat(20)}`
      ? new OnchainReceiptReader({ publicClient, receiptLedger: config.receiptLedger })
      : null;
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
      { ns: NS.captures, label: "captures" },
      { ns: NS.imports, label: "imports" },
    ],
  });
  return {
    client,
    relay: live ? (transport as HttpRelayTransport) : null,
    publicClient: (publicClient as PublicClient | null) ?? null,
    anchors,
    receipts,
    waitForTx: publicClient
      ? async (hash) => {
          // 90 s, not viem's 180 s: a relayed transaction that has not landed by then was dropped
          // or replaced, and a judge deserves the sentence rather than a longer spinner.
          await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 }).catch((e) => {
            if ((e as Error).name === "WaitForTransactionReceiptTimeoutError") {
              throw new Error(
                `transaction ${hash} was not included within 90 s — check the explorer, then retry`,
              );
            }
            throw e;
          });
        }
      : null,
  };
}

export function openSession(client: FirsthandClient, source: PrfSource): Promise<LockerSession> {
  return client.open(source);
}
