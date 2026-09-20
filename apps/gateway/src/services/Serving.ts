import type {
  AnchorWriter,
  BlobStore,
  Erc8004Registry,
  Erc8004Writer,
  GrantReader,
  PassportCatalog,
  PaymentPayload,
  PaymentRequirements,
  Settlement,
} from "@firsthand/adapters";
import { FEEDBACK_TAG1, FEEDBACK_TAG2_PAID } from "@firsthand/adapters";
import {
  type AttestationClass,
  type Bytes32,
  type Eip712Domain,
  type Freshness,
  freshnessOf,
  GrantError,
  hashAttestation,
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
  /**
   * Block timestamp lookup for the freshness signal (README §7.3): the newest anchor's block in a
   * namespace dates its last deposit. Absent on gateways without a chain (memory mode).
   */
  readonly blockTime?: (blockNumber: bigint) => Promise<bigint | null>;
  /** Half-life for the staleness curve, seconds; defaults to one epoch. */
  readonly halfLifeSeconds?: bigint;
  readonly now?: () => bigint;
  /**
   * ERC-8004 (README §5): when a buyer identifies as an agent and the agent provably owns the
   * grant's card, every paid query becomes one unit of `firsthand/paid-query` feedback from this
   * gateway — receipts feeding the agent's reputation surface. Absent on chains without registries.
   */
  readonly reputation?: {
    readonly registry: Erc8004Registry & Erc8004Writer;
    readonly publicUrl: string;
    /**
     * Keeps background work alive after the response on hosts that freeze the process once it
     * has answered (serverless): Vercel's `waitUntil`. Defaults to fire-and-forget.
     */
    readonly defer?: (work: Promise<unknown>) => void;
  };
}

export interface ServeRequest {
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
  readonly payment: PaymentPayload;
  readonly requirements: PaymentRequirements;
  /** The buyer's ERC-8004 agent id, when it wants this paid query on its reputation. */
  readonly agentId?: bigint;
}

export interface ServedQuery {
  readonly passportId: Bytes32;
  readonly sidecar: ReturnType<typeof sidecarToWire>;
  /** Ciphertext and wrapped DEK, hex. The buyer unwraps with the vault key from the grant wrap. */
  readonly blob: `0x${string}`;
  readonly wrappedDek: `0x${string}`;
  readonly receipt: { receiptId: Bytes32; txHash: Bytes32 | null; blockNumber: string | null };
}

/** One row of `GET /v1/principals/:id/passports` — what a buyer decides on. */
export interface ListedPassport {
  readonly passportId: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
  readonly batchRoot: Bytes32;
  readonly termsHash: Bytes32;
  readonly price: bigint;
  /** Attestation class when the sidecar carries the preimage; null for older sidecars. */
  readonly class: AttestationClass | null;
  readonly capturedAt: bigint | null;
  readonly sourceTag: Bytes32 | null;
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
    // The attestation preimage is optional on the wire but never wrong: a buyer will filter on it.
    if (
      sidecar.attestation &&
      hashAttestation(sidecar.attestation) !== sidecar.signed.passport.attest
    ) {
      throw new ValidationError("sidecar attestation does not hash to the passport's attest", {
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
   * terms, and — when the sidecar carries the preimage — the attestation class, capture time and
   * source tag (README §13: buyers filter by class). Ids come from the catalog's index; each
   * sidecar is one catalog read. `freshness` per namespace dates the newest anchor seen.
   */
  async passportsOf(
    principalId: Bytes32,
    options: { ns?: number; class?: AttestationClass; limit: number },
  ): Promise<{ passports: ListedPassport[]; freshness: Record<number, Freshness> }> {
    const ids = await this.#d.catalog.listByPrincipal(principalId);
    const passports: ListedPassport[] = [];
    const newest = new Map<number, { root: Bytes32; epoch: bigint }>();
    for (const id of ids) {
      const s = await this.#d.catalog.get(id);
      if (!s || (options.ns !== undefined && s.ns !== options.ns)) continue;
      const seen = newest.get(s.ns);
      if (!seen || s.signed.passport.epoch >= seen.epoch) {
        newest.set(s.ns, { root: s.batchRoot, epoch: s.signed.passport.epoch });
      }
      if (options.class !== undefined && s.attestation?.class !== options.class) continue;
      if (passports.length >= options.limit) continue;
      passports.push({
        passportId: id,
        ns: s.ns,
        epoch: s.signed.passport.epoch,
        batchRoot: s.batchRoot,
        termsHash: s.signed.passport.termsHash,
        price: s.terms.price,
        class: s.attestation?.class ?? null,
        capturedAt: s.attestation?.capturedAt ?? null,
        sourceTag: s.attestation?.sourceTag ?? null,
      });
    }
    const now = (this.#d.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
    const freshness: Record<number, Freshness> = {};
    for (const [ns, { root }] of newest) {
      freshness[ns] = freshnessOf(
        await this.#lastAnchoredAt(root, ns, principalId),
        now,
        this.#d.halfLifeSeconds,
      );
    }
    return { passports, freshness };
  }

  /**
   * The newest anchor's block timestamp for a namespace. The catalog's "newest" is by epoch; within
   * an epoch the ledger's anchors (when available) would refine it — one block read is the honest
   * cheap answer, and it is what the signal is defined on.
   */
  async #lastAnchoredAt(root: Bytes32, _ns: number, _principalId: Bytes32): Promise<bigint | null> {
    if (!this.#d.blockTime) return null;
    const block = await this.#d.anchors.anchorBlock(root).catch(() => null);
    if (block === null) return null;
    return this.#d.blockTime(block).catch(() => null);
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
    if (request.agentId !== undefined) {
      // Off the response path: the buyer has its data; the feedback lands when it lands. A
      // serverless host must be told to keep the process alive for it (deps.reputation.defer).
      const work = this.#feedback(request.agentId, request.grantId, settled.receiptId);
      (this.#d.reputation?.defer ?? (() => undefined))(work);
    }
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

  /**
   * One paid, honoured query → one unit of feedback on the agent, given by this gateway. Only when
   * the agent provably owns the grant's card: metadata names the card and the agent's owner is the
   * card's owner — a stranger cannot pin queries on someone else's identity.
   */
  async #feedback(agentId: bigint, grantId: Bytes32, receiptId: Bytes32): Promise<void> {
    const rep = this.#d.reputation;
    if (!rep) return;
    try {
      const g = await this.#d.grants.grantState(grantId);
      const card = g ? await this.#d.grants.cardOf(g.granteeCard) : null;
      if (!g || !card) return;
      const bound = await rep.registry.verifyCardBinding(agentId, g.granteeCard, card.owner);
      if (!bound) {
        this.#d.logger.warn("agent is not bound to the grant's card; no feedback", {
          agentId: agentId.toString(),
          grantId,
        });
        return;
      }
      const txHash = await rep.registry.giveFeedback({
        agentId,
        value: 1n,
        tag1: FEEDBACK_TAG1,
        tag2: FEEDBACK_TAG2_PAID,
        endpoint: rep.publicUrl,
        feedbackURI: `${rep.publicUrl}/v1/grants/${grantId}/receipts`,
        feedbackHash: receiptId,
      });
      this.#d.logger.info("reputation feedback", { agentId: agentId.toString(), grantId, txHash });
    } catch (error) {
      this.#d.logger.warn("reputation feedback failed", { agentId: agentId.toString(), error });
    }
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
