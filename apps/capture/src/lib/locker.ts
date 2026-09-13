import {
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters/memory";
import { type Address, MONAD_TESTNET_CHAIN_ID } from "@firsthand/core";
import type { PrfSource } from "@firsthand/crypto";
import { FirsthandClient, type LockerSession } from "@firsthand/sdk/browser";

/**
 * Client assembly for the PWA. Memory adapters until Phase 2/4 wire the deployed contracts and the
 * gateway's blob endpoint; the verbs and the refusal gate are already real.
 */
export function createClient(): FirsthandClient {
  return new FirsthandClient({
    domain: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      verifyingContract: (import.meta.env["VITE_PASSPORT_ANCHORS"] ??
        `0x${"00".repeat(20)}`) as Address,
    },
    epochs: { genesis: BigInt(import.meta.env["VITE_EPOCH_GENESIS"] ?? "0"), length: 604_800n },
    anchors: new MemoryAnchorWriter(),
    blobs: new MemoryBlobStore(),
    transport: new MemoryTransport(),
    facilitator: new MemoryFacilitator(),
    addresses: {
      grantManager: (import.meta.env["VITE_GRANT_MANAGER"] ?? `0x${"00".repeat(20)}`) as Address,
      rescissions: (import.meta.env["VITE_RESCISSIONS"] ?? `0x${"00".repeat(20)}`) as Address,
      principalRegistry: (import.meta.env["VITE_PRINCIPAL_REGISTRY"] ??
        `0x${"00".repeat(20)}`) as Address,
    },
    namespaces: [
      { ns: 0, label: "captures" },
      { ns: 1, label: "notes" },
    ],
  });
}

export function openSession(client: FirsthandClient, source: PrfSource): Promise<LockerSession> {
  return client.open(source);
}
