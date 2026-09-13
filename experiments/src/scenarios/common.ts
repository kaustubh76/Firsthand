import { MemoryBlobStore } from "@firsthand/adapters";
import {
  type Address,
  type Attestation,
  AttestationClass,
  LICENSE_FH_1_0,
  MONAD_TESTNET_CHAIN_ID,
  Scope,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { KeyTree } from "@firsthand/crypto";
import { Batcher, Locker } from "@firsthand/sdk";
import type { ArmAdapters } from "../arms/index.js";
import type { Clock } from "../harness/Clock.js";

export const DOMAIN = {
  chainId: MONAD_TESTNET_CHAIN_ID,
  verifyingContract: `0x${"a1".repeat(20)}` as Address,
};
export const EPOCHS = { genesis: 1_700_000_000n, length: 604_800n };

/** Deterministic locker for a seed byte; the experiments never use real passkeys. */
export function seededLocker(
  seed: number,
  arm: ArmAdapters,
  clock: Clock,
  batchSize = 256,
): { locker: Locker; batcher: Batcher } {
  const locker = new Locker({
    keys: KeyTree.fromPrf(new Uint8Array(32).fill(seed)),
    domain: DOMAIN,
    epochs: EPOCHS,
    anchors: arm.anchors,
    blobs: new MemoryBlobStore(),
    clock: () => clock.nowSec(),
    namespaces: [{ ns: 0, label: "experiment" }],
  });
  return { locker, batcher: new Batcher(locker, arm.anchors, batchSize) };
}

export function termsFor(locker: Locker): Terms {
  return {
    price: 1n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 100,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  };
}

export const ATTESTATION: Attestation = {
  class: AttestationClass.IMPORT,
  capturedAt: 1_700_000_000n,
  sourceTag: ZERO_HASH,
  deviceClass: ZERO_HASH,
  metaHash: ZERO_HASH,
};

export function datumBytes(i: number): Uint8Array {
  return new TextEncoder().encode(`experiment datum #${i}`);
}
