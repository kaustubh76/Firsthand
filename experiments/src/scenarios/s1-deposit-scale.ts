import { BATCH_SIZE, type Bytes32 } from "@firsthand/core";
import { deposit, exportManifest, verifyManifest } from "@firsthand/sdk";
import { Arms, resolveArm } from "../arms/index.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { anchorCostPer1k } from "../metrics/gas.js";
import { manifestBytes, proofBytesPerAsset } from "../metrics/proofSize.js";
import { ATTESTATION, datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S1 — deposit at scale (README §15): N passports at batch=256, then export a manifest over all of
 * them and time the reference verifier. Measures H3 today (memory arm) and H1 once on-chain arms
 * report gas.
 */
export const s1: Scenario = {
  id: "s1",
  hypothesis: "H3",
  arms: [Arms.MEMORY, Arms.ANCHORS_BASELINE, Arms.ANCHORS_PAGED],
  async run(arm: string, ctx: RunContext) {
    const adapters = await resolveArm(arm);
    const { locker, batcher } = seededLocker(1, adapters, ctx.clock);
    await adapters.prepare(locker);
    const terms = termsFor(locker);
    const n = ctx.dryRun ? Math.min(ctx.n, 300) : ctx.n;

    const t0 = ctx.clock.nowMs();
    for (let i = 0; i < n; i++) {
      await deposit(locker, batcher, {
        ns: 0,
        datum: { kind: "bytes", bytes: datumBytes(i) },
        terms,
        attestation: ATTESTATION,
      });
    }
    await batcher.flush();
    const depositMs = ctx.clock.nowMs() - t0;

    const manifest = exportManifest({
      domain: locker.domain,
      principalId: locker.principalId,
      ns: 0,
      batches: batcher.flushed(),
      // Deliberate: this harness times verification, and must not wait for blocks it is not
      // measuring. A file that claims no finality is the honest artefact of a timing run.
      finalityDepth: 0,
    });
    const verifyCtx = {
      anchors: adapters.anchors,
      headBlock: await adapters.headBlock(),
      now: () => ctx.clock.nowMs(),
    };
    // H3 as specified: Merkle inclusion + anchoring, O(log n) per asset.
    const merkleOnly = await verifyManifest(manifest, verifyCtx, { signatures: "none" });
    // Full compliance mode: every origin signature re-proved (ECDSA recovery dominates in pure JS).
    const full = ctx.dryRun
      ? merkleOnly
      : await verifyManifest(manifest, verifyCtx, { signatures: "all" });
    if (!merkleOnly.ok || !full.ok) {
      const bad = [...merkleOnly.assets, ...full.assets].filter((a) => !a.ok);
      const reasons = bad.reduce<Record<string, number>>((acc, a) => {
        acc[a.reason ?? "?"] = (acc[a.reason ?? "?"] ?? 0) + 1;
        return acc;
      }, {});
      throw new Error(
        `S1: manifest failed to verify: ${JSON.stringify(reasons)} (${bad.length} of ${merkleOnly.assets.length + full.assets.length})`,
      );
    }

    const anchorsRefs = batcher.flushed().map((b) => b.anchor);
    const gas = anchorCostPer1k(anchorsRefs, BATCH_SIZE);
    const gasPerAnchor = anchorsRefs.every((a) => a.gasUsed !== null)
      ? anchorsRefs.reduce((sum, a) => sum + Number(a.gasUsed), 0) / Math.max(1, anchorsRefs.length)
      : null;
    const roots: Bytes32[] = batcher.flushed().map((b) => b.root);
    return {
      metrics: {
        passports: { value: n, unit: "count" },
        batches: { value: roots.length, unit: "count" },
        depositMs: { value: depositMs, unit: "ms" },
        verifyMerkleMs: { value: merkleOnly.ms, unit: "ms" },
        verifyMerklePerAssetUs: { value: (merkleOnly.ms * 1000) / n, unit: "us" },
        verifyFullMs: { value: full.ms, unit: "ms" },
        verifySignaturePerAssetUs: { value: (full.signatureMs * 1000) / n, unit: "us" },
        hashesPerAsset: { value: merkleOnly.hashesPerAsset, unit: "hashes" },
        proofBytesPerAsset: { value: proofBytesPerAsset(), unit: "bytes" },
        manifestBytes: { value: manifestBytes(manifest), unit: "bytes" },
        ...(gas === null ? {} : { anchorGasPer1k: { value: gas, unit: "gas" } }),
        ...(gasPerAnchor === null
          ? {}
          : { anchorGasPerBatch: { value: gasPerAnchor, unit: "gas" } }),
      },
      onChain: adapters.onChain,
      notes: [
        "H3 target: ≤ 8 hashes/asset and a 10k-asset corpus verifies in < 2 s (verifyMerkleMs) in the reference verifier.",
        "verifyFullMs additionally re-proves every origin signature; pure-JS ECDSA recovery costs ~ms/asset (native path is roadmap).",
        gas === null
          ? "H1 gas not observable on the memory arm; run with an on-chain arm (Phase 2)."
          : "H1 gas observed.",
      ],
    };
  },
};
