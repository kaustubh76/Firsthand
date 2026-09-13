import type { AnchorWriter } from "@firsthand/adapters";
import {
  type Bytes32,
  type LineageManifest,
  LineageManifestSchema,
  MERKLE_DEPTH,
  passportId,
  verifyPassportInBatch,
  verifyPassportSignature,
} from "@firsthand/core";
import { serialiseManifest } from "./export.js";

/**
 * Offline verifier for a Lineage Manifest (H3). For every asset: signature, Merkle proof, anchored
 * root, and finality depth. Reports per-asset reasons rather than failing on the first.
 */
export type AssetFailure = "SIG_INVALID" | "MERKLE_INVALID" | "ROOT_UNKNOWN" | "NOT_FINAL";

export interface AssetVerdict {
  readonly passportId: Bytes32;
  readonly ok: boolean;
  readonly reason?: AssetFailure;
}

export interface ManifestVerdict {
  readonly ok: boolean;
  readonly assets: readonly AssetVerdict[];
  readonly hashesPerAsset: number;
  /** Wall time of the whole verification. */
  readonly ms: number;
  /** Time spent in per-asset ECDSA recovery (the dominant cost in pure JS, ~ms per asset). */
  readonly signatureMs: number;
  /** Time spent in Merkle + anchoring + finality checks — the O(log n) part H3 measures. */
  readonly merkleMs: number;
  readonly signatures: SignatureMode;
}

/**
 * Which origin signatures to re-check offline. Every passport was signature-checked at deposit and
 * its batch root was anchored under a deposit-key signature verified on-chain, so `"none"` still
 * proves inclusion under an attested lineage; `"all"` (default) additionally re-proves each origin.
 * A number samples that many assets uniformly (deterministic stride) — a compliance spot-check.
 */
export type SignatureMode = "all" | "none" | number;

export interface ManifestVerifyOptions {
  readonly signatures?: SignatureMode;
}

export interface ManifestVerifyContext {
  readonly anchors: Pick<AnchorWriter, "isAnchored" | "anchorBlock">;
  /** Current chain head, for finality-depth checks (README §13 "chain reorg"). */
  readonly headBlock: bigint;
  readonly now?: () => number;
}

export async function verifyManifest(
  input: LineageManifest | unknown,
  ctx: ManifestVerifyContext,
  options: ManifestVerifyOptions = {},
): Promise<ManifestVerdict> {
  const now = ctx.now ?? (() => performance.now());
  const start = now();
  const signatures = options.signatures ?? "all";
  let signatureMs = 0;
  // Accept both the in-memory form (bigints) and the wire form (decimal strings).
  const wire =
    typeof (input as { domain?: { chainId?: unknown } })?.domain?.chainId === "bigint"
      ? JSON.parse(serialiseManifest(input as LineageManifest))
      : input;
  const manifest = LineageManifestSchema.parse(wire);
  const domain = {
    chainId: manifest.domain.chainId,
    verifyingContract: manifest.domain.verifyingContract,
  };
  const rootCache = new Map<Bytes32, { anchored: boolean; block: bigint | null }>();

  const total = manifest.assets.length;
  const stride =
    typeof signatures === "number" && signatures > 0
      ? Math.max(1, Math.floor(total / signatures))
      : 1;
  const checkSignature = (index: number): boolean =>
    signatures === "all" ||
    (typeof signatures === "number" && signatures > 0 && index % stride === 0);

  const assets: AssetVerdict[] = [];
  for (let index = 0; index < total; index++) {
    const asset = manifest.assets[index] as (typeof manifest.assets)[number];
    const id = passportId(asset.signed.passport);
    const fail = (reason: AssetFailure) => assets.push({ passportId: id, ok: false, reason });
    if (checkSignature(index)) {
      const t = now();
      const sigOk = verifyPassportSignature(asset.signed.passport, asset.signed.signature, domain);
      signatureMs += now() - t;
      if (!sigOk) {
        fail("SIG_INVALID");
        continue;
      }
    }
    // Same order as core's verifyPredicate: signature → root known → Merkle → liveness/finality.
    let root = rootCache.get(asset.batchRoot);
    if (root === undefined) {
      root = {
        anchored: await ctx.anchors.isAnchored(asset.batchRoot),
        block: await ctx.anchors.anchorBlock(asset.batchRoot),
      };
      rootCache.set(asset.batchRoot, root);
    }
    if (!root.anchored || root.block === null) {
      fail("ROOT_UNKNOWN");
      continue;
    }
    if (!verifyPassportInBatch(asset.batchRoot, id, asset.proof)) {
      fail("MERKLE_INVALID");
      continue;
    }
    if (ctx.headBlock - root.block < BigInt(manifest.finalityDepth)) {
      fail("NOT_FINAL");
      continue;
    }
    assets.push({ passportId: id, ok: true });
  }
  const ms = now() - start;
  return {
    ok: assets.every((a) => a.ok),
    assets,
    hashesPerAsset: MERKLE_DEPTH,
    ms,
    signatureMs,
    merkleMs: ms - signatureMs,
    signatures,
  };
}
