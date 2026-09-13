import { loadVectors } from "@firsthand/test-vectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Address, type Bytes32, type Hex, hexToBytes, utf8, ZERO_HASH } from "../bytes.js";
import { ValidationError } from "../errors.js";
import { keccak256Hex } from "../hash.js";
import { contentHash, jcs } from "./canonical.js";
import {
  ATTESTATION_TYPEHASH,
  DOMAIN_TYPEHASH,
  digestOf,
  domainSeparator,
  hashAttestation,
  hashTerms,
  LICENSE_FH_1_0,
  PASSPORT_TYPEHASH,
  passportDigest,
  passportId,
  TERMS_TYPEHASH,
  tag,
} from "./typed.js";
import { type Attestation, AttestationClass, type Passport, type Terms } from "./types.js";
import {
  addressOfPublicKey,
  parseSignature,
  recoverSigner,
  verifyPassportSignature,
} from "./verify.js";

const B32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .transform((v) => v as Bytes32);
const Addr = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .transform((v) => v as Address);
const Big = z.string().transform(BigInt);

const FullInput = z.object({
  domain: z.object({ chainId: Big, verifyingContract: Addr }),
  terms: z.object({
    price: Big,
    licenseId: B32,
    scope: z.number(),
    ns: z.number(),
    rateLimit: z.number(),
    payees: z.array(Addr),
    weights: z.array(Big),
  }),
  attestation: z.object({
    class: z.number(),
    capturedAt: Big,
    sourceTag: B32,
    deviceClass: B32,
    metaHash: B32,
  }),
  passport: z.object({ h: B32, origin: Addr, attest: B32, termsHash: B32, epoch: Big, nonce: B32 }),
  signature: z.string().transform((v) => v as Hex),
});
const FullExpected = z.object({
  termsHash: B32,
  attest: B32,
  passportId: B32,
  domainSeparator: B32,
  digest: B32,
  recovered: z.string(),
  valid: z.boolean(),
});
const TypehashExpected = z.object({
  passportTypehash: B32,
  termsTypehash: B32,
  attestationTypehash: B32,
  domainTypehash: B32,
  licenseFh10: B32,
  sourceTagChatgpt: B32,
});

const vectors = loadVectors("passport", { input: z.unknown(), expected: z.unknown() });

describe("passport vectors", () => {
  for (const c of vectors.cases) {
    if (c.name === "hand/typehashes") {
      it(c.name, () => {
        const e = TypehashExpected.parse(c.expected);
        expect(PASSPORT_TYPEHASH).toBe(e.passportTypehash);
        expect(TERMS_TYPEHASH).toBe(e.termsTypehash);
        expect(ATTESTATION_TYPEHASH).toBe(e.attestationTypehash);
        expect(DOMAIN_TYPEHASH).toBe(e.domainTypehash);
        expect(LICENSE_FH_1_0).toBe(e.licenseFh10);
        expect(tag("chatgpt-export-v1")).toBe(e.sourceTagChatgpt);
      });
      continue;
    }
    it(c.name, () => {
      const input = FullInput.parse(c.input);
      const expected = FullExpected.parse(c.expected);
      const terms: Terms = input.terms;
      const attestation = input.attestation as Attestation;
      const passport: Passport = input.passport;
      expect(hashTerms(terms)).toBe(expected.termsHash);
      expect(hashAttestation(attestation)).toBe(expected.attest);
      expect(passportId(passport)).toBe(expected.passportId);
      expect(domainSeparator(input.domain)).toBe(expected.domainSeparator);
      expect(passportDigest(passport, input.domain)).toBe(expected.digest);
      expect(recoverSigner(expected.digest, input.signature) ?? ZERO_HASH.slice(0, 42)).toBe(
        expected.recovered,
      );
      expect(verifyPassportSignature(passport, input.signature, input.domain)).toBe(expected.valid);
    });
  }
});

const baseTerms: Terms = {
  price: 1n,
  licenseId: LICENSE_FH_1_0,
  scope: 1,
  ns: 0,
  rateLimit: 1,
  payees: [`0x${"22".repeat(20)}` as Address],
  weights: [10n ** 18n],
};

describe("typed hashing validation", () => {
  it("rejects misaligned or empty payees/weights", () => {
    expect(() => hashTerms({ ...baseTerms, weights: [] })).toThrow(ValidationError);
    expect(() => hashTerms({ ...baseTerms, payees: [], weights: [] })).toThrow(ValidationError);
    expect(() =>
      hashTerms({
        ...baseTerms,
        payees: new Array<Address>(17).fill(baseTerms.payees[0] as Address),
        weights: new Array<bigint>(17).fill(1n),
      }),
    ).toThrow(ValidationError);
  });
  it("rejects out-of-range integers and malformed hex", () => {
    expect(() => hashTerms({ ...baseTerms, price: 1n << 64n })).toThrow(RangeError);
    expect(() => hashTerms({ ...baseTerms, licenseId: "0x00" as Bytes32 })).toThrow(TypeError);
    expect(() => hashTerms({ ...baseTerms, payees: ["0x1" as Address] })).toThrow(TypeError);
    const attestation: Attestation = {
      class: AttestationClass.UNATTESTED,
      capturedAt: 0n,
      sourceTag: ZERO_HASH,
      deviceClass: ZERO_HASH,
      metaHash: ZERO_HASH,
    };
    expect(() => hashAttestation({ ...attestation, class: 256 as AttestationClass })).toThrow(
      RangeError,
    );
    expect(() => hashAttestation({ ...attestation, metaHash: "0x" as Bytes32 })).toThrow(TypeError);
    const passport: Passport = {
      h: ZERO_HASH,
      origin: baseTerms.payees[0] as Address,
      attest: ZERO_HASH,
      termsHash: ZERO_HASH,
      epoch: 0n,
      nonce: ZERO_HASH,
    };
    expect(() => passportId({ ...passport, epoch: -1n })).toThrow(RangeError);
    expect(() => passportId({ ...passport, h: "0x" as Bytes32 })).toThrow(TypeError);
    expect(() => domainSeparator({ chainId: 1n, verifyingContract: "0x" as Address })).toThrow(
      TypeError,
    );
  });
  it("digestOf follows the 0x1901 prefix rule", () => {
    const sh = keccak256Hex(utf8("s"));
    const ds = keccak256Hex(utf8("d"));
    const manual = keccak256Hex(new Uint8Array([0x19, 0x01, ...hexToBytes(ds), ...hexToBytes(sh)]));
    expect(digestOf(sh, ds)).toBe(manual);
  });
});

describe("jcs (RFC 8785)", () => {
  it("sorts keys, strips whitespace, and serialises primitives like JSON.stringify", () => {
    expect(jcs({ b: 1, a: [true, null, "x\né"], c: { z: 0, y: -0 } })).toBe(
      '{"a":[true,null,"x\\né"],"b":1,"c":{"y":0,"z":0}}',
    );
    expect(jcs(1e21)).toBe("1e+21");
    expect(jcs(0.1)).toBe("0.1");
    expect(jcs("")).toBe('""');
    expect(jcs(false)).toBe("false");
  });
  it("sorts keys by UTF-16 code units", () => {
    expect(jcs({ "€": 1, "😀": 2, a: 3 })).toBe('{"a":3,"€":1,"😀":2}');
  });
  it("rejects non-JSON values", () => {
    expect(() => jcs(Number.NaN)).toThrow(ValidationError);
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => jcs({ a: undefined } as never)).toThrow(ValidationError);
    expect(() => jcs([undefined] as never)).toThrow(ValidationError);
    expect(() => jcs((() => 1) as never)).toThrow(ValidationError);
    expect(() => jcs(1n as never)).toThrow(ValidationError);
  });
  it("contentHash covers both datum kinds and is key-order independent for json", () => {
    const bytes = utf8("hello");
    expect(contentHash({ kind: "bytes", bytes })).toBe(keccak256Hex(bytes));
    expect(contentHash({ kind: "json", value: { a: 1, b: 2 } })).toBe(
      contentHash({ kind: "json", value: { b: 2, a: 1 } }),
    );
    expect(() => contentHash({ kind: "nope" } as never)).toThrow(ValidationError);
  });
});

describe("signature parsing", () => {
  const r = "11".repeat(32);
  const s = "22".repeat(32);
  it("rejects bad lengths, v values, zero r/s and high s", () => {
    expect(parseSignature("0x1234")).toBeNull();
    expect(parseSignature(`0x${r}${s}1a`)).toBeNull();
    expect(parseSignature(`0x${"00".repeat(32)}${s}1b`)).toBeNull();
    expect(parseSignature(`0x${r}${"00".repeat(32)}1b`)).toBeNull();
    expect(parseSignature(`0x${r}${"ff".repeat(32)}1b`)).toBeNull();
    expect(parseSignature(`0x${"ff".repeat(32)}${s}1b`)).toBeNull();
    expect(parseSignature(`0x${r}${s}1c`)).toEqual({
      r: BigInt(`0x${r}`),
      s: BigInt(`0x${s}`),
      v: 28,
    });
  });
  it("recoverSigner returns null for unrecoverable signatures", () => {
    expect(recoverSigner(ZERO_HASH, "0x00")).toBeNull();
    expect(recoverSigner(ZERO_HASH, `0x${r}${s}1b`)).toBeNull();
  });
  it("addressOfPublicKey requires an uncompressed key", () => {
    expect(() => addressOfPublicKey(new Uint8Array(33))).toThrow(TypeError);
  });
});
