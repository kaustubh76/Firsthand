import { type Bytes32, bytesToHex, CryptoError } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { SecretBytes } from "../zeroize.js";
import { generateGranteeKeypair, granteeKeyFromSeed } from "./granteeKeys.js";
import { unwrapVaultKey, WRAP_LENGTH, wrapRef, wrapToHex, wrapVaultKeyToGrantee } from "./wrap.js";

describe("grant wrap", () => {
  const vault = new SecretBytes(new Uint8Array(32).fill(0xaa), "vault");
  const ctx = { grantId: `0x${"cc".repeat(32)}` as Bytes32, ns: 2, epoch: 9n };

  it("round-trips with a fresh grantee key pair and is randomised", () => {
    const grantee = generateGranteeKeypair();
    const a = wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx);
    const b = wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx);
    expect(a.bytes).toHaveLength(WRAP_LENGTH);
    expect(a.ref).not.toBe(b.ref);
    expect(wrapRef(a.bytes)).toBe(a.ref);
    expect(wrapToHex(a)).toBe(bytesToHex(a.bytes));
    const vk = unwrapVaultKey(grantee.secretKey, a.bytes, ctx);
    expect(bytesToHex(vk.expose())).toBe(bytesToHex(vault.expose()));
    expect(vk.label).toBe("k_ns[2,9]");
  });

  it("is bound to grant id and namespace-epoch, and to the grantee", () => {
    const grantee = generateGranteeKeypair();
    const other = generateGranteeKeypair();
    const wrap = wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx);
    expect(() =>
      unwrapVaultKey(grantee.secretKey, wrap.bytes, { ...ctx, grantId: `0x${"cd".repeat(32)}` }),
    ).toThrow(CryptoError);
    expect(() => unwrapVaultKey(grantee.secretKey, wrap.bytes, { ...ctx, ns: 3 })).toThrow(
      CryptoError,
    );
    expect(() => unwrapVaultKey(grantee.secretKey, wrap.bytes, { ...ctx, epoch: 10n })).toThrow(
      CryptoError,
    );
    expect(() => unwrapVaultKey(other.secretKey, wrap.bytes, ctx)).toThrow(CryptoError);
    expect(() => unwrapVaultKey(grantee.secretKey, wrap.bytes.subarray(1), ctx)).toThrow(
      /unexpected length/,
    );
  });

  it("validates inputs", () => {
    const grantee = generateGranteeKeypair();
    expect(() => wrapVaultKeyToGrantee(vault, "0x00" as Bytes32, ctx)).toThrow(TypeError);
    expect(() =>
      wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx, { nonce: new Uint8Array(1) }),
    ).toThrow(CryptoError);
    expect(() =>
      wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx, { ephemeralSecret: new Uint8Array(1) }),
    ).toThrow(CryptoError);
    expect(() => granteeKeyFromSeed(new Uint8Array(4))).toThrow(CryptoError);
  });
});
