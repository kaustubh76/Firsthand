import {
  encodeP256Signature,
  P256_N,
  type P256PublicKey,
  p256PublicKeyFromUncompressed,
} from "../authority/p256.js";
import { bytesEqual, type Hex } from "../bytes.js";
import {
  bitString,
  children,
  content,
  DerError,
  element,
  expectChildren,
  isOid,
  readUniversal,
  Tag,
  TagClass,
  type Tlv,
  unsignedInteger,
} from "./der.js";

/**
 * The slice of X.509 that a P-256 attestation chain needs, and nothing more (ADR-0015).
 *
 * Only what a verifier must authenticate is read: the exact bytes that were signed, the signature
 * itself, the subject key, and the issuer/subject names that link one certificate to the next.
 * Validity dates, key usage and revocation are deliberately **not** interpreted here — they are
 * policy, they belong to the caller, and pretending otherwise would hide a check that nobody ran.
 *
 * Fields are located by descending the structure, never by scanning for a pattern: see the note in
 * `der.ts` about `attestationChallenge` being attacker-controlled bytes inside a signed document.
 */

/** `1.2.840.10045.2.1` — id-ecPublicKey. */
const OID_EC_PUBLIC_KEY = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
/** `1.2.840.10045.3.1.7` — prime256v1, the only curve RIP-7212 can verify. */
const OID_PRIME256V1 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
/** `1.2.840.10045.4.3.2` — ecdsa-with-SHA256. */
const OID_ECDSA_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);

const P256_HALF_N = P256_N >> 1n;

const CONTEXT_VERSION = 0;
const CONTEXT_EXTENSIONS = 3;

export interface Extension {
  /** The raw OID content bytes, without the tag and length. */
  readonly oid: Uint8Array;
  readonly critical: boolean;
  /** The OCTET STRING payload — for Android key attestation, an encoded `KeyDescription`. */
  readonly value: Uint8Array;
}

export interface Certificate {
  /** The exact `tbsCertificate` DER, header included — the bytes the issuer signed. */
  readonly tbs: Uint8Array;
  /**
   * 64-byte `r ‖ s`, **normalised to low-s**. X.509 signatures carry whichever `s` the CA's signer
   * produced, and roughly half are high-s; both `verifyP256` and `P256.sol` reject those, so the
   * equivalent `(r, n − s)` is what gets stored and verified. Without this, one certificate in two
   * would look forged.
   */
  readonly signature: Hex;
  /** True when the certificate is signed with ecdsa-with-SHA256, the only algorithm verified here. */
  readonly signedWithEcdsaSha256: boolean;
  /** The subject's P-256 public key. */
  readonly publicKey: P256PublicKey;
  /** Raw DER of the issuer `Name`, for linking to the parent's `subject`. */
  readonly issuer: Uint8Array;
  /** Raw DER of the subject `Name`. */
  readonly subject: Uint8Array;
  readonly extensions: readonly Extension[];
}

/**
 * Parses one DER certificate. Throws `DerError` on anything malformed, on a non-P-256 subject key,
 * or on a signature whose `r`/`s` fall outside the curve order.
 */
export function parseCertificate(der: Uint8Array): Certificate {
  const certificate = readUniversal(der, 0, Tag.SEQUENCE);
  if (certificate.end !== der.length) {
    throw new DerError("trailing bytes after the certificate", certificate.end);
  }

  const top = children(der, certificate);
  expectChildren(top, 3, "Certificate", certificate.start);
  const [tbsTlv, algorithmTlv, signatureTlv] = top as [Tlv, Tlv, Tlv];

  const tbs = children(der, tbsTlv);
  expectChildren(tbs, 6, "TBSCertificate", tbsTlv.start);

  // `version` is [0] EXPLICIT and defaults to v1, so it may be absent. Everything after it is
  // positional, which is why the offset is computed rather than assumed.
  const first = tbs[0] as Tlv;
  const hasVersion = first.tagClass === TagClass.CONTEXT && first.tagNumber === CONTEXT_VERSION;
  const base = hasVersion ? 1 : 0;
  expectChildren(tbs, base + 6, "TBSCertificate", tbsTlv.start);

  const issuer = element(der, tbs[base + 2] as Tlv);
  const subject = element(der, tbs[base + 4] as Tlv);
  const publicKey = readSubjectPublicKey(der, tbs[base + 5] as Tlv);

  return {
    tbs: element(der, tbsTlv),
    signature: readEcdsaSignature(der, signatureTlv),
    signedWithEcdsaSha256: isEcdsaSha256(der, algorithmTlv),
    publicKey,
    issuer,
    subject,
    extensions: readExtensions(der, tbs.slice(base + 6)),
  };
}

/** True when this certificate's `issuer` is byte-identical to `parent`'s `subject`. */
export function issuedBy(certificate: Certificate, parent: Certificate): boolean {
  return bytesEqual(certificate.issuer, parent.subject);
}

/** The extension carrying `oid`, or `null`. */
export function findExtension(certificate: Certificate, oid: Uint8Array): Extension | null {
  for (const extension of certificate.extensions) {
    if (bytesEqual(extension.oid, oid)) return extension;
  }
  return null;
}

function isEcdsaSha256(der: Uint8Array, algorithmTlv: Tlv): boolean {
  const parts = children(der, algorithmTlv);
  return parts.length >= 1 && isOid(der, parts[0] as Tlv, OID_ECDSA_SHA256);
}

function readSubjectPublicKey(der: Uint8Array, spkiTlv: Tlv): P256PublicKey {
  const spki = children(der, spkiTlv);
  expectChildren(spki, 2, "SubjectPublicKeyInfo", spkiTlv.start);

  const algorithm = children(der, spki[0] as Tlv);
  expectChildren(algorithm, 2, "AlgorithmIdentifier", (spki[0] as Tlv).start);
  if (!isOid(der, algorithm[0] as Tlv, OID_EC_PUBLIC_KEY)) {
    throw new DerError("subject key is not an EC public key", (algorithm[0] as Tlv).start);
  }
  if (!isOid(der, algorithm[1] as Tlv, OID_PRIME256V1)) {
    // A P-384 or P-521 key is well-formed X.509 and completely unverifiable by RIP-7212, so it is
    // refused here rather than further down where the failure would read as a bad signature.
    throw new DerError("subject key is not on prime256v1", (algorithm[1] as Tlv).start);
  }

  const point = bitString(der, spki[1] as Tlv);
  try {
    return p256PublicKeyFromUncompressed(point);
  } catch (cause) {
    throw new DerError(
      `subject key is not an uncompressed point (${String(cause)})`,
      (spki[1] as Tlv).start,
    );
  }
}

function readEcdsaSignature(der: Uint8Array, signatureTlv: Tlv): Hex {
  const payload = bitString(der, signatureTlv);
  const sequence = readUniversal(payload, 0, Tag.SEQUENCE);
  if (sequence.end !== payload.length) {
    throw new DerError("trailing bytes after ECDSA-Sig-Value", sequence.end);
  }
  const parts = children(payload, sequence);
  expectChildren(parts, 2, "ECDSA-Sig-Value", sequence.start);

  const r = unsignedInteger(payload, parts[0] as Tlv);
  const s = unsignedInteger(payload, parts[1] as Tlv);
  if (r === 0n || r >= P256_N)
    throw new DerError("signature r out of range", (parts[0] as Tlv).start);
  if (s === 0n || s >= P256_N)
    throw new DerError("signature s out of range", (parts[1] as Tlv).start);

  return encodeP256Signature({ r, s: s > P256_HALF_N ? P256_N - s : s });
}

function readExtensions(der: Uint8Array, trailing: readonly Tlv[]): readonly Extension[] {
  // [1] issuerUniqueID and [2] subjectUniqueID may sit between the key and the extensions.
  const wrapper = trailing.find(
    (tlv) => tlv.tagClass === TagClass.CONTEXT && tlv.tagNumber === CONTEXT_EXTENSIONS,
  );
  if (wrapper === undefined) return [];

  const inner = children(der, wrapper);
  expectChildren(inner, 1, "Extensions", wrapper.start);
  const sequence = inner[0] as Tlv;
  if (sequence.tagClass !== TagClass.UNIVERSAL || sequence.tagNumber !== Tag.SEQUENCE) {
    throw new DerError("Extensions is not a SEQUENCE", sequence.start);
  }

  return children(der, sequence).map((entry) => {
    const parts = children(der, entry);
    expectChildren(parts, 2, "Extension", entry.start);
    const oidTlv = parts[0] as Tlv;
    if (oidTlv.tagClass !== TagClass.UNIVERSAL || oidTlv.tagNumber !== Tag.OBJECT_IDENTIFIER) {
      throw new DerError("extension id is not an OID", oidTlv.start);
    }
    // `critical` is DEFAULT FALSE, so a two-element extension has no boolean.
    const hasCritical = parts.length > 2;
    const criticalTlv = hasCritical ? (parts[1] as Tlv) : null;
    const valueTlv = parts[hasCritical ? 2 : 1] as Tlv;
    if (valueTlv.tagClass !== TagClass.UNIVERSAL || valueTlv.tagNumber !== Tag.OCTET_STRING) {
      throw new DerError("extension value is not an OCTET STRING", valueTlv.start);
    }
    return {
      oid: content(der, oidTlv),
      critical: criticalTlv !== null && der[criticalTlv.contentStart] !== 0,
      value: content(der, valueTlv),
    };
  });
}
