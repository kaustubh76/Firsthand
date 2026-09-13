import {
  addressOfPublicKey,
  type Bytes32,
  bytesToHex,
  hexToBytes,
  parseP256Signature,
  parseSignature,
  recoverSigner,
  verifyP256,
} from "@firsthand/core";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { SecretBytes } from "../zeroize.js";
import { signAuthorityDigest } from "./p256.js";
import { signPassportDigest } from "./secp.js";

const digest: Bytes32 = `0x${"5a".repeat(32)}`;

describe("signPassportDigest", () => {
  it("produces a recoverable low-s Ethereum signature, deterministically", () => {
    const sk = new SecretBytes(new Uint8Array(32).fill(9), "k_dep");
    const address = addressOfPublicKey(secp256k1.getPublicKey(sk.expose(), false));
    const sig = signPassportDigest(sk, digest);
    expect(hexToBytes(sig)).toHaveLength(65);
    expect(parseSignature(sig)).not.toBeNull();
    expect(recoverSigner(digest, sig)).toBe(address);
    expect(signPassportDigest(sk, digest)).toBe(sig);
    expect(() => signPassportDigest(sk, "0x00" as Bytes32)).toThrow(TypeError);
  });
});

describe("signAuthorityDigest", () => {
  it("produces a 64-byte low-s P-256 signature accepted by verifyP256", () => {
    const sk = new SecretBytes(new Uint8Array(32).fill(3), "k_id");
    const pub = p256.getPublicKey(sk.expose(), false);
    const publicKey = { x: bytesToHex(pub.subarray(1, 33)), y: bytesToHex(pub.subarray(33, 65)) };
    const sig = signAuthorityDigest(sk, digest);
    expect(hexToBytes(sig)).toHaveLength(64);
    expect(parseP256Signature(sig)).not.toBeNull();
    expect(verifyP256(digest, sig, publicKey)).toBe(true);
    expect(signAuthorityDigest(sk, digest)).toBe(sig);
  });
});
