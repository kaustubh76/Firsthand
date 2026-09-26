import type { AnchorWriter } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";

/** What `manifestFromSidecars` and `manifestFromQueries` claim when the caller says nothing. */
export const DEFAULT_MANIFEST_FINALITY = 2;

/**
 * The finality depth a file can honestly claim.
 *
 * `LineageManifest.finalityDepth` is the producer's statement about how settled the anchors were
 * when it was written, and the verifier enforces it: an asset whose anchor is shallower than the
 * depth the file claims reads `NOT_FINAL`. This app used to pass `0` — no claim at all — while the
 * Verify tab's own subtitle told a reader each asset was checked for "anchoring, and finality".
 * Passing the SDK's default instead would have been the opposite mistake: a manifest exported one
 * block after its anchor would fail its own check.
 *
 * So claim what is true: how deep the *shallowest* anchor already is, capped at the default. The
 * number can only be conservative, because a later verification sees a taller chain.
 */
export async function honestFinalityDepth(
  anchors: Pick<AnchorWriter, "anchorBlock">,
  roots: readonly Bytes32[],
  headBlock: bigint,
  max: number = DEFAULT_MANIFEST_FINALITY,
): Promise<number> {
  if (headBlock === 0n) return 0;
  let shallowest = BigInt(max);
  for (const root of new Set(roots)) {
    const block = await anchors.anchorBlock(root).catch(() => null);
    if (block === null) return 0;
    const depth = headBlock > block ? headBlock - block : 0n;
    if (depth < shallowest) shallowest = depth;
  }
  return Number(shallowest < 0n ? 0n : shallowest);
}
