/** What a manifest claims when its producer says nothing about how settled its anchors were. */
export const DEFAULT_MANIFEST_FINALITY = 2;

/**
 * The finality depth a file can honestly claim.
 *
 * `LineageManifest.finalityDepth` is the producer's statement about how settled the anchors were when
 * it was written, and `verifyManifest` enforces it: an asset whose anchor is shallower than the depth
 * its own file claims reads `NOT_FINAL`. Every caller in this repository used to pass a flat `0` —
 * no claim at all — while the surfaces that show the verdict told a reader each asset had been
 * checked for "anchoring, and finality". Passing the default instead would have been the opposite
 * mistake: a manifest exported one block after its anchor would fail its own check.
 *
 * So claim what is true: how deep the *shallowest* anchor has already reached, capped at the default.
 * The number can only be conservative, because a later verification sees a taller chain — and an
 * auditor who wants more can impose their own floor, which `verifyManifest` takes as the greater of
 * the two.
 */
export function honestFinalityDepth(
  anchorBlocks: Iterable<bigint>,
  headBlock: bigint,
  max: number = DEFAULT_MANIFEST_FINALITY,
): number {
  if (headBlock <= 0n) return 0;
  let shallowest = BigInt(max);
  for (const block of anchorBlocks) {
    const depth = headBlock > block ? headBlock - block : 0n;
    if (depth < shallowest) shallowest = depth;
  }
  return Number(shallowest < 0n ? 0n : shallowest);
}
