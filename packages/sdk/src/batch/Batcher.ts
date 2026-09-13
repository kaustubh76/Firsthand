import type { AnchorRef, AnchorRequest, AnchorWriter } from "@firsthand/adapters";
import {
  anchorStructHash,
  authorityDigest,
  BATCH_SIZE,
  type BatchProof,
  type Bytes32,
  buildTree,
  hashLeaf,
  type MerkleTree,
  passportId,
  proveIndex,
  RefusalError,
  type SignedPassport,
  ValidationError,
} from "@firsthand/core";
import { randomNonce, signPassportDigest } from "@firsthand/crypto";
import type { Locker } from "../locker/Locker.js";

/** One anchored batch: the root, its proofs, and where it landed. */
export interface AnchoredBatch {
  readonly ns: number;
  readonly epoch: bigint;
  readonly termsHash: Bytes32;
  readonly root: Bytes32;
  readonly tree: MerkleTree;
  readonly passports: readonly SignedPassport[];
  readonly proofs: ReadonlyMap<Bytes32, BatchProof>;
  readonly anchor: AnchorRef;
}

interface Pending {
  readonly key: string;
  readonly ns: number;
  readonly epoch: bigint;
  readonly termsHash: Bytes32;
  readonly items: SignedPassport[];
  readonly ids: Set<Bytes32>;
}

/**
 * Collects signed passports per `(ns, epoch, termsHash)` — one batch tree per anchor — and flushes
 * them as MIP-8 pages of ≤ 256 leaves (README §7.1, §7.4). Structural dedup: a passport id may
 * appear once across all pending and flushed batches (ADR-0005).
 */
export class Batcher {
  readonly #locker: Locker;
  readonly #anchors: AnchorWriter;
  readonly #pending = new Map<string, Pending>();
  readonly #seen = new Set<Bytes32>();
  readonly #flushed: AnchoredBatch[] = [];
  readonly #maxSize: number;

  constructor(
    locker: Locker,
    anchors: AnchorWriter = locker.anchors,
    maxSize: number = BATCH_SIZE,
  ) {
    if (maxSize < 1 || maxSize > BATCH_SIZE)
      throw new ValidationError(`batch size must be 1..${BATCH_SIZE}`);
    this.#locker = locker;
    this.#anchors = anchors;
    this.#maxSize = maxSize;
  }

  has(id: Bytes32): boolean {
    return this.#seen.has(id);
  }

  /** Adds a signed passport; flushes automatically when its batch is full. */
  async add(
    signed: SignedPassport,
    ns: number,
  ): Promise<{ id: Bytes32; flushed: AnchoredBatch | null }> {
    const id = passportId(signed.passport);
    if (this.#seen.has(id)) {
      throw new RefusalError("FH_REFUSED_DUPLICATE", "passport already deposited", {
        context: { passportId: id },
      });
    }
    const key = `${ns}:${signed.passport.epoch}:${signed.passport.termsHash}`;
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = {
        key,
        ns,
        epoch: signed.passport.epoch,
        termsHash: signed.passport.termsHash,
        items: [],
        ids: new Set(),
      };
      this.#pending.set(key, pending);
    }
    pending.items.push(signed);
    pending.ids.add(id);
    this.#seen.add(id);
    const flushed = pending.items.length >= this.#maxSize ? await this.flushOne(pending) : null;
    return { id, flushed };
  }

  /** Flushes every non-empty pending batch. */
  async flush(): Promise<AnchoredBatch[]> {
    const out: AnchoredBatch[] = [];
    for (const pending of [...this.#pending.values()]) {
      if (pending.items.length > 0) out.push(await this.flushOne(pending));
    }
    return out;
  }

  pendingCount(): number {
    let n = 0;
    for (const p of this.#pending.values()) n += p.items.length;
    return n;
  }

  flushed(): readonly AnchoredBatch[] {
    return this.#flushed;
  }

  /** Proof for an already-flushed passport, if any. */
  proofFor(id: Bytes32): { batch: AnchoredBatch; proof: BatchProof } | null {
    for (const batch of this.#flushed) {
      const proof = batch.proofs.get(id);
      if (proof) return { batch, proof };
    }
    return null;
  }

  private async flushOne(pending: Pending): Promise<AnchoredBatch> {
    const passports = [...pending.items];
    const ids = passports.map((p) => passportId(p.passport));
    const tree = buildTree(ids.map(hashLeaf));
    const proofs = new Map<Bytes32, BatchProof>();
    ids.forEach((id, i) => {
      proofs.set(id, proveIndex(tree, i));
    });

    const depositKey = this.#locker.depositKey(pending.ns, pending.epoch);
    const nonce = randomNonce();
    const structHash = anchorStructHash({
      principalId: this.#locker.principalId,
      ns: pending.ns,
      epoch: pending.epoch,
      batchRoot: tree.root,
      termsHash: pending.termsHash,
      nonce,
    });
    const request: AnchorRequest = {
      principalId: this.#locker.principalId,
      ns: pending.ns,
      epoch: pending.epoch,
      batchRoot: tree.root,
      termsHash: pending.termsHash,
      nonce,
      depositKeys: this.#locker.depositAddresses(pending.epoch),
      depositSig: signPassportDigest(
        depositKey.privateKey,
        authorityDigest(structHash, this.#locker.domain),
      ),
    };
    const anchor = await this.#anchors.anchor(request);
    const batch: AnchoredBatch = {
      ns: pending.ns,
      epoch: pending.epoch,
      termsHash: pending.termsHash,
      root: tree.root,
      tree,
      passports,
      proofs,
      anchor,
    };
    this.#flushed.push(batch);
    this.#pending.delete(pending.key);
    this.#locker.logger.info("batch anchored", {
      ns: pending.ns,
      epoch: pending.epoch.toString(),
      size: passports.length,
      root: tree.root,
    });
    return batch;
  }
}
