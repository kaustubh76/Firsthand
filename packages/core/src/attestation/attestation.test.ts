import { loadVectors } from "@firsthand/test-vectors";
import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { P256_N, p256PublicKeyFromUncompressed } from "../authority/p256.js";
import { type Bytes32, bytesToHex, concat, hexToBytes, utf8 } from "../bytes.js";
import { sha256 } from "../hash.js";
import {
  deviceIdentifierTags,
  effectiveSecurityLevel,
  isHardwareGenerated,
  KeyOrigin,
  keyDescriptionOf,
  OID_KEY_DESCRIPTION,
  parseKeyDescription,
  SecurityLevel,
  VerifiedBootState,
} from "./androidKey.js";
import { findExtension, issuedBy, parseCertificate } from "./certificate.js";
import { verifyAttestationChain, verifyCaptureWitness } from "./chain.js";
import {
  bitString,
  children,
  DerError,
  readTlv,
  readUniversal,
  smallInteger,
  Tag,
  TagClass,
  unsignedInteger,
} from "./der.js";
import {
  deviceKeyCommitment,
  HARDWARE_CAPTURE_DOMAIN,
  HARDWARE_CAPTURE_PREIMAGE_BYTES,
  hardwareCaptureDigest,
  hardwareCapturePreimage,
} from "./hardwareDigest.js";

// ── a minimal DER encoder, so every fixture below is a real signed certificate ────────────────
// Building these by hand rather than committing opaque hex keeps the negative cases honest: each
// malformed input differs from a valid one in exactly the byte under test.

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v >>>= 8;
  }
  return Uint8Array.of(0x80 | out.length, ...out);
}

const tlv = (identifier: number, body: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(identifier), len(body.length), body);

const seq = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, concat(...parts));
const oid = (body: Uint8Array): Uint8Array => tlv(0x06, body);
const octet = (body: Uint8Array): Uint8Array => tlv(0x04, body);
const bits = (body: Uint8Array): Uint8Array => tlv(0x03, concat(Uint8Array.of(0), body));
const enumerated = (v: number): Uint8Array => tlv(0x0a, Uint8Array.of(v));
const bool = (v: boolean): Uint8Array => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00));
const printable = (text: string): Uint8Array => tlv(0x13, utf8(text));
const utcTime = (text: string): Uint8Array => tlv(0x17, utf8(text));

function integer(value: bigint): Uint8Array {
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

/** Context-tagged, constructed; handles the high-tag-number form Android's AuthorizationList uses. */
function ctx(tagNumber: number, body: Uint8Array): Uint8Array {
  if (tagNumber < 31) return tlv(0xa0 | tagNumber, body);
  const groups: number[] = [];
  let v = tagNumber;
  while (v > 0) {
    groups.unshift(v & 0x7f);
    v >>>= 7;
  }
  for (let i = 0; i < groups.length - 1; i++) groups[i] = (groups[i] as number) | 0x80;
  return concat(Uint8Array.of(0xbf), Uint8Array.from(groups), len(body.length), body);
}

const OID_EC_PUBLIC_KEY = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
const OID_PRIME256V1 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
const OID_SECP384R1 = Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x22);
const OID_ECDSA_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_ECDSA_SHA384 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03);

const name = (common: string): Uint8Array => seq(printable(common));
const validity = (): Uint8Array => seq(utcTime("260101000000Z"), utcTime("360101000000Z"));

function spki(publicKey: Uint8Array, curve: Uint8Array = OID_PRIME256V1): Uint8Array {
  return seq(seq(oid(OID_EC_PUBLIC_KEY), oid(curve)), bits(publicKey));
}

interface AuthorizationOptions {
  readonly origin?: number;
  readonly bootState?: number;
  readonly identifierTags?: readonly number[];
}

function authorizationList(options: AuthorizationOptions = {}): Uint8Array {
  const entries: Uint8Array[] = [];
  if (options.origin !== undefined) entries.push(ctx(702, integer(BigInt(options.origin))));
  if (options.bootState !== undefined) {
    entries.push(
      ctx(
        704,
        seq(
          octet(new Uint8Array(32)),
          bool(true),
          enumerated(options.bootState),
          octet(new Uint8Array(32)),
        ),
      ),
    );
  }
  for (const tag of options.identifierTags ?? []) entries.push(ctx(tag, octet(utf8("redacted"))));
  return seq(...entries);
}

interface KeyDescriptionOptions {
  readonly securityLevel?: number;
  readonly keymasterSecurityLevel?: number;
  readonly challenge?: Uint8Array;
  readonly tee?: AuthorizationOptions;
  readonly software?: AuthorizationOptions;
}

function keyDescription(options: KeyDescriptionOptions = {}): Uint8Array {
  return seq(
    integer(300n),
    enumerated(options.securityLevel ?? SecurityLevel.STRONG_BOX),
    integer(300n),
    enumerated(options.keymasterSecurityLevel ?? options.securityLevel ?? SecurityLevel.STRONG_BOX),
    octet(options.challenge ?? utf8("challenge")),
    octet(new Uint8Array(0)),
    authorizationList(options.software ?? {}),
    authorizationList(
      options.tee ?? { origin: KeyOrigin.GENERATED, bootState: VerifiedBootState.VERIFIED },
    ),
  );
}

interface CertOptions {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectKey: Uint8Array;
  readonly issuerSecret: Uint8Array;
  readonly extensions?: readonly Uint8Array[];
  readonly curve?: Uint8Array;
  readonly signatureOid?: Uint8Array;
  readonly highS?: boolean;
}

/** Builds a real certificate: the signature below actually verifies against `issuerSecret`. */
function certificate(options: CertOptions): Uint8Array {
  const algorithm = seq(oid(options.signatureOid ?? OID_ECDSA_SHA256));
  const parts: Uint8Array[] = [
    ctx(0, integer(2n)),
    integer(1n),
    algorithm,
    name(options.issuer),
    validity(),
    name(options.subject),
    spki(options.subjectKey, options.curve),
  ];
  if (options.extensions !== undefined) parts.push(ctx(3, seq(...options.extensions)));
  const tbs = seq(...parts);

  const compact = p256.sign(sha256(tbs), options.issuerSecret, { prehash: false });
  const r = BigInt(bytesToHex(compact.subarray(0, 32)));
  const low = BigInt(bytesToHex(compact.subarray(32, 64)));
  // ECDSA is malleable: (r, n − s) verifies wherever (r, s) does. Real CAs emit both, so the
  // parser must normalise — this is how that branch gets exercised.
  const s = options.highS ? P256_N - low : low;

  return seq(tbs, algorithm, bits(seq(integer(r), integer(s))));
}

const extension = (id: Uint8Array, value: Uint8Array): Uint8Array => seq(oid(id), octet(value));

const SECRETS = {
  leaf: hexToBytes(`0x${"11".repeat(32)}`),
  intermediate: hexToBytes(`0x${"22".repeat(32)}`),
  root: hexToBytes(`0x${"33".repeat(32)}`),
  rogue: hexToBytes(`0x${"44".repeat(32)}`),
} as const;

const publicOf = (secret: Uint8Array): Uint8Array => p256.getPublicKey(secret, false);
const commitmentOf = (secret: Uint8Array): Bytes32 =>
  deviceKeyCommitment(p256PublicKeyFromUncompressed(publicOf(secret)));

function buildChain(
  leafOptions: KeyDescriptionOptions = {},
  overrides: Partial<CertOptions> = {},
): readonly Uint8Array[] {
  const leaf = certificate({
    subject: "leaf",
    issuer: "intermediate",
    subjectKey: publicOf(SECRETS.leaf),
    issuerSecret: SECRETS.intermediate,
    extensions: [extension(OID_KEY_DESCRIPTION, keyDescription(leafOptions))],
    ...overrides,
  });
  const intermediate = certificate({
    subject: "intermediate",
    issuer: "root",
    subjectKey: publicOf(SECRETS.intermediate),
    issuerSecret: SECRETS.root,
  });
  return [leaf, intermediate];
}

const ANCHORS = [commitmentOf(SECRETS.intermediate)];

// ── der.ts ────────────────────────────────────────────────────────────────────────────────────

describe("readTlv", () => {
  it("reads a short-form universal tag", () => {
    const bytes = octet(Uint8Array.of(1, 2, 3));
    const tlv_ = readTlv(bytes, 0);
    expect(tlv_).toMatchObject({
      tagClass: TagClass.UNIVERSAL,
      constructed: false,
      tagNumber: Tag.OCTET_STRING,
      contentLength: 3,
      end: 5,
    });
  });

  it("reads a long-form length", () => {
    const body = new Uint8Array(300).fill(7);
    const parsed = readTlv(octet(body), 0);
    expect(parsed.contentLength).toBe(300);
  });

  it("reads the high-tag-number form", () => {
    const parsed = readTlv(ctx(704, octet(new Uint8Array(0))), 0);
    expect(parsed).toMatchObject({ tagClass: TagClass.CONTEXT, tagNumber: 704, constructed: true });
  });

  it.each([
    ["offset past the end", octet(Uint8Array.of(1)), 99, "out of bounds"],
    ["a negative offset", octet(Uint8Array.of(1)), -1, "out of bounds"],
    ["an indefinite length", Uint8Array.of(0x30, 0x80, 0x00, 0x00), 0, "indefinite"],
    [
      "a non-minimal long-form length",
      Uint8Array.of(0x04, 0x81, 0x01, 0xaa),
      0,
      "non-minimal length",
    ],
    ["a leading zero length octet", Uint8Array.of(0x04, 0x82, 0x00, 0x81), 0, "non-minimal length"],
    [
      "a length wider than four octets",
      Uint8Array.of(0x04, 0x85, 1, 1, 1, 1, 1),
      0,
      "length too large",
    ],
    ["the reserved 0xff length", Uint8Array.of(0x04, 0xff, 1), 0, "length too large"],
    ["a truncated length", Uint8Array.of(0x04), 0, "truncated length"],
    ["truncated length octets", Uint8Array.of(0x04, 0x82, 0x01), 0, "truncated length"],
    ["content past the buffer", Uint8Array.of(0x04, 0x05, 1, 2), 0, "runs past the end"],
    ["a truncated high tag", Uint8Array.of(0xbf, 0x85), 0, "truncated tag"],
    ["a non-minimal high tag", Uint8Array.of(0xbf, 0x80, 0x01, 0x00), 0, "non-minimal tag"],
  ])("rejects %s", (_label, bytes, offset, message) => {
    expect(() => readTlv(bytes, offset)).toThrow(new RegExp(message));
  });

  it("rejects a high-tag-number form that encodes a low number", () => {
    // 0xbf 0x01 says "high form" but carries tag 1, which the short form should have expressed.
    expect(() => readTlv(Uint8Array.of(0xbf, 0x01, 0x00), 0)).toThrow(/non-minimal tag/);
  });

  it("rejects an absurdly large tag number", () => {
    const huge = Uint8Array.of(0xbf, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x00);
    expect(() => readTlv(huge, 0)).toThrow(/tag number too large/);
  });

  it("rejects a length beyond the ceiling", () => {
    expect(() => readTlv(Uint8Array.of(0x04, 0x84, 0xff, 0xff, 0xff, 0xff), 0)).toThrow(
      /length too large/,
    );
  });

  it("carries the offset in the error context", () => {
    try {
      readTlv(Uint8Array.of(0x30, 0x80), 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DerError);
      expect((error as DerError).code).toBe("FH_ATTESTATION_INVALID");
      expect((error as DerError).context).toEqual({ offset: 0 });
    }
  });
});

describe("readUniversal and children", () => {
  it("rejects an unexpected tag", () => {
    expect(() => readUniversal(octet(Uint8Array.of(1)), 0, Tag.SEQUENCE)).toThrow(
      /expected universal/,
    );
  });

  it("refuses to descend into a primitive", () => {
    const bytes = octet(Uint8Array.of(1));
    expect(() => children(bytes, readTlv(bytes, 0))).toThrow(/cannot descend/);
  });

  it("rejects a child that overruns its parent", () => {
    // A SEQUENCE claiming 2 bytes of content whose child claims 5.
    const bytes = Uint8Array.of(0x30, 0x02, 0x04, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05);
    expect(() => children(bytes, readTlv(bytes, 0))).toThrow(/runs past the end|overruns/);
  });

  it("returns children in order", () => {
    const bytes = seq(integer(1n), integer(2n), integer(3n));
    expect(children(bytes, readTlv(bytes, 0))).toHaveLength(3);
  });
});

describe("DER value readers", () => {
  const at = (bytes: Uint8Array) => readTlv(bytes, 0);

  it("reads a BIT STRING payload, and refuses anything that is not one", () => {
    const good = bits(Uint8Array.of(9, 9));
    expect(bitString(good, at(good))).toEqual(Uint8Array.of(9, 9));
    const wrongTag = octet(Uint8Array.of(1));
    expect(() => bitString(wrongTag, at(wrongTag))).toThrow(/expected a BIT STRING/);
    const empty = tlv(0x03, new Uint8Array(0));
    expect(() => bitString(empty, at(empty))).toThrow(/empty BIT STRING/);
  });

  it("reads a small INTEGER or ENUMERATED within range", () => {
    const e = enumerated(2);
    expect(smallInteger(e, at(e))).toBe(2);
    const i = integer(70_000n);
    expect(smallInteger(i, at(i))).toBe(70_000);
  });

  it.each([
    ["a tag that is neither", () => octet(Uint8Array.of(1)), /expected an INTEGER or ENUMERATED/],
    [
      "a value wider than four octets",
      () => integer(0x01_00_00_00_00n),
      /out of the supported range/,
    ],
    ["an empty value", () => tlv(0x02, new Uint8Array(0)), /out of the supported range/],
    ["a negative value", () => tlv(0x02, Uint8Array.of(0x80)), /negative integer/],
  ])("smallInteger refuses %s", (_label, build, message) => {
    const bytes = build();
    expect(() => smallInteger(bytes, at(bytes))).toThrow(message);
  });

  it("reads an unsigned INTEGER of curve-scalar width", () => {
    const big = integer(P256_N - 1n);
    expect(unsignedInteger(big, at(big))).toBe(P256_N - 1n);
  });

  it.each([
    ["an ENUMERATED", () => enumerated(1), /expected an INTEGER/],
    ["an empty value", () => tlv(0x02, new Uint8Array(0)), /empty INTEGER/],
    ["a negative value", () => tlv(0x02, Uint8Array.of(0x80)), /negative integer/],
  ])("unsignedInteger refuses %s", (_label, build, message) => {
    const bytes = build();
    expect(() => unsignedInteger(bytes, at(bytes))).toThrow(message);
  });
});

// ── certificate.ts ────────────────────────────────────────────────────────────────────────────

describe("parseCertificate", () => {
  it("parses a signed certificate and recovers the subject key", () => {
    const der = certificate({
      subject: "leaf",
      issuer: "intermediate",
      subjectKey: publicOf(SECRETS.leaf),
      issuerSecret: SECRETS.intermediate,
    });
    const parsed = parseCertificate(der);
    expect(parsed.publicKey).toEqual(p256PublicKeyFromUncompressed(publicOf(SECRETS.leaf)));
    expect(parsed.signedWithEcdsaSha256).toBe(true);
    expect(parsed.extensions).toEqual([]);
  });

  it("normalises a high-s signature so it verifies", () => {
    const [leaf] = buildChain({}, { highS: true });
    // Both forms must yield an identical, low-s signature — that is the point of normalising.
    const [plain] = buildChain();
    expect(parseCertificate(leaf as Uint8Array).signature).toBe(
      parseCertificate(plain as Uint8Array).signature,
    );
  });

  it("verifies against the issuer it names", () => {
    const [leaf, intermediate] = buildChain();
    expect(
      issuedBy(parseCertificate(leaf as Uint8Array), parseCertificate(intermediate as Uint8Array)),
    ).toBe(true);
  });

  it("notices a foreign issuer name", () => {
    const [, intermediate] = buildChain();
    const stray = certificate({
      subject: "leaf",
      issuer: "somebody-else",
      subjectKey: publicOf(SECRETS.leaf),
      issuerSecret: SECRETS.intermediate,
    });
    expect(issuedBy(parseCertificate(stray), parseCertificate(intermediate as Uint8Array))).toBe(
      false,
    );
  });

  it("parses a certificate with no version field", () => {
    const tbs = seq(
      integer(1n),
      seq(oid(OID_ECDSA_SHA256)),
      name("issuer"),
      validity(),
      name("subject"),
      spki(publicOf(SECRETS.leaf)),
    );
    const compact = p256.sign(sha256(tbs), SECRETS.intermediate, { prehash: false });
    const der = seq(
      tbs,
      seq(oid(OID_ECDSA_SHA256)),
      bits(
        seq(
          integer(BigInt(bytesToHex(compact.subarray(0, 32)))),
          integer(BigInt(bytesToHex(compact.subarray(32, 64)))),
        ),
      ),
    );
    expect(parseCertificate(der).signedWithEcdsaSha256).toBe(true);
  });

  it("reports a non-SHA256 signature algorithm rather than guessing", () => {
    const [leaf] = buildChain({}, { signatureOid: OID_ECDSA_SHA384 });
    expect(parseCertificate(leaf as Uint8Array).signedWithEcdsaSha256).toBe(false);
  });

  it.each([
    [
      "a curve RIP-7212 cannot verify",
      () => buildChain({}, { curve: OID_SECP384R1 })[0] as Uint8Array,
      /not on prime256v1/,
    ],
    [
      "trailing bytes",
      () => concat(buildChain()[0] as Uint8Array, Uint8Array.of(0)),
      /trailing bytes/,
    ],
  ])("rejects %s", (_label, build, message) => {
    expect(() => parseCertificate(build())).toThrow(message);
  });

  it("rejects a non-EC subject key", () => {
    const rsaish = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
    const tbs = seq(
      ctx(0, integer(2n)),
      integer(1n),
      seq(oid(OID_ECDSA_SHA256)),
      name("i"),
      validity(),
      name("s"),
      seq(seq(oid(rsaish), oid(OID_PRIME256V1)), bits(publicOf(SECRETS.leaf))),
    );
    const der = seq(tbs, seq(oid(OID_ECDSA_SHA256)), bits(seq(integer(1n), integer(1n))));
    expect(() => parseCertificate(der)).toThrow(/not an EC public key/);
  });

  it("rejects a subject key that is not an uncompressed point", () => {
    const tbs = seq(
      ctx(0, integer(2n)),
      integer(1n),
      seq(oid(OID_ECDSA_SHA256)),
      name("i"),
      validity(),
      name("s"),
      seq(seq(oid(OID_EC_PUBLIC_KEY), oid(OID_PRIME256V1)), bits(Uint8Array.of(0x02, 0x01))),
    );
    const der = seq(tbs, seq(oid(OID_ECDSA_SHA256)), bits(seq(integer(1n), integer(1n))));
    expect(() => parseCertificate(der)).toThrow(/uncompressed point/);
  });

  it("rejects a signature whose scalars fall outside the curve order", () => {
    const tbs = seq(
      ctx(0, integer(2n)),
      integer(1n),
      seq(oid(OID_ECDSA_SHA256)),
      name("i"),
      validity(),
      name("s"),
      spki(publicOf(SECRETS.leaf)),
    );
    const bad = seq(tbs, seq(oid(OID_ECDSA_SHA256)), bits(seq(integer(0n), integer(1n))));
    expect(() => parseCertificate(bad)).toThrow(/r out of range/);
    const badS = seq(tbs, seq(oid(OID_ECDSA_SHA256)), bits(seq(integer(1n), integer(P256_N))));
    expect(() => parseCertificate(badS)).toThrow(/s out of range/);
  });

  it("rejects a BIT STRING that is not byte-aligned", () => {
    const tbs = seq(
      ctx(0, integer(2n)),
      integer(1n),
      seq(oid(OID_ECDSA_SHA256)),
      name("i"),
      validity(),
      name("s"),
      spki(publicOf(SECRETS.leaf)),
    );
    const misaligned = tlv(0x03, concat(Uint8Array.of(3), seq(integer(1n), integer(1n))));
    expect(() => parseCertificate(seq(tbs, seq(oid(OID_ECDSA_SHA256)), misaligned))).toThrow(
      /byte-aligned/,
    );
  });

  it("finds an extension by OID and ignores the rest", () => {
    const other = Uint8Array.of(0x55, 0x1d, 0x13);
    const [leaf] = buildChain(
      {},
      {
        extensions: [
          extension(other, Uint8Array.of(1)),
          extension(OID_KEY_DESCRIPTION, keyDescription()),
        ],
      },
    );
    const parsed = parseCertificate(leaf as Uint8Array);
    expect(parsed.extensions).toHaveLength(2);
    expect(findExtension(parsed, OID_KEY_DESCRIPTION)).not.toBeNull();
    expect(findExtension(parsed, Uint8Array.of(0x99))).toBeNull();
  });

  it("reads the critical flag when present", () => {
    const withCritical = seq(oid(OID_KEY_DESCRIPTION), bool(true), octet(keyDescription()));
    const [leaf] = buildChain({}, { extensions: [withCritical] });
    expect(parseCertificate(leaf as Uint8Array).extensions[0]?.critical).toBe(true);
  });

  it("rejects an extension whose value is not an OCTET STRING", () => {
    const malformed = seq(oid(OID_KEY_DESCRIPTION), integer(1n));
    const [leaf] = buildChain({}, { extensions: [malformed] });
    expect(() => parseCertificate(leaf as Uint8Array)).toThrow(/not an OCTET STRING/);
  });

  it("rejects an extension whose id is not an OID", () => {
    const malformed = seq(integer(1n), octet(Uint8Array.of(1)));
    const [leaf] = buildChain({}, { extensions: [malformed] });
    expect(() => parseCertificate(leaf as Uint8Array)).toThrow(/not an OID/);
  });
});

// ── androidKey.ts ─────────────────────────────────────────────────────────────────────────────

describe("parseKeyDescription", () => {
  it("reads the measured security level, challenge and boot state", () => {
    const description = parseKeyDescription(
      keyDescription({ challenge: utf8("bound-to-principal") }),
    );
    expect(description.attestationSecurityLevel).toBe(SecurityLevel.STRONG_BOX);
    expect(new TextDecoder().decode(description.attestationChallenge)).toBe("bound-to-principal");
    expect(description.teeEnforced.origin).toBe(KeyOrigin.GENERATED);
    expect(description.teeEnforced.rootOfTrust?.verifiedBootState).toBe(VerifiedBootState.VERIFIED);
    expect(description.teeEnforced.rootOfTrust?.deviceLocked).toBe(true);
    expect(isHardwareGenerated(description)).toBe(true);
  });

  it("reports the weaker of the two security levels", () => {
    const mixed = parseKeyDescription(
      keyDescription({
        securityLevel: SecurityLevel.STRONG_BOX,
        keymasterSecurityLevel: SecurityLevel.TRUSTED_ENVIRONMENT,
      }),
    );
    expect(effectiveSecurityLevel(mixed)).toBe(SecurityLevel.TRUSTED_ENVIRONMENT);
  });

  it("does not call a software key hardware-generated", () => {
    const software = parseKeyDescription(
      keyDescription({
        securityLevel: SecurityLevel.SOFTWARE,
        keymasterSecurityLevel: SecurityLevel.SOFTWARE,
      }),
    );
    expect(isHardwareGenerated(software)).toBe(false);
  });

  it("does not call an imported key hardware-generated", () => {
    const imported = parseKeyDescription(keyDescription({ tee: { origin: KeyOrigin.IMPORTED } }));
    expect(isHardwareGenerated(imported)).toBe(false);
  });

  it("treats a missing origin as not hardware-generated", () => {
    expect(isHardwareGenerated(parseKeyDescription(keyDescription({ tee: {} })))).toBe(false);
  });

  it("lists device-identifier tags from both authorization lists", () => {
    const withIds = parseKeyDescription(
      keyDescription({
        software: { identifierTags: [717] },
        tee: { origin: KeyOrigin.GENERATED, identifierTags: [714, 710] },
      }),
    );
    expect(deviceIdentifierTags(withIds)).toEqual([710, 714, 717]);
  });

  it("does not mistake patch levels for device identifiers", () => {
    // 718 vendorPatchLevel and 719 bootPatchLevel sit inside the 710–723 span and are present on
    // ordinary devices; treating the span as PII would reject clean chains.
    const clean = parseKeyDescription(
      keyDescription({ tee: { origin: KeyOrigin.GENERATED, identifierTags: [718, 719, 720] } }),
    );
    expect(deviceIdentifierTags(clean)).toEqual([]);
  });

  it.each([
    ["trailing bytes", () => concat(keyDescription(), Uint8Array.of(0)), /trailing bytes/],
    ["too few fields", () => seq(integer(1n), enumerated(2)), /expected at least 8/],
    [
      "a challenge that is not an OCTET STRING",
      () =>
        seq(
          integer(300n),
          enumerated(2),
          integer(300n),
          enumerated(2),
          integer(1n),
          octet(new Uint8Array(0)),
          seq(),
          seq(),
        ),
      /attestationChallenge is not an OCTET STRING/,
    ],
    [
      "an authorization entry that is not context-tagged",
      () =>
        seq(
          integer(300n),
          enumerated(2),
          integer(300n),
          enumerated(2),
          octet(new Uint8Array(0)),
          octet(new Uint8Array(0)),
          seq(),
          seq(integer(1n)),
        ),
      /not context-tagged/,
    ],
  ])("rejects %s", (_label, build, message) => {
    expect(() => parseKeyDescription(build())).toThrow(message);
  });

  it("rejects a RootOfTrust with a malformed deviceLocked", () => {
    const bad = seq(
      integer(300n),
      enumerated(2),
      integer(300n),
      enumerated(2),
      octet(new Uint8Array(0)),
      octet(new Uint8Array(0)),
      seq(),
      seq(ctx(704, seq(octet(new Uint8Array(32)), tlv(0x01, new Uint8Array(0)), enumerated(0)))),
    );
    expect(() => parseKeyDescription(bad)).toThrow(/deviceLocked is not a BOOLEAN/);
  });
});

describe("structural refusals that a lenient parser would wave through", () => {
  const tbsParts = (spkiPart: Uint8Array, trailing: readonly Uint8Array[] = []): Uint8Array[] => [
    ctx(0, integer(2n)),
    integer(1n),
    seq(oid(OID_ECDSA_SHA256)),
    name("intermediate"),
    validity(),
    name("leaf"),
    spkiPart,
    ...trailing,
  ];

  /** Signs whatever `tbs` it is given, so a malformed body still arrives with a valid signature. */
  function signed(parts: readonly Uint8Array[], signature?: Uint8Array): Uint8Array {
    const tbs = seq(...parts);
    const compact = p256.sign(sha256(tbs), SECRETS.intermediate, { prehash: false });
    const value =
      signature ??
      bits(
        seq(
          integer(BigInt(bytesToHex(compact.subarray(0, 32)))),
          integer(BigInt(bytesToHex(compact.subarray(32, 64)))),
        ),
      );
    return seq(tbs, seq(oid(OID_ECDSA_SHA256)), value);
  }

  it("rejects trailing bytes inside the signature BIT STRING", () => {
    const stuffed = bits(concat(seq(integer(1n), integer(1n)), Uint8Array.of(0x05, 0x00)));
    expect(() => parseCertificate(signed(tbsParts(spki(publicOf(SECRETS.leaf))), stuffed))).toThrow(
      /trailing bytes after ECDSA-Sig-Value/,
    );
  });

  it("rejects an Extensions wrapper that is not a SEQUENCE", () => {
    const der = signed(tbsParts(spki(publicOf(SECRETS.leaf)), [ctx(3, octet(Uint8Array.of(1)))]));
    expect(() => parseCertificate(der)).toThrow(/Extensions is not a SEQUENCE/);
  });

  it("rejects an AuthorizationList that is not a SEQUENCE", () => {
    const bad = seq(
      integer(300n),
      enumerated(2),
      integer(300n),
      enumerated(2),
      octet(new Uint8Array(0)),
      octet(new Uint8Array(0)),
      octet(new Uint8Array(0)),
      seq(),
    );
    expect(() => parseKeyDescription(bad)).toThrow(/AuthorizationList is not a SEQUENCE/);
  });

  it("rejects a RootOfTrust that is not a SEQUENCE", () => {
    const bad = seq(
      integer(300n),
      enumerated(2),
      integer(300n),
      enumerated(2),
      octet(new Uint8Array(0)),
      octet(new Uint8Array(0)),
      seq(),
      seq(ctx(704, integer(1n))),
    );
    expect(() => parseKeyDescription(bad)).toThrow(/RootOfTrust is not a SEQUENCE/);
  });
});

// ── chain.ts ──────────────────────────────────────────────────────────────────────────────────

describe("verifyAttestationChain", () => {
  it("accepts a chain that reaches a pinned anchor", () => {
    const verified = verifyAttestationChain(buildChain(), { anchors: ANCHORS });
    expect(verified.securityLevel).toBe(SecurityLevel.STRONG_BOX);
    expect(verified.anchorIndex).toBe(1);
    expect(verified.keyCommitment).toBe(commitmentOf(SECRETS.leaf));
  });

  it("binds the challenge when the caller supplies one", () => {
    const challenge = utf8("principal-and-nonce");
    const chain = buildChain({ challenge });
    expect(
      verifyAttestationChain(chain, { anchors: ANCHORS, expectedChallenge: challenge }),
    ).toBeTruthy();
    expect(() =>
      verifyAttestationChain(chain, { anchors: ANCHORS, expectedChallenge: utf8("different") }),
    ).toThrow(/challenge does not match/);
  });

  it("refuses a chain signed by the wrong key", () => {
    const forged = certificate({
      subject: "leaf",
      issuer: "intermediate",
      subjectKey: publicOf(SECRETS.leaf),
      issuerSecret: SECRETS.rogue,
      extensions: [extension(OID_KEY_DESCRIPTION, keyDescription())],
    });
    const [, intermediate] = buildChain();
    expect(() =>
      verifyAttestationChain([forged, intermediate as Uint8Array], { anchors: ANCHORS }),
    ).toThrow(/signature does not verify/);
  });

  it("refuses a chain whose issuer name does not link", () => {
    const mislinked = certificate({
      subject: "leaf",
      issuer: "not-the-intermediate",
      subjectKey: publicOf(SECRETS.leaf),
      issuerSecret: SECRETS.intermediate,
      extensions: [extension(OID_KEY_DESCRIPTION, keyDescription())],
    });
    const [, intermediate] = buildChain();
    expect(() =>
      verifyAttestationChain([mislinked, intermediate as Uint8Array], { anchors: ANCHORS }),
    ).toThrow(/issuer does not match/);
  });

  it("refuses a chain that never reaches an anchor", () => {
    expect(() =>
      verifyAttestationChain(buildChain(), { anchors: [commitmentOf(SECRETS.rogue)] }),
    ).toThrow(/does not reach a pinned trust anchor/);
  });

  it("refuses to let a leaf be its own anchor", () => {
    expect(() =>
      verifyAttestationChain(buildChain(), { anchors: [commitmentOf(SECRETS.leaf)] }),
    ).toThrow(/cannot be its own trust anchor/);
  });

  it("refuses a chain that is not signed with ecdsa-with-SHA256", () => {
    const chain = buildChain({}, { signatureOid: OID_ECDSA_SHA384 });
    expect(() => verifyAttestationChain(chain, { anchors: ANCHORS })).toThrow(/ecdsa-with-SHA256/);
  });

  it.each([
    [
      "a single certificate",
      () => [buildChain()[0] as Uint8Array],
      /needs a leaf and at least one issuer/,
    ],
    ["an empty anchor set", () => buildChain(), /no trust anchors configured/],
  ])("refuses %s", (label, build, message) => {
    const policy = label === "an empty anchor set" ? { anchors: [] } : { anchors: ANCHORS };
    expect(() => verifyAttestationChain(build(), policy)).toThrow(message);
  });

  it("refuses a leaf with no attestation extension", () => {
    const bare = certificate({
      subject: "leaf",
      issuer: "intermediate",
      subjectKey: publicOf(SECRETS.leaf),
      issuerSecret: SECRETS.intermediate,
    });
    const [, intermediate] = buildChain();
    expect(() =>
      verifyAttestationChain([bare, intermediate as Uint8Array], { anchors: ANCHORS }),
    ).toThrow(/no key attestation extension/);
  });

  it("refuses a software-backed or imported key", () => {
    expect(() =>
      verifyAttestationChain(
        buildChain({
          securityLevel: SecurityLevel.SOFTWARE,
          keymasterSecurityLevel: SecurityLevel.SOFTWARE,
        }),
        { anchors: ANCHORS },
      ),
    ).toThrow(/not generated inside a secure element/);
    expect(() =>
      verifyAttestationChain(buildChain({ tee: { origin: KeyOrigin.IMPORTED } }), {
        anchors: ANCHORS,
      }),
    ).toThrow(/not generated inside a secure element/);
  });

  it("enforces a StrongBox floor when one is asked for", () => {
    const tee = buildChain({
      securityLevel: SecurityLevel.TRUSTED_ENVIRONMENT,
      keymasterSecurityLevel: SecurityLevel.TRUSTED_ENVIRONMENT,
    });
    expect(verifyAttestationChain(tee, { anchors: ANCHORS }).securityLevel).toBe(
      SecurityLevel.TRUSTED_ENVIRONMENT,
    );
    expect(() =>
      verifyAttestationChain(tee, {
        anchors: ANCHORS,
        minimumSecurityLevel: SecurityLevel.STRONG_BOX,
      }),
    ).toThrow(/below the required minimum/);
  });
});

// ── hardwareDigest.ts ─────────────────────────────────────────────────────────────────────────

describe("hardwareCaptureDigest", () => {
  const base = {
    chainId: 10143n,
    origin: `0x${"ab".repeat(20)}`,
    contentHash: `0x${"cd".repeat(32)}`,
    capturedAt: 1_790_000_000n,
    nonce: `0x${"ef".repeat(32)}`,
    deviceClass: `0x${"12".repeat(32)}`,
  } as const;

  it("is stable for the same inputs", () => {
    expect(hardwareCaptureDigest(base)).toBe(hardwareCaptureDigest({ ...base }));
    expect(hardwareCaptureDigest(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is sha256 of the preimage the phone is actually given", () => {
    // The whole Android bridge rests on this equality. A Keystore key built with DIGEST_SHA256
    // will not sign a pre-hashed value, so the element is handed the preimage and runs
    // SHA256withECDSA over it. If these two ever diverge, every device signature verifies
    // nowhere, and it would look like a broken curve rather than a broken payload.
    expect(bytesToHex(sha256(hardwareCapturePreimage(base)))).toBe(hardwareCaptureDigest(base));
  });

  it("has the length the companion app asserts", () => {
    // 23 domain + 32 chainId + 20 origin + 32 h + 8 capturedAt + 32 nonce + 32 deviceClass.
    expect(hardwareCapturePreimage(base)).toHaveLength(HARDWARE_CAPTURE_PREIMAGE_BYTES);
    expect(HARDWARE_CAPTURE_PREIMAGE_BYTES).toBe(179);
  });

  it("begins with the domain separator, so bytes from another scheme cannot collide", () => {
    expect(hardwareCapturePreimage(base).slice(0, 23)).toEqual(utf8(HARDWARE_CAPTURE_DOMAIN));
  });

  it("validates before building the preimage, not only before hashing", () => {
    expect(() => hardwareCapturePreimage({ ...base, origin: "0x00" })).toThrow(/origin/);
  });

  it.each([
    ["chainId", { chainId: 1n }],
    ["origin", { origin: `0x${"ac".repeat(20)}` as const }],
    ["contentHash", { contentHash: `0x${"ce".repeat(32)}` as const }],
    ["capturedAt", { capturedAt: 1_790_000_001n }],
    ["nonce", { nonce: `0x${"e0".repeat(32)}` as const }],
    ["deviceClass", { deviceClass: `0x${"13".repeat(32)}` as const }],
  ])("changes when %s changes", (_label, patch) => {
    expect(hardwareCaptureDigest({ ...base, ...patch })).not.toBe(hardwareCaptureDigest(base));
  });

  it("rejects malformed inputs rather than hashing them", () => {
    expect(() => hardwareCaptureDigest({ ...base, origin: "0x00" })).toThrow(/origin/);
    expect(() => hardwareCaptureDigest({ ...base, contentHash: "0x00" })).toThrow(/contentHash/);
    expect(() => hardwareCaptureDigest({ ...base, nonce: "0x00" })).toThrow(/nonce/);
    expect(() => hardwareCaptureDigest({ ...base, deviceClass: "0x00" })).toThrow(/deviceClass/);
  });

  it("commits to the device key the way the principal registry commits to an authority key", () => {
    expect(deviceKeyCommitment(p256PublicKeyFromUncompressed(publicOf(SECRETS.leaf)))).toBe(
      commitmentOf(SECRETS.leaf),
    );
  });
});

describe("verifyCaptureWitness", () => {
  const publicKey = p256PublicKeyFromUncompressed(publicOf(SECRETS.leaf));
  const digest = hardwareCaptureDigest({
    chainId: 10143n,
    origin: `0x${"ab".repeat(20)}`,
    contentHash: `0x${"cd".repeat(32)}`,
    capturedAt: 1_790_000_000n,
    nonce: `0x${"ef".repeat(32)}`,
    deviceClass: commitmentOf(SECRETS.leaf),
  });

  const sign = (d: Bytes32, secret: Uint8Array) =>
    bytesToHex(p256.sign(hexToBytes(d), secret, { prehash: false }));

  it("accepts a witness from the attested key", () => {
    expect(verifyCaptureWitness(digest, sign(digest, SECRETS.leaf), publicKey)).toBe(true);
  });

  it("refuses a witness from any other key — this is the transplantation claim", () => {
    expect(verifyCaptureWitness(digest, sign(digest, SECRETS.rogue), publicKey)).toBe(false);
  });

  it("refuses a witness over a different digest", () => {
    const elsewhere = hardwareCaptureDigest({
      chainId: 10143n,
      origin: `0x${"ac".repeat(20)}`,
      contentHash: `0x${"cd".repeat(32)}`,
      capturedAt: 1_790_000_000n,
      nonce: `0x${"ef".repeat(32)}`,
      deviceClass: commitmentOf(SECRETS.leaf),
    });
    expect(verifyCaptureWitness(digest, sign(elsewhere, SECRETS.leaf), publicKey)).toBe(false);
  });

  it("is total: a malformed signature is false, not a throw", () => {
    expect(verifyCaptureWitness(digest, "0xdead", publicKey)).toBe(false);
  });
});

// ── the shared golden suite ───────────────────────────────────────────────────────────────────
// The same certificates the Solidity reader is tested against. Two implementations agreeing on
// bytes neither of them produced is the only thing that catches a shared misreading of DER.

describe("android-attestation vectors", () => {
  const vectors = loadVectors("android-attestation", {
    input: z.object({ certificate: z.string() }),
    expected: z.record(z.string(), z.unknown()),
    extra: z.object({
      anchorCommitment: z.string(),
      chain: z.array(z.string()),
      challenge: z.string(),
      deviceCommitment: z.string(),
      nonce: z.string(),
      oidKeyDescription: z.string(),
      principalId: z.string(),
    }),
  });

  it("has hand-derived cases, so the two readers cannot be wrong together", () => {
    expect(vectors.cases.filter((c) => c.hand).length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const der = hexToBytes(c.input.certificate as `0x${string}`);
    const e = c.expected as Record<string, string | boolean>;

    // A case whose certificate parses and whose refusal belongs to the chain walk is the
    // registry's to test, not a reader's.
    if (e["parses"]) {
      expect(() => parseCertificate(der)).not.toThrow();
      return;
    }
    if (typeof e["error"] === "string") {
      // Some shapes are a valid certificate carrying an invalid extension: the refusal belongs to
      // whichever reader is actually looking at the malformed bytes.
      if (e["onKeyDescription"]) expect(() => keyDescriptionOf(parseCertificate(der))).toThrow();
      else expect(() => parseCertificate(der)).toThrow();
      return;
    }

    const cert = parseCertificate(der);
    expect(cert.publicKey.x).toBe(e["x"]);
    expect(cert.publicKey.y).toBe(e["y"]);
    expect(bytesToHex(sha256(cert.tbs))).toBe(e["tbsHash"]);
    expect(cert.signedWithEcdsaSha256).toBe(e["sha256Ecdsa"]);

    const description = keyDescriptionOf(cert);
    expect(description !== null).toBe(e["hasKeyDescription"]);
    if (description) {
      expect(String(description.attestationSecurityLevel)).toBe(e["securityLevel"]);
      expect(bytesToHex(description.attestationChallenge)).toBe(vectors.extra.challenge);
      // A fixture destined for a public repository carries no device identifiers.
      expect(deviceIdentifierTags(description)).toEqual([]);
      // Absence is reported as absence. A default would be a value nobody attested.
      expect(description.teeEnforced.origin !== null).toBe(e["hasOrigin"] ?? true);
      expect(description.teeEnforced.rootOfTrust !== null).toBe(e["hasRootOfTrust"] ?? true);
      if (e["origin"] !== undefined)
        expect(String(description.teeEnforced.origin)).toBe(e["origin"]);
      if (e["verifiedBootState"] !== undefined) {
        expect(String(description.teeEnforced.rootOfTrust?.verifiedBootState)).toBe(
          e["verifiedBootState"],
        );
      }
    }
  });

  it("normalises the high-s leaf to the same signature as the low-s one", () => {
    const of = (name: string) =>
      parseCertificate(
        hexToBytes(
          (vectors.cases.find((c) => c.name === name)?.input.certificate ?? "0x") as `0x${string}`,
        ),
      );
    expect(of("hand/leaf-high-s").signature).toBe(of("hand/leaf").signature);
  });

  it("verifies the chain to the pinned anchor and recovers the device commitment", () => {
    const verified = verifyAttestationChain(
      vectors.extra.chain.map((hex) => hexToBytes(hex as `0x${string}`)),
      {
        anchors: [vectors.extra.anchorCommitment as Bytes32],
        expectedChallenge: hexToBytes(vectors.extra.challenge as `0x${string}`),
        minimumSecurityLevel: SecurityLevel.STRONG_BOX,
      },
    );
    expect(verified.keyCommitment).toBe(vectors.extra.deviceCommitment);
    expect(verified.securityLevel).toBe(SecurityLevel.STRONG_BOX);
    expect(verified.anchorIndex).toBe(1);
  });

  it("refuses the same chain under any other anchor", () => {
    expect(() =>
      verifyAttestationChain(
        vectors.extra.chain.map((hex) => hexToBytes(hex as `0x${string}`)),
        { anchors: [`0x${"99".repeat(32)}`] },
      ),
    ).toThrow(/does not reach a pinned trust anchor/);
  });
});
