import { type P256PublicKey, verifyP256 } from "../authority/p256.js";
import { type Bytes32, bytesEqual, bytesToHex } from "../bytes.js";
import { FirsthandError } from "../errors.js";
import { sha256 } from "../hash.js";
import {
  effectiveSecurityLevel,
  isHardwareGenerated,
  type KeyDescription,
  keyDescriptionOf,
  SecurityLevel,
} from "./androidKey.js";
import { type Certificate, issuedBy, parseCertificate } from "./certificate.js";
import { deviceKeyCommitment } from "./hardwareDigest.js";

/**
 * Verifies a P-256 attestation certificate chain against a pinned trust anchor (ADR-0015).
 *
 * The reference implementation; `contracts/src/libraries/AndroidKeyAttestation.sol` performs the
 * same walk on chain against the same committed vectors, so the two cannot drift.
 *
 * **Why the anchor is pinned mid-chain rather than at the root.** Certificate roots use stronger
 * parameters than the leaves they certify: Google's hardware attestation root is RSA or P-384,
 * Apple's is P-384, Yubico's legacy root is RSA. RIP-7212 verifies P-256 and nothing else, and a
 * Solidity P-384 verifier is not affordable. So verification runs upward from the leaf and stops
 * at the highest certificate whose key is P-256 and whose commitment we have pinned; the links
 * above it are checked once, off chain, and the pin records that result. Certificates above the
 * anchor are never parsed, which is deliberate — parsing them would fail on the curve.
 *
 * That is a real limitation, not a formality, and the copy that ships alongside it says so: §22
 * forbids admin keys and upgradability, so the pin cannot be rotated in place.
 */

export class AttestationError extends FirsthandError {
  constructor(message: string, context: Readonly<Record<string, unknown>> = {}) {
    super("FH_ATTESTATION_INVALID", message, { context });
  }
}

export interface ChainPolicy {
  /**
   * Commitments (`deviceKeyCommitment`) of the public keys trusted as chain anchors. A chain that
   * does not reach one of these is refused — there is no "unknown issuer, allow anyway" path.
   */
  readonly anchors: readonly Bytes32[];
  /** Minimum acceptable `SecurityLevel`. Defaults to `TRUSTED_ENVIRONMENT`. */
  readonly minimumSecurityLevel?: number;
  /** When set, the leaf's `attestationChallenge` must equal these bytes exactly. */
  readonly expectedChallenge?: Uint8Array;
}

export interface VerifiedDevice {
  /** The leaf's public key — the key the secure element signs captures with. */
  readonly publicKey: P256PublicKey;
  /** `deviceKeyCommitment(publicKey)` — what a class-3 passport puts in `deviceClass`. */
  readonly keyCommitment: Bytes32;
  /** The measured effective security level: `SecurityLevel.TRUSTED_ENVIRONMENT` or `STRONG_BOX`. */
  readonly securityLevel: number;
  readonly description: KeyDescription;
  /** Index of the pinned certificate; every link below it was verified here. */
  readonly anchorIndex: number;
}

/**
 * Walks `chain` (leaf first, as Android and WebAuthn both return it) and returns the attested
 * device, or throws. Never returns a partial verdict: an unreachable anchor, a broken link, a
 * software-backed key or an imported key are all refusals.
 */
export function verifyAttestationChain(
  chain: readonly Uint8Array[],
  policy: ChainPolicy,
): VerifiedDevice {
  if (chain.length < 2) {
    throw new AttestationError("an attestation chain needs a leaf and at least one issuer", {
      length: chain.length,
    });
  }
  if (policy.anchors.length === 0) {
    throw new AttestationError("no trust anchors configured");
  }

  // Parse upward only as far as the anchor. Beyond it the curve is not ours to read.
  const parsed: Certificate[] = [];
  let anchorIndex = -1;
  for (let i = 0; i < chain.length; i++) {
    const certificate = parseCertificate(chain[i] as Uint8Array);
    parsed.push(certificate);
    if (policy.anchors.includes(deviceKeyCommitment(certificate.publicKey))) {
      anchorIndex = i;
      break;
    }
  }

  if (anchorIndex < 0) {
    throw new AttestationError("chain does not reach a pinned trust anchor", {
      length: chain.length,
      parsed: parsed.length,
    });
  }
  if (anchorIndex === 0) {
    // The leaf is its own anchor, so nothing was verified. Refuse rather than return a verdict
    // that looks identical to a real one.
    throw new AttestationError("the leaf certificate cannot be its own trust anchor");
  }

  for (let i = 0; i < anchorIndex; i++) {
    const subject = parsed[i] as Certificate;
    const issuer = parsed[i + 1] as Certificate;
    if (!subject.signedWithEcdsaSha256) {
      throw new AttestationError("certificate is not signed with ecdsa-with-SHA256", { index: i });
    }
    if (!issuedBy(subject, issuer)) {
      throw new AttestationError("certificate issuer does not match the next subject", {
        index: i,
      });
    }
    if (
      !verifyP256(bytesToHex(sha256(subject.tbs)) as Bytes32, subject.signature, issuer.publicKey)
    ) {
      throw new AttestationError("certificate signature does not verify", { index: i });
    }
  }

  const leaf = parsed[0] as Certificate;
  const description = keyDescriptionOf(leaf);
  if (description === null) {
    throw new AttestationError("leaf carries no key attestation extension");
  }

  if (!isHardwareGenerated(description)) {
    throw new AttestationError("key was not generated inside a secure element", {
      origin: description.teeEnforced.origin,
      securityLevel: effectiveSecurityLevel(description),
    });
  }

  const securityLevel = effectiveSecurityLevel(description);
  const minimum = policy.minimumSecurityLevel ?? SecurityLevel.TRUSTED_ENVIRONMENT;
  if (securityLevel < minimum) {
    throw new AttestationError("key security level is below the required minimum", {
      securityLevel,
      minimum,
    });
  }

  if (policy.expectedChallenge !== undefined) {
    if (!bytesEqual(description.attestationChallenge, policy.expectedChallenge)) {
      throw new AttestationError("attestation challenge does not match the expected value");
    }
  }

  return {
    publicKey: leaf.publicKey,
    keyCommitment: deviceKeyCommitment(leaf.publicKey),
    securityLevel,
    description,
    anchorIndex,
  };
}

/**
 * Verifies one capture witness against an already-verified device key. Pure and total: a malformed
 * signature is `false`, never a throw, so a caller can use it inside a refusal predicate.
 */
export function verifyCaptureWitness(
  digest: Bytes32,
  signature: `0x${string}`,
  publicKey: P256PublicKey,
): boolean {
  return verifyP256(digest, signature, publicKey);
}
