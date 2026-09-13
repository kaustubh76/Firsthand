import {
  type Bytes32,
  bytesToHex,
  CryptoError,
  hexToBytes,
  P256_N,
  verifyP256,
} from "@firsthand/core";
import { loadVectors } from "@firsthand/test-vectors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PRF_EVAL_SALT, StaticPrfSource } from "../prf/index.js";
import { signAuthorityDigest } from "../sign/p256.js";
import { infoDep, infoId, infoNonce, infoNs, KDF_LENGTH, KdfLabel } from "./info.js";
import { KeyTree } from "./keytree.js";
import { scalarFromOkm } from "./scalar.js";

const Hex = z
  .string()
  .regex(/^0x[0-9a-f]*$/)
  .transform((v) => v as `0x${string}`);
const Input = z.object({
  prf: Hex,
  ns: z.number(),
  epoch: z.string().transform(BigInt),
  contentHash: Hex,
});
const Expected = z.object({
  prk: Hex,
  kIdScalar: Hex,
  p256X: Hex,
  p256Y: Hex,
  p256Commit: Hex,
  kNs: Hex,
  kDepScalar: Hex,
  depositPublicKey: Hex,
  origin: Hex,
  kNonce: Hex,
  passportNonce: Hex,
});
const vectors = loadVectors("keys", { input: Input, expected: Expected });

describe("key tree vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const tree = KeyTree.fromPrf(hexToBytes(c.input.prf));
      expect(bytesToHex(tree.prk().expose())).toBe(c.expected.prk);
      const authority = tree.authorityKey();
      expect(bytesToHex(authority.scalar.expose())).toBe(c.expected.kIdScalar);
      expect(authority.publicKey).toEqual({ x: c.expected.p256X, y: c.expected.p256Y });
      expect(authority.commitment).toBe(c.expected.p256Commit);
      expect(bytesToHex(tree.vaultKey(c.input.ns, c.input.epoch).expose())).toBe(c.expected.kNs);
      const deposit = tree.depositKey(c.input.ns, c.input.epoch);
      expect(bytesToHex(deposit.privateKey.expose())).toBe(c.expected.kDepScalar);
      expect(deposit.publicKey).toBe(c.expected.depositPublicKey);
      expect(deposit.address).toBe(c.expected.origin);
      expect(bytesToHex(tree.nonceKey(c.input.ns, c.input.epoch).expose())).toBe(c.expected.kNonce);
      expect(tree.passportNonce(c.input.ns, c.input.epoch, c.input.contentHash as Bytes32)).toBe(
        c.expected.passportNonce,
      );
      tree.dispose();
    });
  }
});

describe("key tree behaviour", () => {
  const prf = () => new Uint8Array(32).fill(7);

  it("zeroizes the PRF input and refuses wrong lengths", () => {
    const input = prf();
    const tree = KeyTree.fromPrf(input);
    expect(input.every((b) => b === 0)).toBe(true);
    expect(() => KeyTree.fromPrf(new Uint8Array(31))).toThrow(CryptoError);
    expect(JSON.stringify({ tree })).toBe('{"tree":"[KeyTree]"}');
    tree.dispose();
    expect(() => tree.authorityKey()).toThrow(CryptoError);
  });

  it("builds from a PrfSource using the fixed evaluation salt", async () => {
    StaticPrfSource.resetWarning();
    const warnings: string[] = [];
    const source = new StaticPrfSource(prf(), {
      unsafeAcknowledged: true,
      warn: (m) => warnings.push(m),
    });
    const tree = await KeyTree.fromSource(source);
    expect(warnings).toHaveLength(1);
    expect(source.kind).toBe("static-unsafe");
    expect(PRF_EVAL_SALT).toHaveLength(32);
    expect(tree.authorityKey().commitment).toBe(KeyTree.fromPrf(prf()).authorityKey().commitment);
    // Second construction does not warn again.
    new StaticPrfSource(prf(), { unsafeAcknowledged: true, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  it("StaticPrfSource requires the unsafe acknowledgement and 32 bytes", () => {
    expect(
      () => new StaticPrfSource(prf(), { unsafeAcknowledged: false as unknown as true }),
    ).toThrow(CryptoError);
    expect(() => new StaticPrfSource(new Uint8Array(16), { unsafeAcknowledged: true })).toThrow(
      CryptoError,
    );
  });

  it("derives distinct keys for distinct (ns, epoch) and identical keys for identical inputs", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        fc.bigInt({ min: 0n, max: 1n << 40n }),
        fc.bigInt({ min: 0n, max: 1n << 40n }),
        (seed, ns1, ns2, e1, e2) => {
          const a = KeyTree.fromPrf(new Uint8Array(seed));
          const b = KeyTree.fromPrf(new Uint8Array(seed));
          const k1 = bytesToHex(a.vaultKey(ns1, e1).expose());
          const k2 = bytesToHex(b.vaultKey(ns2, e2).expose());
          expect(k1 === k2).toBe(ns1 === ns2 && e1 === e2);
          expect(a.depositKey(ns1, e1).address).toBe(b.depositKey(ns1, e1).address);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("the authority key signs digests that core's verifier accepts", () => {
    const tree = KeyTree.fromPrf(prf());
    const authority = tree.authorityKey();
    const digest: Bytes32 = `0x${"ab".repeat(32)}`;
    const sig = signAuthorityDigest(authority.scalar, digest);
    expect(verifyP256(digest, sig, authority.publicKey)).toBe(true);
    expect(verifyP256(`0x${"ac".repeat(32)}`, sig, authority.publicKey)).toBe(false);
  });

  it("validates namespace and epoch ranges", () => {
    const tree = KeyTree.fromPrf(prf());
    expect(() => tree.vaultKey(16, 0n)).toThrow(CryptoError);
    expect(() => tree.vaultKey(-1, 0n)).toThrow(CryptoError);
    expect(() => tree.vaultKey(1.5, 0n)).toThrow(CryptoError);
    expect(() => tree.depositKey(0, -1n)).toThrow(CryptoError);
    expect(() => tree.nonceKey(0, 1n << 64n)).toThrow(CryptoError);
    expect(() => tree.passportNonce(0, 0n, "0x12" as Bytes32)).toThrow(TypeError);
  });
});

describe("info encodings and scalar mapping", () => {
  it("are NUL-terminated and scoped", () => {
    expect(bytesToHex(infoId())).toBe("0x696400");
    expect(bytesToHex(infoNs(3, 7n))).toBe("0x6e7300000000030000000000000007");
    expect(bytesToHex(infoDep(3, 7n))).toBe("0x64657000000000030000000000000007");
    expect(bytesToHex(infoNonce(3, 7n))).toBe("0x6e6f6e636500000000030000000000000007");
    expect(Object.values(KdfLabel)).toHaveLength(4);
    expect(KDF_LENGTH.SCALAR).toBe(48);
  });
  it("scalarFromOkm lands in [1, n-1] and rejects bad input", () => {
    expect(scalarFromOkm(new Uint8Array(48), P256_N)).toBe(1n);
    expect(scalarFromOkm(new Uint8Array(48).fill(0xff), P256_N)).toBeLessThan(P256_N);
    expect(() => scalarFromOkm(new Uint8Array(32), P256_N)).toThrow(CryptoError);
    expect(() => scalarFromOkm(new Uint8Array(48), 2n)).toThrow(CryptoError);
  });
});
