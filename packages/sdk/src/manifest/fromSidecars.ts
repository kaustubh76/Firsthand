import type { AnchorWriter, ReceiptView } from "@firsthand/adapters";
import {
  type Address,
  type Bytes32,
  type Eip712Domain,
  type LineageManifest,
  LineageManifestSchema,
  type LineageManifestWire,
  type PassportSidecar,
  passportId,
} from "@firsthand/core";
import type { QueryResult } from "../verbs/query.js";
import { DEFAULT_MANIFEST_FINALITY, honestFinalityDepth } from "./finality.js";

/**
 * Lineage Manifests from what a gateway publishes — no batcher, no locker. A sidecar already carries
 * everything an asset needs (`signed`, `batchRoot`, `proof`); the anchor block comes from the chain.
 * This is how the *buyer* builds its compliance file from the queries it paid for (README §1), and
 * how a seller rebuilds its own after the in-memory batches are gone.
 */
export interface SidecarManifestInput {
  readonly domain: Eip712Domain;
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly sidecars: readonly PassportSidecar[];
  /** Anchor block per batch root — `AnchorWriter.anchorBlock` in practice. */
  readonly anchors: Pick<AnchorWriter, "anchorBlock">;
  /** Receipts keyed by passport id; assets without one are unpaid lineage. */
  readonly receipts?: ReadonlyMap<Bytes32, ReceiptView>;
  /**
   * Pass the chain's head and the manifest claims the depth its anchors have actually reached
   * (`honestFinalityDepth`), which is what a caller wants unless it has a reason to state its own.
   * An explicit `finalityDepth` still wins; with neither, the file claims the default.
   */
  readonly headBlock?: bigint;
  readonly finalityDepth?: number;
  readonly now?: () => bigint;
}

export async function manifestFromSidecars(input: SidecarManifestInput): Promise<LineageManifest> {
  const blocks = new Map<Bytes32, bigint>();
  const assets: LineageManifestWire["assets"] = [];
  for (const sidecar of input.sidecars) {
    if (sidecar.principalId !== input.principalId || sidecar.ns !== input.ns) {
      throw new Error(
        `sidecar ${passportId(sidecar.signed.passport)} belongs to another principal or namespace`,
      );
    }
    let block = blocks.get(sidecar.batchRoot);
    if (block === undefined) {
      const found = await input.anchors.anchorBlock(sidecar.batchRoot);
      if (found === null) throw new Error(`batch ${sidecar.batchRoot} is not anchored`);
      block = found;
      blocks.set(sidecar.batchRoot, block);
    }
    const id = passportId(sidecar.signed.passport);
    const receipt = input.receipts?.get(id);
    assets.push({
      signed: {
        passport: { ...sidecar.signed.passport, epoch: sidecar.signed.passport.epoch.toString() },
        signature: sidecar.signed.signature,
      },
      batchRoot: sidecar.batchRoot,
      proof: { index: sidecar.proof.index, siblings: [...sidecar.proof.siblings] },
      anchorBlock: block.toString(),
      ...(sidecar.attestation
        ? {
            attestation: {
              ...sidecar.attestation,
              capturedAt: sidecar.attestation.capturedAt.toString(),
            },
          }
        : {}),
      ...(sidecar.hardware ? { hardware: sidecar.hardware } : {}),
      ...(receipt
        ? {
            receipt: {
              receiptId: receipt.receiptId,
              grantId: receipt.grantId,
              blockNumber: receipt.blockNumber.toString(),
              txHash: receipt.txHash,
            },
          }
        : {}),
    });
  }
  const wire: LineageManifestWire = {
    version: 1,
    domain: {
      chainId: input.domain.chainId.toString(),
      verifyingContract: input.domain.verifyingContract,
    },
    principalId: input.principalId,
    ns: input.ns,
    generatedAt: (input.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))().toString(),
    // The anchor blocks are already in hand from the loop above, so the honest depth costs no reads.
    finalityDepth:
      input.finalityDepth ??
      (input.headBlock === undefined
        ? DEFAULT_MANIFEST_FINALITY
        : honestFinalityDepth(blocks.values(), input.headBlock)),
    assets,
  };
  return LineageManifestSchema.parse(wire);
}

export interface QueriesManifestInput {
  readonly domain: Eip712Domain;
  readonly results: readonly QueryResult[];
  /** The buyer's paying address, recorded on each receipt view (not part of the manifest itself). */
  readonly payer?: Address;
  readonly anchors: Pick<AnchorWriter, "anchorBlock">;
  /** See `SidecarManifestInput.headBlock`: the honest depth, computed from the anchors it collects. */
  readonly headBlock?: bigint;
  readonly finalityDepth?: number;
  readonly now?: () => bigint;
}

/**
 * The buyer's file: one asset per served query, each with the receipt the gateway wrote for it.
 * All results must be for one principal and namespace (one manifest per corpus); the grant id on
 * the receipt is the one the query was served under.
 */
export async function manifestFromQueries(input: QueriesManifestInput): Promise<LineageManifest> {
  const first = input.results[0];
  if (!first) throw new Error("no queries to export");
  const receipts = new Map<Bytes32, ReceiptView>();
  for (const r of input.results) {
    if (r.receipt.txHash === null || r.receipt.blockNumber === null) continue;
    receipts.set(r.passportId, {
      receiptId: r.receipt.receiptId,
      grantId: grantIdOf(r),
      payer: input.payer ?? "0x0000000000000000000000000000000000000000",
      ns: r.sidecar.ns,
      termsHash: r.signed.passport.termsHash,
      epoch: r.signed.passport.epoch,
      blockNumber: r.receipt.blockNumber,
      txHash: r.receipt.txHash,
    });
  }
  return manifestFromSidecars({
    domain: input.domain,
    principalId: first.sidecar.principalId,
    ns: first.sidecar.ns,
    sidecars: input.results.map((r) => r.sidecar),
    anchors: input.anchors,
    receipts,
    ...(input.headBlock === undefined ? {} : { headBlock: input.headBlock }),
    ...(input.finalityDepth === undefined ? {} : { finalityDepth: input.finalityDepth }),
    ...(input.now ? { now: input.now } : {}),
  });
}

/** The x402 resource the buyer paid for names the grant: `/v1/query/<grantId>/<passportId>`. */
function grantIdOf(result: QueryResult): Bytes32 {
  const m = /\/v1\/query\/(0x[0-9a-f]{64})\//i.exec(result.paid.requirements.resource);
  if (!m) throw new Error(`cannot tell which grant served ${result.passportId}`);
  return m[1]?.toLowerCase() as Bytes32;
}
