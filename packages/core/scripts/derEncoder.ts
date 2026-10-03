/**
 * A minimal DER *encoder*, used only to build golden vectors and fixtures.
 *
 * It lives under `scripts/` rather than `src/` on purpose: FIRSTHAND reads attestation
 * certificates and never writes them, so an encoder has no business in the shipped package. It is
 * here so that the TypeScript reader (`src/attestation/`) and the Solidity reader
 * (`contracts/src/libraries/`) are checked against *the same bytes* — which is the whole value of
 * a golden suite, and the pattern `PassportLib`/`typed.ts` already follows.
 *
 * Certificates produced here are genuinely signed: `certificate()` signs the `tbsCertificate` it
 * just built with the issuer's key, so a fixture that should verify actually does.
 */
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, concat, utf8 } from "../src/bytes.js";
import { sha256 } from "../src/hash.js";

// ── primitives ──────────────────────────────────────────────────────────────────────────────

/** DER length: short form under 128, otherwise the shortest big-endian long form. */
export function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v >>>= 8;
  }
  return Uint8Array.of(0x80 | out.length, ...out);
}

export const tlv = (identifier: number, body: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(identifier), derLength(body.length), body);

export const seq = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, concat(...parts));
export const oid = (body: Uint8Array): Uint8Array => tlv(0x06, body);
export const octet = (body: Uint8Array): Uint8Array => tlv(0x04, body);
export const bits = (body: Uint8Array): Uint8Array => tlv(0x03, concat(Uint8Array.of(0), body));
export const enumerated = (v: number): Uint8Array => tlv(0x0a, Uint8Array.of(v));
export const bool = (v: boolean): Uint8Array => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00));
export const printable = (text: string): Uint8Array => tlv(0x13, utf8(text));
export const utcTime = (text: string): Uint8Array => tlv(0x17, utf8(text));

/** Minimal two's-complement INTEGER; a leading zero is added when the top bit would read negative. */
export function integer(value: bigint): Uint8Array {
  if (value === 0n) return tlv(0x02, Uint8Array.of(0));
  const out: number[] = [];
  let v = value;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if ((out[0] as number) & 0x80) out.unshift(0);
  return tlv(0x02, Uint8Array.from(out));
}

/**
 * Context-tagged and constructed. Tags at or above 31 use the high-tag-number form, which is how
 * Android's `AuthorizationList` encodes `origin` (702) and `rootOfTrust` (704).
 */
export function ctx(tagNumber: number, body: Uint8Array): Uint8Array {
  if (tagNumber < 31) return tlv(0xa0 | tagNumber, body);
  const groups: number[] = [];
  let v = tagNumber;
  while (v > 0) {
    groups.unshift(v & 0x7f);
    v >>>= 7;
  }
  for (let i = 0; i < groups.length - 1; i++) groups[i] = (groups[i] as number) | 0x80;
  return concat(Uint8Array.of(0xbf), Uint8Array.from(groups), derLength(body.length), body);
}

// ── object identifiers ──────────────────────────────────────────────────────────────────────

/** `1.2.840.10045.2.1` — id-ecPublicKey. */
export const OID_EC_PUBLIC_KEY = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
/** `1.2.840.10045.3.1.7` — prime256v1, the only curve RIP-7212 verifies. */
export const OID_PRIME256V1 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
/** `1.3.132.0.34` — secp384r1, for the case that must be refused. */
export const OID_SECP384R1 = Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x22);
/** `1.2.840.10045.4.3.2` — ecdsa-with-SHA256. */
export const OID_ECDSA_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
/** `1.2.840.10045.4.3.3` — ecdsa-with-SHA384, which this codebase does not verify. */
export const OID_ECDSA_SHA384 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03);
/** `1.3.6.1.4.1.11129.2.1.17` — the Android key attestation extension. */
export const OID_KEY_DESCRIPTION = Uint8Array.of(
  0x2b,
  0x06,
  0x01,
  0x04,
  0x01,
  0xd6,
  0x79,
  0x02,
  0x01,
  0x11,
);

// ── X.509 and KeyDescription ────────────────────────────────────────────────────────────────

export const name = (common: string): Uint8Array => seq(printable(common));
export const validity = (): Uint8Array => seq(utcTime("260101000000Z"), utcTime("360101000000Z"));
export const extension = (id: Uint8Array, value: Uint8Array): Uint8Array =>
  seq(oid(id), octet(value));

export function spki(
  publicKey: Uint8Array,
  curve: Uint8Array = OID_PRIME256V1,
  algorithm: Uint8Array = OID_EC_PUBLIC_KEY,
): Uint8Array {
  return seq(seq(oid(algorithm), oid(curve)), bits(publicKey));
}

/** `1.2.840.113549.1.1.1` — rsaEncryption, for the case that must be refused as not-EC. */
export const OID_RSA_ENCRYPTION = Uint8Array.of(
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
);

/** An extension with `critical` present — the three-element form of `Extension`. */
export const criticalExtension = (id: Uint8Array, value: Uint8Array): Uint8Array =>
  seq(oid(id), bool(true), octet(value));

export interface AuthorizationOptions {
  /** `KeyOrigin`: 0 GENERATED, 1 DERIVED, 2 IMPORTED, 3 UNKNOWN. */
  readonly origin?: number;
  /** `VerifiedBootState`: 0 VERIFIED, 1 SELF_SIGNED, 2 UNVERIFIED, 3 FAILED. */
  readonly bootState?: number;
  readonly deviceLocked?: boolean;
  /** Extra context tags to include, e.g. device-identifier tags for a privacy test. */
  readonly identifierTags?: readonly number[];
}

export function authorizationList(options: AuthorizationOptions = {}): Uint8Array {
  const entries: Uint8Array[] = [];
  if (options.origin !== undefined) entries.push(ctx(702, integer(BigInt(options.origin))));
  if (options.bootState !== undefined) {
    entries.push(
      ctx(
        704,
        seq(
          octet(new Uint8Array(32)),
          bool(options.deviceLocked ?? true),
          enumerated(options.bootState),
          octet(new Uint8Array(32)),
        ),
      ),
    );
  }
  for (const tag of options.identifierTags ?? []) entries.push(ctx(tag, octet(utf8("redacted"))));
  return seq(...entries);
}

export interface KeyDescriptionOptions {
  readonly securityLevel?: number;
  readonly keymasterSecurityLevel?: number;
  readonly challenge?: Uint8Array;
  readonly uniqueId?: Uint8Array;
  readonly tee?: AuthorizationOptions;
  readonly software?: AuthorizationOptions;
}

export function keyDescription(options: KeyDescriptionOptions = {}): Uint8Array {
  return seq(
    integer(300n),
    enumerated(options.securityLevel ?? 2),
    integer(300n),
    enumerated(options.keymasterSecurityLevel ?? options.securityLevel ?? 2),
    octet(options.challenge ?? utf8("challenge")),
    octet(options.uniqueId ?? new Uint8Array(0)),
    authorizationList(options.software ?? {}),
    authorizationList(options.tee ?? { origin: 0, bootState: 0 }),
  );
}

export interface CertOptions {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectKey: Uint8Array;
  readonly issuerSecret: Uint8Array;
  readonly extensions?: readonly Uint8Array[];
  readonly curve?: Uint8Array;
  /** Override `AlgorithmIdentifier.algorithm` in the SPKI, e.g. to produce a non-EC key. */
  readonly keyAlgorithmOid?: Uint8Array;
  /** Put arbitrary bytes in the subjectPublicKey BIT STRING instead of an uncompressed point. */
  readonly rawSubjectKey?: Uint8Array;
  readonly signatureOid?: Uint8Array;
  /** Emit the equally-valid high-s form, which real CAs do about half the time. */
  readonly highS?: boolean;
  /** Replace the signature BIT STRING's payload, to build a shape that must be refused. */
  readonly signatureOverride?: Uint8Array;
  /** Omit `[0] version`, as a v1 certificate does. */
  readonly noVersion?: boolean;
}

const P256_N = p256.Point.CURVE().n;

export interface BuiltCertificate {
  /** The whole certificate. */
  readonly der: Uint8Array;
  /** The `tbsCertificate` — the bytes the issuer signed. */
  readonly tbs: Uint8Array;
  readonly r: bigint;
  /** As emitted: high-s when `options.highS`, which a reader must normalise before verifying. */
  readonly s: bigint;
}

/** Builds a certificate whose signature actually verifies against `issuerSecret`. */
export function buildCertificate(options: CertOptions): BuiltCertificate {
  const algorithm = seq(oid(options.signatureOid ?? OID_ECDSA_SHA256));
  const tbs = seq(
    ...(options.noVersion ? [] : [ctx(0, integer(2n))]),
    integer(1n),
    algorithm,
    name(options.issuer),
    validity(),
    name(options.subject),
    spki(options.rawSubjectKey ?? options.subjectKey, options.curve, options.keyAlgorithmOid),
    ...(options.extensions === undefined ? [] : [ctx(3, seq(...options.extensions))]),
  );

  const compact = p256.sign(sha256(tbs), options.issuerSecret, { prehash: false });
  const r = BigInt(bytesToHex(compact.subarray(0, 32)));
  const low = BigInt(bytesToHex(compact.subarray(32, 64)));
  // ECDSA is malleable: (r, n - s) verifies wherever (r, s) does, and real CAs emit both.
  const s = options.highS ? P256_N - low : low;

  const payload = options.signatureOverride ?? seq(integer(r), integer(s));
  return { der: seq(tbs, algorithm, bits(payload)), tbs, r, s };
}

/** The certificate alone, for callers that do not need the parts. */
export const certificate = (options: CertOptions): Uint8Array => buildCertificate(options).der;

export const publicKeyOf = (secret: Uint8Array): Uint8Array => p256.getPublicKey(secret, false);
