import type { BlobRef } from "@firsthand/adapters";
import {
  type Attestation,
  type Bytes32,
  contentHash,
  type Datum,
  hashAttestation,
  hashTerms,
  type Passport,
  passportDigest,
  passportId,
  RefusalError,
  type SignedPassport,
  type Terms,
  ValidationError,
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
  /** Override the epoch (tests / imports); defaults to the locker's current epoch. */
  readonly epoch?: bigint;
}

export interface DepositResult {
  readonly passportId: Bytes32;
  readonly signed: SignedPassport;
  readonly blob: BlobRef;
  readonly wrappedDek: BlobRef;
  /** Set when this deposit completed a batch. */
  readonly anchored: AnchoredBatch | null;
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
export function refuseUnlessProvable(locker: Locker, signed: SignedPassport, ns: number): Bytes32 {
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
  return id;
}

export async function deposit(
  locker: Locker,
  batcher: Batcher,
  input: DepositInput,
): Promise<DepositResult> {
  const signed = mintPassport(locker, input);
  return acceptSigned(
    locker,
    batcher,
    signed,
    input.ns,
    input.plaintext ?? datumBytes(input.datum),
  );
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
): Promise<DepositResult> {
  const id = refuseUnlessProvable(locker, signed, ns);
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
