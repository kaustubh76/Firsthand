import type {
  AnchorWriter,
  BlobStore,
  DeviceRegistryReader,
  Erc8004Registry,
  Erc8004Writer,
  GrantReader,
  PassportCatalog,
  PaymentPayload,
  PaymentRequirements,
  Settlement,
} from "@firsthand/adapters";
import {
  classifySendError,
  deviceIsLive,
  FEEDBACK_TAG1,
  FEEDBACK_TAG2_PAID,
  messagesOf,
} from "@firsthand/adapters";
import {
  AttestationClass,
  type Bytes32,
  deviceKeyCommitment,
  type Eip712Domain,
  FirsthandError,
  type Freshness,
  freshnessOf,
  GrantError,
  hardwareCaptureDigest,
  hashAttestation,
  hashTerms,
  NotFoundError,
  type PassportSidecar,
  ProofError,
  passportId,
  sidecarToWire,
  ValidationError,
  VerifiedBootState,
  VerifyFailure,
  type VerifyResult,
  verifyCaptureWitness,
  verifyPassportInBatch,
  verifyPassportSignature,
  verifyPredicate,
} from "@firsthand/core";
import { type Logger, withRetry } from "@firsthand/runtime";

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
  /**
   * `HardwareDeviceRegistry`, for class-3 ingest (ADR-0015). **Absence refuses class 3** rather
   * than waving it through: a gateway that cannot ask whether a key is hardware-backed has no
   * business hosting a passport that says it is. Classes 0-2 are unaffected.
   */
  readonly devices?: DeviceRegistryReader;
  /**
   * Refuse a device whose recorded verified-boot state is not Verified. The chain stores that
   * state without enforcing it (ADR-0015), so this is the only place the question is actually
   * decided — and saying which side decides it beats implying the chain did.
   */
  readonly requireVerifiedBoot?: boolean;
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

/**
 * The outcome of the last reputation feedback this instance attempted. Feedback runs off the response
 * path, so a failure has nowhere to surface: `logger.warn` on a serverless host is a line nobody
 * reads, and the only external symptom is an agent that was never credited. Measured on the hosted
 * gateway 2026-09-27: two consecutive live runs credited nothing, and from outside the function the
 * evidence was indistinguishable from the feature being switched off. `/healthz` reports this, so the
 * next such failure names its own reason.
 */
export interface FeedbackOutcome {
  readonly at: number;
  readonly agentId: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export class Serving {
  readonly #d: ServingDeps;
  #lastFeedback: FeedbackOutcome | null = null;

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
    await this.#refuseUnlessWitnessed(sidecar, id);
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
  /**
   * The class-3 gate (ADR-0015). This is the enforcement point that matters: a locker checks its
   * own deposits, but a buyer trusts the gateway, and the sidecar is the first place the
   * attestation preimage and the witness are both in hand.
   *
   * What is checked: the witness exists, its key is the device the attestation names, the
   * signature verifies over `hardwareCaptureDigest` — which binds origin and nonce, so a witness
   * lifted from another locker's deposit cannot be replayed here — and the chain says that device
   * is registered to this principal and not revoked.
   */
  async #refuseUnlessWitnessed(sidecar: PassportSidecar, id: Bytes32): Promise<void> {
    const attestation = sidecar.attestation;
    if (attestation?.class !== AttestationClass.HARDWARE) {
      // A witness without a class-3 attestation is not an error, but it is not evidence either;
      // saying so beats storing it where a reader might mistake it for a checked one.
      if (sidecar.hardware) {
        throw new ValidationError("a hardware witness on a passport that does not claim class 3", {
          context: { passportId: id },
        });
      }
      return;
    }
    const refuse = (message: string): never => {
      throw new FirsthandError("FH_REFUSED_HARDWARE", message, { context: { passportId: id } });
    };
    const witness = sidecar.hardware;
    if (!witness) refuse("a class-3 passport carries no secure-element witness");
    const w = witness as NonNullable<typeof witness>;
    if (deviceKeyCommitment(w.publicKey) !== attestation.deviceClass) {
      refuse("the witness key is not the device this attestation names");
    }
    const digest = hardwareCaptureDigest({
      chainId: this.#d.domain.chainId,
      origin: sidecar.signed.passport.origin,
      contentHash: sidecar.signed.passport.h,
      capturedAt: attestation.capturedAt,
      nonce: sidecar.signed.passport.nonce,
      deviceClass: attestation.deviceClass,
    });
    if (!verifyCaptureWitness(digest, w.signature, w.publicKey)) {
      refuse("the secure-element witness does not verify over this passport");
    }
    if (!this.#d.devices) {
      refuse("this gateway cannot reach a device registry, so it will not host a class-3 passport");
    }
    const device = await (this.#d.devices as DeviceRegistryReader).device(attestation.deviceClass);
    if (!deviceIsLive(device, sidecar.principalId)) {
      refuse("the signing device is not registered to this principal, or has been revoked");
    }
    // The chain records the boot state and does not act on it. This is where it is acted on, or
    // deliberately not — and which of the two is a gateway's published choice, not a silence.
    const live = device as NonNullable<typeof device>;
    if (
      this.#d.requireVerifiedBoot &&
      (!live.hasRootOfTrust || live.verifiedBootState !== VerifiedBootState.VERIFIED)
    ) {
      refuse("this gateway serves only devices whose verified-boot state is Verified");
    }
  }

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
    const retrying = (label: string, retryOn: (error: unknown) => boolean) => ({
      retries: 4,
      baseMs: 400,
      maxMs: 4_000,
      retryOn,
      onRetry: (error: unknown, attempt: number, delayMs: number) =>
        this.#d.logger.info(`reputation ${label}: rpc busy, retrying`, {
          agentId: agentId.toString(),
          attempt,
          delayMs,
          detail: messagesOf(error)[0],
        }),
    });
    try {
      // Four chain reads, and they land in the same second as the query that triggered them.
      // Monad's public RPC allows 15 requests per second from a hosted function's shared egress and
      // answers the rest with a JSON-RPC error — which viem does not retry, because it is a 200 at
      // the HTTP layer. Measured 2026-09-24: a live paid query credited nothing because
      // `getMetadata(agentId, "firsthand.card")` was refused mid-burst and this catch logged a
      // warning nobody reads. Reads are free to repeat, and this runs off the response path, so it
      // waits the window out.
      const bound = await withRetry(
        async () => {
          const g = await this.#d.grants.grantState(grantId);
          const card = g ? await this.#d.grants.cardOf(g.granteeCard) : null;
          if (!g || !card) return null;
          const ok = await rep.registry.verifyCardBinding(agentId, g.granteeCard, card.owner);
          return { ok, cardId: g.granteeCard };
        },
        retrying("binding", (error) => classifySendError(error).kind === "rpc"),
      );
      if (bound === null) return;
      if (!bound.ok) {
        this.#lastFeedback = {
          at: Date.now(),
          agentId: agentId.toString(),
          ok: false,
          detail: "agent is not bound to the grant's card",
        };
        this.#d.logger.warn("agent is not bound to the grant's card; no feedback", {
          agentId: agentId.toString(),
          grantId,
        });
        return;
      }
      // The send retries only on rate limiting, never on a timeout. A rate-limited call is refused
      // by the RPC before the transaction reaches a mempool, so repeating it cannot file twice; a
      // timeout could have been a broadcast whose reply was lost, and crediting an agent twice is a
      // worse lie than crediting it late.
      const txHash = await withRetry(
        () =>
          rep.registry.giveFeedback({
            agentId,
            value: 1n,
            tag1: FEEDBACK_TAG1,
            tag2: FEEDBACK_TAG2_PAID,
            endpoint: rep.publicUrl,
            feedbackURI: `${rep.publicUrl}/v1/grants/${grantId}/receipts`,
            feedbackHash: receiptId,
          }),
        retrying("feedback", isRateLimited),
      );
      this.#lastFeedback = { at: Date.now(), agentId: agentId.toString(), ok: true };
      this.#d.logger.info("reputation feedback", { agentId: agentId.toString(), grantId, txHash });
    } catch (error) {
      this.#lastFeedback = {
        at: Date.now(),
        agentId: agentId.toString(),
        ok: false,
        detail: messagesOf(error)[0] ?? String(error),
      };
      this.#d.logger.warn("reputation feedback failed", {
        agentId: agentId.toString(),
        grantId,
        error,
      });
    }
  }

  /** What became of the last feedback attempt, for `/healthz`. Null when none has been tried. */
  get lastFeedback(): FeedbackOutcome | null {
    return this.#lastFeedback;
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

/**
 * Monad's public RPC answers a request over its per-second window with a JSON-RPC error carrying
 * "requests limited to 15/sec", not an HTTP 429 — so viem sees a 200 and does not retry. This is
 * narrower than `classifySendError(...).kind === "rpc"` on purpose: it excludes timeouts, which
 * may have been broadcast, so it is the only class of failure a *write* may safely repeat.
 */
function isRateLimited(error: unknown): boolean {
  return /rate limit|too many requests|requests limited|request limit|\b429\b/i.test(
    messagesOf(error).join(" | "),
  );
}
