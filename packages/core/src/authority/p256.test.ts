import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import { type Bytes32, bytesToHex, hexToBytes, u256be } from "../bytes.js";
import { keccak256Utf8 } from "../hash.js";
import {
  encodeP256Signature,
  P256_N,
  p256Commitment,
  p256PublicKeyFromUncompressed,
  parseP256Signature,
  verifyP256,
} from "./p256.js";

/** OpenSSL-derived hand case (see packages/crypto/scripts/gen-vectors.ts HAND constants). */
const HAND = {
  x: "0xcdd61de9b78f38ec9fd29181202f4fdd5f1b42f9bacb4d3198f9c4268bbdac39",
  y: "0x0ce7ab1ac7587227ffd5387b1db83aa9a642f55396b872f143e2a5ee46d23cd8",
  digest: "0x0deab5a2880087abad7cbb743483e65a0774a4a78ea6e21104948bdf0d2aff31",
  r: 0x85822163f46fae19abd3662458d9856cfae5d48b2ddc7fe5fd1c95c1938e2086n,
  s: 0x6614e206b13f6ed4a355d7a7387f950cac4e82e632af6b8d4eee719d87acaa8cn,
  commitment: "0xf55f44dfb222251dcb5eedd8068d03f83aa4fdcc961206edd346bf43e7fbd034",
} as const;

describe("P-256 verification", () => {
  const pub = { x: HAND.x as Bytes32, y: HAND.y as Bytes32 };
  const sig = encodeP256Signature({ r: HAND.r, s: HAND.s });

  it("accepts the OpenSSL-produced signature and commitment", () => {
    expect(verifyP256(HAND.digest, sig, pub)).toBe(true);
    expect(p256Commitment(pub)).toBe(HAND.commitment);
    expect(parseP256Signature(sig)).toEqual({ r: HAND.r, s: HAND.s });
  });

  it("rejects high-s, wrong digest, tampered r, and malformed inputs", () => {
    const highS = encodeP256Signature({ r: HAND.r, s: P256_N - HAND.s });
    expect(verifyP256(HAND.digest, highS, pub)).toBe(false);
    expect(verifyP256(keccak256Utf8("other"), sig, pub)).toBe(false);
    expect(verifyP256(HAND.digest, encodeP256Signature({ r: HAND.r + 1n, s: HAND.s }), pub)).toBe(
      false,
    );
    expect(verifyP256("0x00" as Bytes32, sig, pub)).toBe(false);
    expect(verifyP256(HAND.digest, "0x1234", pub)).toBe(false);
    expect(verifyP256(HAND.digest, sig, { x: "0x" as Bytes32, y: HAND.y as Bytes32 })).toBe(false);
    expect(parseP256Signature(encodeP256Signature({ r: 0n, s: HAND.s }))).toBeNull();
    expect(parseP256Signature(encodeP256Signature({ r: P256_N, s: HAND.s }))).toBeNull();
    expect(parseP256Signature(encodeP256Signature({ r: HAND.r, s: 0n }))).toBeNull();
  });

  it("rejects an off-curve public key", () => {
    const offCurve = { x: HAND.x as Bytes32, y: bytesToHex(u256be(1n)) };
    expect(verifyP256(HAND.digest, sig, offCurve)).toBe(false);
  });

  it("parses uncompressed keys and rejects other encodings", () => {
    const priv = u256be(12345n);
    const uncompressed = p256.getPublicKey(priv, false);
    const key = p256PublicKeyFromUncompressed(uncompressed);
    expect(hexToBytes(key.x)).toEqual(uncompressed.subarray(1, 33));
    expect(() => p256PublicKeyFromUncompressed(p256.getPublicKey(priv, true))).toThrow(TypeError);
    expect(() => p256Commitment({ x: "0x" as Bytes32, y: key.y })).toThrow(TypeError);
  });
});
