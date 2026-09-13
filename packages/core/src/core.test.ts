import { describe, expect, it } from "vitest";
import {
  type Address,
  assertAddress,
  assertBytes32,
  assertHex,
  assertLength,
  bytesEqual,
  bytesToBigInt,
  bytesToHex,
  concat,
  type Hex,
  hexToBytes,
  isHex,
  isHexOfLength,
  pad32,
  u8,
  u32be,
  u64be,
  u256be,
  utf8,
  ZERO_ADDR,
  ZERO_HASH,
} from "./bytes.js";
import {
  ChainError,
  ConfigError,
  CryptoError,
  type FirsthandError,
  isFirsthandError,
  NotImplementedError,
  PaymentError,
  ProofError,
  RefusalError,
  TransportError,
  toProblemDetails,
  ValidationError,
} from "./errors.js";
import { keccak256, keccak256Hex, keccak256Utf8, sha256 } from "./hash.js";
import {
  AddressSchema,
  AttestationSchema,
  BigIntStringSchema,
  Bytes32Schema,
  GranteeCardSchema,
  GrantStateSchema,
  LineageManifestSchema,
  PassportSchema,
  SignedPassportSchema,
  TermsSchema,
  Uint64Schema,
} from "./schemas/index.js";

describe("bytes", () => {
  it("round-trips hex and validates shapes", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(bytesToHex(bytes)).toBe("0x0001feff");
    expect(hexToBytes("0x0001feff")).toEqual(bytes);
    expect(isHex("0x")).toBe(true);
    expect(isHex("0xABCD")).toBe(false);
    expect(isHex("0xabc")).toBe(false);
    expect(isHex(12)).toBe(false);
    expect(isHexOfLength(ZERO_HASH, 32)).toBe(true);
    expect(isHexOfLength(ZERO_ADDR, 32)).toBe(false);
    expect(() => assertHex("zz")).toThrow(TypeError);
    expect(() => assertBytes32(ZERO_ADDR)).toThrow(TypeError);
    expect(() => assertAddress(ZERO_HASH)).toThrow(TypeError);
    expect(() => assertHex(`0x${"ab".repeat(20)}`)).not.toThrow();
    expect(() => assertLength(bytes, 3)).toThrow(TypeError);
    expect(() => assertHex(`0x${"a".repeat(61)}`)).toThrow(/…/);
  });
  it("encodes integers big-endian with range checks", () => {
    expect(bytesToHex(u8(255))).toBe("0xff");
    expect(() => u8(256)).toThrow(RangeError);
    expect(bytesToHex(u32be(0xdeadbeef))).toBe("0xdeadbeef");
    expect(() => u32be(-1)).toThrow(RangeError);
    expect(bytesToHex(u64be(1n))).toBe("0x0000000000000001");
    expect(() => u64be(1n << 64n)).toThrow(RangeError);
    expect(bytesToHex(u256be(1n))).toBe(`0x${"00".repeat(31)}01`);
    expect(bytesToBigInt(u256be((1n << 256n) - 1n))).toBe((1n << 256n) - 1n);
    expect(() => u256be(1n << 256n)).toThrow(RangeError);
  });
  it("concat, pad32, utf8 and equality", () => {
    expect(concat(u8(1), u8(2), new Uint8Array())).toEqual(new Uint8Array([1, 2]));
    expect(pad32(u8(1))[31]).toBe(1);
    expect(() => pad32(new Uint8Array(33))).toThrow(TypeError);
    expect(utf8("hi")).toEqual(new Uint8Array([104, 105]));
    expect(bytesEqual(u8(1), u8(1))).toBe(true);
    expect(bytesEqual(u8(1), u8(2))).toBe(false);
    expect(bytesEqual(u8(1), new Uint8Array(2))).toBe(false);
  });
});

describe("hash", () => {
  it("keccak256 and sha256 of empty input match known digests", () => {
    expect(keccak256Hex(new Uint8Array())).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(bytesToHex(sha256(new Uint8Array()))).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(keccak256Utf8("")).toBe(bytesToHex(keccak256(new Uint8Array())));
  });
});

describe("errors", () => {
  it("carries code, retryable, context and serialises without cause", () => {
    const cause = new Error("boom");
    const e = new TransportError("FH_TRANSPORT", "rpc down", { cause, context: { url: "x" } });
    expect(e.code).toBe("FH_TRANSPORT");
    expect(e.retryable).toBe(true);
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("TransportError");
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      name: "TransportError",
      code: "FH_TRANSPORT",
      message: "rpc down",
      retryable: true,
      context: { url: "x" },
    });
    expect(new TransportError("FH_BTX_UNAVAILABLE", "no btx").retryable).toBe(false);
    expect(isFirsthandError(e)).toBe(true);
    expect(isFirsthandError(cause)).toBe(false);
  });
  it("every subclass maps to a problem-details status", () => {
    const samples: [FirsthandError, number][] = [
      [new ValidationError("v"), 400],
      [new ConfigError("c"), 500],
      [new NotImplementedError("x"), 501],
      [new RefusalError("FH_REFUSED_ORIGIN", "r"), 422],
      [new RefusalError("FH_REFUSED_DUPLICATE", "r"), 409],
      [new ProofError("FH_MERKLE_INVALID", "p"), 422],
      [new PaymentError("FH_PAYMENT_REQUIRED", "p"), 402],
      [new TransportError("FH_CIRCUIT_OPEN", "t"), 503],
      [new ChainError("c"), 502],
      [new CryptoError("k"), 500],
    ];
    for (const [err, status] of samples) {
      const pd = toProblemDetails(err);
      expect(pd.status).toBe(status);
      expect(pd.code).toBe(err.code);
      expect(pd.type).toBe(`urn:firsthand:error:${err.code.toLowerCase()}`);
    }
    expect(new NotImplementedError("btx").message).toContain("btx");
  });
  it("maps foreign errors to an opaque 500", () => {
    expect(toProblemDetails(new Error("secret detail"))).toMatchObject({
      status: 500,
      detail: "internal error",
    });
  });
});

describe("schemas", () => {
  const addr: Address = `0x${"ab".repeat(20)}`;
  const b32 = `0x${"cd".repeat(32)}`;
  it("primitives", () => {
    expect(AddressSchema.parse(addr)).toBe(addr);
    expect(AddressSchema.safeParse(addr.toUpperCase()).success).toBe(false);
    expect(Bytes32Schema.safeParse(addr).success).toBe(false);
    expect(BigIntStringSchema.parse("0")).toBe(0n);
    expect(BigIntStringSchema.safeParse("01").success).toBe(false);
    expect(Uint64Schema.safeParse((1n << 64n).toString()).success).toBe(false);
  });
  it("passport / terms / attestation wire shapes", () => {
    const terms = {
      price: "1",
      licenseId: b32,
      scope: 1,
      ns: 0,
      rateLimit: 1,
      payees: [addr],
      weights: ["1"],
    };
    expect(TermsSchema.parse(terms).price).toBe(1n);
    expect(TermsSchema.safeParse({ ...terms, weights: ["1", "2"] }).success).toBe(false);
    expect(
      AttestationSchema.safeParse({
        class: 9,
        capturedAt: "0",
        sourceTag: b32,
        deviceClass: b32,
        metaHash: b32,
      }).success,
    ).toBe(false);
    const passport = { h: b32, origin: addr, attest: b32, termsHash: b32, epoch: "3", nonce: b32 };
    expect(PassportSchema.parse(passport).epoch).toBe(3n);
    const signature: Hex = `0x${"00".repeat(65)}`;
    expect(SignedPassportSchema.parse({ passport, signature }).signature).toBe(signature);
    expect(
      GrantStateSchema.safeParse({
        granteeCard: b32,
        ns: 0,
        epochStart: "0",
        epochEnd: "0",
        termsHash: b32,
        status: 9,
      }).success,
    ).toBe(false);
    expect(
      GranteeCardSchema.parse({ cardId: b32, owner: addr, encryptionPubKey: b32, active: true })
        .active,
    ).toBe(true);
    const manifest = {
      version: 1,
      domain: { chainId: "10143", verifyingContract: addr },
      principalId: b32,
      ns: 0,
      generatedAt: "1",
      finalityDepth: 2,
      assets: [
        {
          signed: { passport, signature },
          batchRoot: b32,
          proof: { index: 0, siblings: new Array(8).fill(b32) },
          anchorBlock: "10",
          receipt: { receiptId: b32, grantId: b32, blockNumber: "11", txHash: b32 },
        },
      ],
    };
    expect(LineageManifestSchema.parse(manifest).assets).toHaveLength(1);
    expect(LineageManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
  });
});
