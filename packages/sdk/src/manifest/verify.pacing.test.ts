import { createPacer, MemoryAnchorWriter, MemoryBlobStore } from "@firsthand/adapters";
import {
  type Address,
  type Attestation,
  AttestationClass,
  type Bytes32,
  LICENSE_FH_1_0,
  Scope,
  type Terms,
  tag,
  ZERO_HASH,
} from "@firsthand/core";
import { KeyTree, StaticPrfSource } from "@firsthand/crypto";
import { describe, expect, it } from "vitest";
import { Batcher } from "../batch/Batcher.js";
import { Locker } from "../locker/Locker.js";
import { deposit } from "../verbs/deposit.js";
import { exportManifest } from "./export.js";
import type { ChainReceipt, ManifestVerifyContext } from "./verify.js";
import { verifyManifest } from "./verify.js";

/**
 * These assert the *shape of the chain traffic*, not the verdict — correctness lives in sdk.test.ts.
 * On a live chain a manifest's cost is round trips: the anchor reads scale with distinct roots, and
 * the receipt reads with assets. Both were measured against Monad at ~285 ms a call, so the counts
 * here are the difference between seconds and minutes.
 */
const domain = { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` as Address };
const epochs = { genesis: 1_000_000n, length: 604_800n };
const clock = () => 1_000_000n + 5n * 604_800n + 17n;
const payee = `0x${"b2".repeat(20)}` as Address;
const terms: Terms = {
  price: 1_000n,
  licenseId: LICENSE_FH_1_0,
  scope: Scope.TRAIN,
  ns: 0,
  rateLimit: 100,
  payees: [payee],
  weights: [10_000n],
};
const attestation: Attestation = {
  class: AttestationClass.DEVICE_CAPTURE,
  capturedAt: 1_700_000_000n,
  sourceTag: tag("pacing-test"),
  deviceClass: ZERO_HASH,
  metaHash: ZERO_HASH,
};

/** `n` deposits across `batchSize`-sized batches, so distinct roots are controllable. */
async function corpus(n: number, batchSize: number) {
  StaticPrfSource.resetWarning();
  const anchors = new MemoryAnchorWriter();
  const locker = new Locker({
    keys: KeyTree.fromPrf(new Uint8Array(32).fill(7)),
    domain,
    epochs,
    anchors,
    blobs: new MemoryBlobStore(),
    clock,
    namespaces: [{ ns: 0, label: "chat" }],
  });
  const batcher = new Batcher(locker, anchors, batchSize);
  for (let i = 0; i < n; i++) {
    await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: new TextEncoder().encode(`datum-${i}`) },
      terms,
      attestation,
    });
  }
  await batcher.flush();
  const manifest = exportManifest({
    domain,
    principalId: locker.principalId,
    ns: 0,
    batches: batcher.flushed(),
    headBlock: anchors.head,
  });
  return { manifest, anchors };
}

/** Wraps a real anchor reader so every call is counted without changing its answers. */
function counting(anchors: MemoryAnchorWriter, calls: string[]): ManifestVerifyContext["anchors"] {
  return {
    isAnchored: (root: Bytes32) => {
      calls.push(`isAnchored:${root}`);
      return anchors.isAnchored(root);
    },
    anchorBlock: (root: Bytes32) => {
      calls.push(`anchorBlock:${root}`);
      return anchors.anchorBlock(root);
    },
    anchorOf: (root: Bytes32) => {
      calls.push(`anchorOf:${root}`);
      return anchors.anchorOf(root);
    },
  };
}

describe("verifyManifest — chain traffic", () => {
  it("reads anchors once per distinct root, and never reads a block anchorOf already carries", async () => {
    const { manifest, anchors } = await corpus(12, 4); // 12 assets, 3 roots
    const roots = new Set(manifest.assets.map((a) => a.batchRoot));
    expect(roots.size).toBe(3);

    const calls: string[] = [];
    const verdict = await verifyManifest(manifest, {
      anchors: counting(anchors, calls),
      headBlock: anchors.head,
      signatures: "none",
    } as ManifestVerifyContext & { signatures: "none" });
    expect(verdict.ok).toBe(true);

    // Per root, not per asset — 3 and 3, not 12 and 12. `anchorOf` already carries the anchored
    // block, so the separate `anchorBlock` read is not made at all.
    expect(calls.filter((c) => c.startsWith("isAnchored")).length).toBe(3);
    expect(calls.filter((c) => c.startsWith("anchorOf")).length).toBe(3);
    expect(calls.filter((c) => c.startsWith("anchorBlock")).length).toBe(0);
  });

  it("falls back to anchorBlock for a reader that does not offer anchorOf", async () => {
    const { manifest, anchors } = await corpus(6, 3); // 2 roots
    const calls: string[] = [];
    const full = counting(anchors, calls);
    const light: ManifestVerifyContext["anchors"] = {
      isAnchored: full.isAnchored,
      anchorBlock: full.anchorBlock,
    };
    const verdict = await verifyManifest(manifest, { anchors: light, headBlock: anchors.head });
    expect(verdict.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("anchorBlock")).length).toBe(2);
  });

  it("prefetches receipts concurrently under the pacer, and never unbounded", async () => {
    const { manifest, anchors } = await corpus(9, 9);
    let inFlight = 0;
    let peak = 0;
    const receipts = {
      receipt: async (): Promise<ChainReceipt | null> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return null; // every asset then fails RECEIPT_UNKNOWN; the reads still happened
      },
    };
    const withReceipts = {
      ...manifest,
      assets: manifest.assets.map((a, i) => ({
        ...a,
        receipt: {
          receiptId: `0x${String(i).padStart(2, "0").repeat(32)}` as Bytes32,
          grantId: `0x${"cc".repeat(32)}` as Bytes32,
          payer: payee,
          blockNumber: 1n,
          txHash: `0x${"dd".repeat(32)}` as Bytes32,
        },
      })),
    };
    await verifyManifest(withReceipts, {
      anchors: counting(anchors, []),
      headBlock: anchors.head,
      receipts,
      pacer: createPacer({ maxInFlight: 3, minRequestIntervalMs: 0 }),
    });
    // Concurrent, but bounded: an unbounded prefetch over a file a stranger pasted is how a rate
    // limit becomes a retry storm.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("stays sequential with no pacer, so no caller changes behaviour by accident", async () => {
    const { manifest, anchors } = await corpus(5, 5);
    let inFlight = 0;
    let peak = 0;
    const receipts = {
      receipt: async (): Promise<ChainReceipt | null> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return null;
      },
    };
    const withReceipts = {
      ...manifest,
      assets: manifest.assets.map((a, i) => ({
        ...a,
        receipt: {
          receiptId: `0x${String(i).padStart(2, "0").repeat(32)}` as Bytes32,
          grantId: `0x${"cc".repeat(32)}` as Bytes32,
          payer: payee,
          blockNumber: 1n,
          txHash: `0x${"dd".repeat(32)}` as Bytes32,
        },
      })),
    };
    await verifyManifest(withReceipts, {
      anchors: counting(anchors, []),
      headBlock: anchors.head,
      receipts,
    });
    expect(peak).toBe(1);
  });
});
