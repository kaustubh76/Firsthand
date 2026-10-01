import type { BlobRef } from "@firsthand/adapters";
import {
  type Attestation,
  AttestationClass,
  type Bytes32,
  contentHash,
  type Datum,
  deviceKeyCommitment,
  type HardwareWitness,
  hardwareCaptureDigest,
  hashAttestation,
  hashTerms,
  type Passport,
  passportDigest,
  passportId,
  RefusalError,
  type SignedPassport,
  type Terms,
  ValidationError,
  verifyCaptureWitness,
  verifyPassportSignature,
} from "@firsthand/core";
import { generateDek, sealBlob, signPassportDigest, wrapDek } from "@firsthand/crypto";
import type { AnchoredBatch, Batcher } from "../batch/Batcher.js";
import type { Locker } from "../locker/Locker.js";

/**
 * `deposit` (README §7.1): mint a passport, refuse it if unprovable, seal the plaintext, wrap the
 * DEK to the namespace-epoch vault key, and hand the signed passport to the batcher.
 *
 * Plaintext enters this function and leaves only as ciphertext. The gateway never runs it.
 */
export interface DepositInput {
  readonly ns: number;
  readonly datum: Datum;
  /** Bytes to seal — defaults to the datum's own bytes / canonical JSON. */
  readonly plaintext?: Uint8Array;
  readonly terms: Terms;
  readonly attestation: Attestation;
  /** Required when `attestation.class` is `HARDWARE`: the secure element's witness (ADR-0015). */
  readonly hardware?: HardwareWitness;
  /** Override the epoch (tests / imports); defaults to the locker's current epoch. */
  readonly epoch?: bigint;
}

/**
 * The attestation preimage, and the witness when there is one.
 *
 * The refusal gate needs this because a `Passport` carries only `attest`, the *hash* — there is no
 * way to tell a class-3 passport from a class-0 one by looking at it. A caller that cannot supply
 * the preimage gets the origin checks and nothing more, and the gateway refuses the deposit at
 * ingest, where the sidecar always carries it.
 */
export interface AttestationClaim {
  readonly attestation: Attestation;
  readonly hardware?: HardwareWitness;
}

export interface DepositResult {
  readonly passportId: Bytes32;
  readonly signed: SignedPassport;
  readonly blob: BlobRef;
  readonly wrappedDek: BlobRef;
  /** Set when this deposit completed a batch. */
  readonly anchored: AnchoredBatch | null;
  /** The attestation preimage, when this locker minted the passport (it travels in the sidecar). */
  readonly attestation?: Attestation;
  /** The secure-element witness, when this was a class-3 deposit (it travels in the sidecar too). */
  readonly hardware?: HardwareWitness;
}

/** Sidecar record the locker keeps per passport (public data + ciphertext locators). */
export interface PassportSidecar {
  readonly signed: SignedPassport;
  readonly ns: number;
  readonly blob: BlobRef;
  readonly wrappedDek: BlobRef;
}

function datumBytes(datum: Datum): Uint8Array {
  if (datum.kind === "bytes") return datum.bytes;
  return new TextEncoder().encode(JSON.stringify(datum.value));
}

/** Mints and signs a passport for the locker's own data. */
export function mintPassport(locker: Locker, input: DepositInput): SignedPassport {
  if (!locker.hasNamespace(input.ns)) {
    throw new ValidationError(`unknown namespace ${input.ns}`, { context: { ns: input.ns } });
  }
  if (input.terms.ns !== input.ns) {
    throw new ValidationError("terms.ns must match the deposit namespace", {
      context: { ns: input.ns, termsNs: input.terms.ns },
    });
  }
  const epoch = input.epoch ?? locker.currentEpoch();
  const h = contentHash(input.datum);
  const depositKey = locker.depositKey(input.ns, epoch);
  const passport: Passport = {
    h,
    origin: depositKey.address,
    attest: hashAttestation(input.attestation),
    termsHash: hashTerms(input.terms),
    epoch,
    nonce: locker.keys.passportNonce(input.ns, epoch, h),
  };
  const signature = signPassportDigest(
    depositKey.privateKey,
    passportDigest(passport, locker.domain),
  );
  return { passport, signature };
}

/**
 * Deposit-time refusal — "the locker that turns data away". A passport is accepted only if its
 * signature verifies under this deployment's domain AND its origin is a deposit key this locker
 * can derive for the passport's epoch. Anything else is `FH_REFUSED_ORIGIN`.
 */
export function refuseUnlessProvable(
  locker: Locker,
  signed: SignedPassport,
  ns: number,
  claim?: AttestationClaim,
): Bytes32 {
  const id = passportId(signed.passport);
  if (!verifyPassportSignature(signed.passport, signed.signature, locker.domain)) {
    throw new RefusalError("FH_REFUSED_ORIGIN", "passport signature does not verify", {
      context: { passportId: id },
    });
  }
  if (!locker.isOwnOrigin(signed.passport.origin, ns, signed.passport.epoch)) {
    throw new RefusalError(
      "FH_REFUSED_ORIGIN",
      "passport origin is not an enrolled deposit key of this locker",
      {
        context: {
          passportId: id,
          origin: signed.passport.origin,
          ns,
          epoch: signed.passport.epoch.toString(),
        },
      },
    );
  }
  if (claim) refuseUnlessWitnessed(locker, signed, claim, id);
  return id;
}

/**
 * The class-3 half of the gate: a passport may only *say* hardware if a secure element signed it.
 *
 * Checks the claim is the preimage the passport committed to (otherwise a class-2 claim could be
 * waved past a class-3 passport), that the witness key is the device the attestation names, and
 * that the signature verifies over `hardwareCaptureDigest` — which binds the origin and nonce, so
 * a witness lifted from another locker's deposit cannot be replayed here.
 */
function refuseUnlessWitnessed(
  locker: Locker,
  signed: SignedPassport,
  claim: AttestationClaim,
  id: Bytes32,
): void {
  if (hashAttestation(claim.attestation) !== signed.passport.attest) {
    throw new ValidationError("attestation claim is not the preimage this passport commits to", {
      context: { passportId: id },
    });
  }
  if (claim.attestation.class !== AttestationClass.HARDWARE) return;

  const refuse = (message: string): never => {
    throw new RefusalError("FH_REFUSED_HARDWARE", message, { context: { passportId: id } });
  };
  const witness = claim.hardware;
  if (!witness) refuse("a class-3 passport carries no secure-element witness");
  const w = witness as HardwareWitness;
  if (deviceKeyCommitment(w.publicKey) !== claim.attestation.deviceClass) {
    refuse("the witness key is not the device this attestation names");
  }
  const digest = hardwareCaptureDigest({
    chainId: locker.domain.chainId,
    origin: signed.passport.origin,
    contentHash: signed.passport.h,
    capturedAt: claim.attestation.capturedAt,
    nonce: signed.passport.nonce,
    deviceClass: claim.attestation.deviceClass,
  });
  if (!verifyCaptureWitness(digest, w.signature, w.publicKey)) {
    refuse("the secure-element witness does not verify over this passport");
  }
}

export async function deposit(
  locker: Locker,
  batcher: Batcher,
  input: DepositInput,
): Promise<DepositResult> {
  const signed = mintPassport(locker, input);
  const result = await acceptSigned(
    locker,
    batcher,
    signed,
    input.ns,
    input.plaintext ?? datumBytes(input.datum),
    { attestation: input.attestation, ...(input.hardware ? { hardware: input.hardware } : {}) },
  );
  return {
    ...result,
    attestation: input.attestation,
    ...(input.hardware ? { hardware: input.hardware } : {}),
  };
}

/**
 * Accepts an already-signed passport (from a capture device or importer that holds the same key
 * tree) together with its plaintext. Runs the refusal gate, seals, wraps and batches.
 */
export async function acceptSigned(
  locker: Locker,
  batcher: Batcher,
  signed: SignedPassport,
  ns: number,
  plaintext: Uint8Array,
  claim?: AttestationClaim,
): Promise<DepositResult> {
  const id = refuseUnlessProvable(locker, signed, ns, claim);
  if (batcher.has(id)) {
    throw new RefusalError("FH_REFUSED_DUPLICATE", "passport already deposited", {
      context: { passportId: id },
    });
  }

  const epoch = signed.passport.epoch;
  const dek = generateDek();
  const vault = locker.keys.vaultKey(ns, epoch);
  try {
    const blob = await locker.blobs.put(sealBlob(dek, plaintext, id));
    const wrappedDek = await locker.blobs.put(wrapDek(vault, dek, id, ns, epoch));
    const { flushed } = await batcher.add(signed, ns);
    locker.logger.info("deposited", { passportId: id, ns, epoch: epoch.toString(), blob: blob.id });
    return { passportId: id, signed, blob, wrappedDek, anchored: flushed };
  } finally {
    dek.dispose();
    vault.dispose();
  }
}
