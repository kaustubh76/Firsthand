import type {
  AnchorWriter,
  BlobStore,
  GrantReader,
  PassportCatalog,
  PaymentPayload,
  PaymentRequirements,
  Settlement,
} from "@firsthand/adapters";
import {
  type Bytes32,
  type Eip712Domain,
  GrantError,
  hashTerms,
  NotFoundError,
  type PassportSidecar,
  ProofError,
  passportId,
  sidecarToWire,
  ValidationError,
  VerifyFailure,
  type VerifyResult,
  verifyPassportInBatch,
  verifyPassportSignature,
  verifyPredicate,
} from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";

/**
 * The serving path (README §11/§12): verified ingest, then every served query is gated by `verify()`
 * and paid via x402. Holds adapters only — no keys, no plaintext (ADR-0011).
 */
export interface ServingDeps {
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly catalog: PassportCatalog;
  readonly grants: GrantReader;
  readonly settlement: Settlement;
  readonly domain: Eip712Domain;
  readonly logger: Logger;
}

export interface ServeRequest {
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
  readonly payment: PaymentPayload;
  readonly requirements: PaymentRequirements;
}

export interface ServedQuery {
  readonly passportId: Bytes32;
  readonly sidecar: ReturnType<typeof sidecarToWire>;
  /** Ciphertext and wrapped DEK, hex. The buyer unwraps with the vault key from the grant wrap. */
  readonly blob: `0x${string}`;
  readonly wrappedDek: `0x${string}`;
  readonly receipt: { receiptId: Bytes32; txHash: Bytes32 | null; blockNumber: string | null };
}

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export class Serving {
  readonly #d: ServingDeps;

  constructor(deps: ServingDeps) {
    this.#d = deps;
  }

  // ── ingest ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Accepts a sidecar only if it is self-authenticating: signature verifies under this deployment's
   * domain, the root is anchored, the anchor belongs to the claimed principal/namespace, and the
   * passport is included at `proof.index`. Nothing about the uploader matters.
   */
  async ingestPassport(sidecar: PassportSidecar): Promise<Bytes32> {
    const id = passportId(sidecar.signed.passport);
    if (
      !verifyPassportSignature(sidecar.signed.passport, sidecar.signed.signature, this.#d.domain)
    ) {
      throw new ProofError(
        "FH_SIG_INVALID",
        "passport signature does not verify under this gateway's domain",
        { context: { passportId: id } },
      );
    }
    if (hashTerms(sidecar.terms) !== sidecar.signed.passport.termsHash) {
      throw new ValidationError("sidecar terms do not hash to the passport's termsHash", {
        context: { passportId: id },
      });
    }
    if (!(await this.#d.anchors.isAnchored(sidecar.batchRoot))) {
      throw new ProofError("FH_MERKLE_INVALID", "batch root is not anchored", {
        context: { batchRoot: sidecar.batchRoot },
      });
    }
    const owner = await this.#d.anchors.anchorOf(sidecar.batchRoot);
    if (owner && (owner.principalId !== sidecar.principalId || owner.ns !== sidecar.ns)) {
      throw new ProofError(
        "FH_MERKLE_INVALID",
        "batch root was anchored by a different principal or namespace",
        {
          context: {
            batchRoot: sidecar.batchRoot,
            principalId: sidecar.principalId,
            ns: sidecar.ns,
          },
        },
      );
    }
    if (!verifyPassportInBatch(sidecar.batchRoot, id, sidecar.proof)) {
      throw new ProofError("FH_MERKLE_INVALID", "passport is not included at proof.index", {
        context: { passportId: id },
      });
    }
    await this.#d.catalog.put(sidecar);
    this.#d.logger.info("passport ingested", { passportId: id, batchRoot: sidecar.batchRoot });
    return id;
  }

  async ingestBlob(bytes: Uint8Array): Promise<{ id: `0x${string}`; size: number }> {
    const ref = await this.#d.blobs.put(bytes);
    return { id: ref.id, size: ref.size };
  }

  /** Stores grant wrap bytes only if their hash equals the on-chain wrap reference. */
  async ingestWrap(grantId: Bytes32, bytes: Uint8Array): Promise<Bytes32> {
    const g = await this.#d.grants.grantState(grantId);
    if (!g) throw new NotFoundError(`unknown grant ${grantId}`);
    const ref = await this.#d.blobs.put(bytes);
    if (ref.id !== g.wrapRef) {
      throw new ValidationError("wrap bytes do not hash to the grant's wrap reference", {
        context: { grantId, expected: g.wrapRef, actual: ref.id },
      });
    }
    return ref.id;
  }

  async wrapFor(grantId: Bytes32): Promise<Uint8Array> {
    const g = await this.#d.grants.grantState(grantId);
    if (!g) throw new NotFoundError(`unknown grant ${grantId}`);
    const bytes = await this.#d.blobs.get(g.wrapRef);
    if (!bytes) throw new NotFoundError(`wrap for grant ${grantId} has not been published`);
    return bytes;
  }

  // ── serve ───────────────────────────────────────────────────────────────────────────────────

  /**
   * What a principal has published, with the fields a buyer decides on: namespace, epoch, price,
   * terms. Ids come from the catalog's index; each sidecar is one catalog read.
   */
  async passportsOf(
    principalId: Bytes32,
    options: { ns?: number; limit: number },
  ): Promise<
    {
      passportId: Bytes32;
      ns: number;
      epoch: bigint;
      batchRoot: Bytes32;
      termsHash: Bytes32;
      price: bigint;
    }[]
  > {
    const ids = await this.#d.catalog.listByPrincipal(principalId);
    const out = [];
    for (const id of ids) {
      if (out.length >= options.limit) break;
      const s = await this.#d.catalog.get(id);
      if (!s || (options.ns !== undefined && s.ns !== options.ns)) continue;
      out.push({
        passportId: id,
        ns: s.ns,
        epoch: s.signed.passport.epoch,
        batchRoot: s.batchRoot,
        termsHash: s.signed.passport.termsHash,
        price: s.terms.price,
      });
    }
    return out;
  }

  async sidecar(id: Bytes32): Promise<PassportSidecar> {
    const s = await this.#d.catalog.get(id);
    if (!s) throw new NotFoundError(`unknown passport ${id}`);
    return s;
  }

  /** verify() → settle → serve. Settlement happens after the predicate so a dead grant never gets charged. */
  async serve(request: ServeRequest): Promise<ServedQuery> {
    const sidecar = await this.sidecar(request.passportId);
    const verdict = await this.verify(sidecar, request.grantId);
    if (!verdict.ok) throw refusal(verdict.reason, request.grantId, request.passportId);

    const settled = await this.#d.settlement.settle({
      grantId: request.grantId,
      terms: sidecar.terms,
      payment: request.payment,
    });
    const [blob, wrappedDek] = await Promise.all([
      this.#d.blobs.get(sidecar.blobRef),
      this.#d.blobs.get(sidecar.wrappedDekRef),
    ]);
    if (!blob || !wrappedDek) {
      throw new NotFoundError("ciphertext for this passport is not hosted here", {
        context: { passportId: request.passportId },
      });
    }
    this.#d.logger.info("query served", {
      grantId: request.grantId,
      passportId: request.passportId,
      receipt: settled.receiptId,
    });
    return {
      passportId: request.passportId,
      sidecar: sidecarToWire(sidecar),
      blob: toHex(blob),
      wrappedDek: toHex(wrappedDek),
      receipt: {
        receiptId: settled.receiptId,
        txHash: settled.txHash,
        blockNumber: settled.blockNumber?.toString() ?? null,
      },
    };
  }

  /** The one call, composed from chain reads (README §7.3). */
  async verify(sidecar: PassportSidecar, grantId: Bytes32): Promise<VerifyResult> {
    const g = await this.#d.grants.grantState(grantId);
    const epochNow = await this.#d.grants.currentEpoch();
    if (!g) {
      return {
        ok: false,
        reason: VerifyFailure.GRANT_NOT_LIVE,
        passportId: passportId(sidecar.signed.passport),
      };
    }
    const [rootAnchored, owner, liveness] = await Promise.all([
      this.#d.anchors.isAnchored(sidecar.batchRoot),
      this.#d.anchors.anchorOf(sidecar.batchRoot),
      this.#d.grants.principalLiveness(g.principalId),
    ]);
    return verifyPredicate({
      passport: sidecar.signed.passport,
      signature: sidecar.signed.signature,
      domain: this.#d.domain,
      proof: sidecar.proof,
      batchRoot: sidecar.batchRoot,
      rootAnchored,
      ...(owner ? { anchorOwner: { principalId: owner.principalId, ns: owner.ns } } : {}),
      grant: {
        status: g.status,
        epochStart: g.epochStart,
        term: g.term,
        termsHash: g.termsHash,
        principalId: g.principalId,
        ns: g.ns,
      },
      principal: liveness ?? { lastAttestedEpoch: -1n },
      epochNow,
    });
  }

  blob(id: `0x${string}`): Promise<Uint8Array | null> {
    return this.#d.blobs.get(id);
  }

  isAnchored(root: Bytes32): Promise<boolean> {
    return this.#d.anchors.isAnchored(root);
  }
}

function refusal(reason: VerifyFailure, grantId: Bytes32, passportId: Bytes32) {
  const context = { grantId, passportId, reason };
  switch (reason) {
    case VerifyFailure.SIG_INVALID:
      return new ProofError("FH_SIG_INVALID", "passport signature invalid", { context });
    case VerifyFailure.MERKLE_INVALID:
    case VerifyFailure.ROOT_UNKNOWN:
      return new ProofError("FH_MERKLE_INVALID", `passport inclusion failed: ${reason}`, {
        context,
      });
    case VerifyFailure.GRANT_RESCINDED:
      return new GrantError("FH_GRANT_RESCINDED", "consent for this grant has been withdrawn", {
        context,
      });
    case VerifyFailure.GRANT_EXPIRED:
      return new GrantError("FH_GRANT_EXPIRED", "grant term has ended", { context });
    case VerifyFailure.GRANT_FROZEN:
      return new GrantError("FH_GRANT_FROZEN", "principal has not re-attested; grant is frozen", {
        context,
      });
    default:
      return new GrantError("FH_GRANT_NOT_LIVE", `grant does not cover this passport: ${reason}`, {
        context,
      });
  }
}
