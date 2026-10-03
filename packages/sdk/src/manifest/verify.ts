import type { AnchorWriter } from "@firsthand/adapters";
// The browser-safe subpath on purpose: `verify` ships in `@firsthand/sdk/browser`, and the
// adapters' root entry pulls `fs/promises`, which breaks the capture app's bundle.
import { type Pacer, pacedMap } from "@firsthand/adapters/client";
import {
  AttestationClass,
  type Bytes32,
  deviceKeyCommitment,
  hardwareCaptureDigest,
  hashAttestation,
  type LineageManifest,
  LineageManifestSchema,
  type ManifestAsset,
  MERKLE_DEPTH,
  passportId,
  verifyCaptureWitness,
  verifyPassportInBatch,
  verifyPassportSignature,
} from "@firsthand/core";
import { serialiseManifest } from "./export.js";

/**
 * Offline verifier for a Lineage Manifest (H3). For every asset: signature, attestation preimage,
 * anchored root, Merkle proof, the corpus the root belongs to, the receipt that paid for it, and
 * finality. Reports per-asset reasons rather than failing on the first.
 *
 * "Offline" means *without trusting the gateway*, not without a network: roots, anchors and receipts
 * are read from the chain, because the gateway's word is the thing being audited.
 */
export type AssetFailure =
  | "SIG_INVALID"
  | "MERKLE_INVALID"
  | "ROOT_UNKNOWN"
  | "NOT_FINAL"
  | "ATTESTATION_MISMATCH"
  /** Class 3 without a witness, or a witness that does not verify over this asset (ADR-0015). */
  | "HARDWARE_PROOF_INVALID"
  /** The anchored root belongs to a different principal or namespace than this manifest claims. */
  | "SCOPE_MISMATCH"
  /** The file's `anchorBlock` is not the block the chain anchored that root in. */
  | "ANCHOR_MISMATCH"
  /** The ledger has never recorded this receipt: nobody paid for this read. */
  | "RECEIPT_UNKNOWN"
  /** The receipt is real but does not say what the file says it says. */
  | "RECEIPT_MISMATCH";

export interface AssetVerdict {
  readonly passportId: Bytes32;
  readonly ok: boolean;
  readonly reason?: AssetFailure;
}

/**
 * What a manifest proved about payment — and, as importantly, what it did not.
 *
 * Without this an auditor cannot tell a fully-paid corpus from one where nobody ever paid: both
 * render the same green "verifies". `carried` counts assets with a receipt in the file, `verified`
 * counts the ones the chain confirmed, and `checked` is false when no receipt reader was supplied,
 * so an unchecked manifest can never be mistaken for a checked one.
 */
export interface ReceiptCoverage {
  readonly carried: number;
  readonly verified: number;
  readonly checked: boolean;
}

export interface ManifestVerdict {
  readonly ok: boolean;
  readonly assets: readonly AssetVerdict[];
  readonly hashesPerAsset: number;
  /** Payment coverage — see `ReceiptCoverage`. Absence is reported, never assumed away. */
  readonly receipts: ReceiptCoverage;
  /** The depth actually enforced: the greater of the manifest's and the auditor's. */
  readonly finalityDepth: number;
  /** Whether the anchored roots were checked against the manifest's principal and namespace. */
  readonly scopeChecked: boolean;
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
  /**
   * A depth the *auditor* requires, independent of the one the file declares. The manifest's own
   * `finalityDepth` is a field of the artefact under audit, so on its own it lets a file talk its
   * reader down to zero; the effective depth is the greater of the two.
   */
  readonly finalityDepth?: number;
}

/** What the chain stored when the query was paid for — `ReceiptLedger.receipt(receiptId)`. */
export interface ChainReceipt {
  readonly grantId: Bytes32;
  readonly ns: number;
  readonly blockNumber: bigint;
}

/**
 * Just enough of `ReceiptLedger` to prove a receipt is real: one `eth_call` per asset, read from the
 * chain rather than from the gateway whose serving is the thing in question. `ReceiptLedger`'s own
 * docstring is the reason — "so the chain, not the gateway, is the source of truth".
 */
export interface ManifestReceiptReader {
  /** Null when the ledger has never recorded this id. */
  receipt(receiptId: Bytes32): Promise<ChainReceipt | null>;
}

export interface ManifestVerifyContext {
  /**
   * `anchorOf` is optional only so a light reader can still check inclusion; supply it and the
   * verifier additionally binds each root to the principal and namespace the manifest names.
   */
  readonly anchors: Pick<AnchorWriter, "isAnchored" | "anchorBlock"> &
    Partial<Pick<AnchorWriter, "anchorOf">>;
  /** Current chain head, for finality-depth checks (README §13 "chain reorg"). */
  readonly headBlock: bigint;
  /** Supply one and receipts are proved against the chain; omit it and the verdict says so. */
  readonly receipts?: ManifestReceiptReader;
  /**
   * Bounds the receipt prefetch. A receipt id is unique per served query, so unlike roots they
   * cannot be deduplicated — a corpus of N paid assets is N reads however it is sliced, and done
   * one at a time on a live chain that is latency × N (measured ~285 ms a call against Monad, so
   * about twelve minutes for 2 560 assets). Omit it and the reads stay sequential, exactly as
   * before; supply one and they run concurrently inside whatever rate the pacer allows.
   */
  readonly pacer?: Pacer;
  readonly now?: () => number;
}

/**
 * True when an asset's hardware claim holds up. An asset that is neither class 3 nor carrying a
 * witness passes trivially — most assets are neither.
 */
function hardwareProofOk(asset: ManifestAsset, chainId: bigint): boolean {
  const isHardware = asset.attestation?.class === AttestationClass.HARDWARE;
  if (!isHardware && !asset.hardware) return true;
  // A witness with no preimage cannot be checked, and an unverifiable proof is not a proof.
  if (!asset.attestation || !asset.hardware) return false;
  if (deviceKeyCommitment(asset.hardware.publicKey) !== asset.attestation.deviceClass) return false;
  const digest = hardwareCaptureDigest({
    chainId,
    origin: asset.signed.passport.origin,
    contentHash: asset.signed.passport.h,
    capturedAt: asset.attestation.capturedAt,
    nonce: asset.signed.passport.nonce,
    deviceClass: asset.attestation.deviceClass,
  });
  return verifyCaptureWitness(digest, asset.hardware.signature, asset.hardware.publicKey);
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
  const rootCache = new Map<
    Bytes32,
    { anchored: boolean; block: bigint | null; owner: { principalId: Bytes32; ns: number } | null }
  >();
  // A file cannot talk its auditor down: whichever depth is stricter wins.
  const finalityDepth = Math.max(manifest.finalityDepth, options.finalityDepth ?? 0);
  const scopeChecked = typeof ctx.anchors.anchorOf === "function";
  const receiptsChecked = ctx.receipts !== undefined;
  let carried = 0;
  let verified = 0;

  const total = manifest.assets.length;
  const stride =
    typeof signatures === "number" && signatures > 0
      ? Math.max(1, Math.floor(total / signatures))
      : 1;
  const checkSignature = (index: number): boolean =>
    signatures === "all" ||
    (typeof signatures === "number" && signatures > 0 && index % stride === 0);

  // Receipts, fetched up front so the loop is not N sequential round trips. Only ids the file
  // actually carries are read; an asset that fails earlier in the loop may therefore have been
  // read for nothing, which is a bounded cost paid only by manifests that are already failing.
  const receiptCache = new Map<Bytes32, ChainReceipt | null>();
  if (ctx.receipts && ctx.pacer) {
    const reader = ctx.receipts;
    const ids = [
      ...new Set(
        manifest.assets
          .map((a) => a.receipt?.receiptId)
          .filter((id): id is Bytes32 => id !== undefined),
      ),
    ];
    const found = await pacedMap(ids, (id) => reader.receipt(id), ctx.pacer);
    // A block body, not an expression: Map.set returns the map, and a forEach callback that
    // returns a value reads as a mapping that forgot to collect its results.
    ids.forEach((id, i) => {
      receiptCache.set(id, found[i] ?? null);
    });
  }

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
    // A carried attestation preimage must be the one the passport committed to — otherwise the
    // "device capture" a buyer filtered on is a label, not a fact.
    if (asset.attestation && hashAttestation(asset.attestation) !== asset.signed.passport.attest) {
      fail("ATTESTATION_MISMATCH");
      continue;
    }
    // Cryptographic only, deliberately: whether the device is still registered is a question about
    // *now*, and a file that was true when it was written must not fail its audit because the
    // seller later revoked a stolen phone. Registration is reported beside the verdict instead.
    if (!hardwareProofOk(asset, domain.chainId)) {
      fail("HARDWARE_PROOF_INVALID");
      continue;
    }
    // Same order as core's verifyPredicate: signature → root known → Merkle → liveness/finality.
    let root = rootCache.get(asset.batchRoot);
    if (root === undefined) {
      // One round trip per root instead of three. `anchorOf` already carries the block it was
      // anchored in, so where a reader offers it the separate `anchorBlock` read is redundant —
      // which matters on a live chain, where this loop is latency, not computation: the S1 corpus
      // spent 8.5 s of its 9.0 s here waiting on 30 sequential calls.
      // Called on the receiver, never hoisted: these readers keep state on `this`.
      const [anchored, owner] = await Promise.all([
        ctx.anchors.isAnchored(asset.batchRoot),
        ctx.anchors.anchorOf?.(asset.batchRoot) ?? Promise.resolve(null),
      ]);
      const block =
        owner !== null ? owner.blockNumber : await ctx.anchors.anchorBlock(asset.batchRoot);
      root = { anchored, block, owner };
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
    // The header claims a corpus; the chain says who actually anchored the root. Without this the
    // "one file per corpus" on the cover is the author's word — the same check `verifyPredicate`
    // and `FirsthandLens` make at serve time, under the same name.
    if (
      root.owner &&
      (root.owner.principalId !== manifest.principalId || root.owner.ns !== manifest.ns)
    ) {
      fail("SCOPE_MISMATCH");
      continue;
    }
    // The file carries an anchor block; until now nothing compared it with the chain's, so a
    // manifest could claim any block and never be contradicted.
    if (asset.anchorBlock !== root.block) {
      fail("ANCHOR_MISMATCH");
      continue;
    }
    if (ctx.headBlock - root.block < BigInt(finalityDepth)) {
      fail("NOT_FINAL");
      continue;
    }
    if (asset.receipt) {
      carried++;
      if (ctx.receipts) {
        const onChain = receiptCache.has(asset.receipt.receiptId)
          ? (receiptCache.get(asset.receipt.receiptId) ?? null)
          : await ctx.receipts.receipt(asset.receipt.receiptId);
        if (onChain === null) {
          // No receipt means the read was never paid for — README §7.3 calls that "adverse".
          fail("RECEIPT_UNKNOWN");
          continue;
        }
        if (
          onChain.grantId !== asset.receipt.grantId ||
          onChain.blockNumber !== asset.receipt.blockNumber ||
          onChain.ns !== manifest.ns
        ) {
          fail("RECEIPT_MISMATCH");
          continue;
        }
        verified++;
      }
    }
    assets.push({ passportId: id, ok: true });
  }
  const ms = now() - start;
  return {
    ok: assets.every((a) => a.ok),
    assets,
    hashesPerAsset: MERKLE_DEPTH,
    receipts: { carried, verified, checked: receiptsChecked },
    finalityDepth,
    scopeChecked,
    ms,
    signatureMs,
    merkleMs: ms - signatureMs,
    signatures,
  };
}
