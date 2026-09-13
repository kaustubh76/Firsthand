import { inspect } from "node:util";
import { CryptoError } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { KeyTree } from "./kdf/keytree.js";
import { generateGranteeKeypair } from "./wrap/granteeKeys.js";
import { SecretBytes, zeroize } from "./zeroize.js";

/**
 * Regression guard for the privacy boundary: no public structure produced by this package may
 * leak secret bytes through JSON, string coercion or util.inspect.
 */
describe("secret material never serialises", () => {
  const prf = new Uint8Array(32).fill(0x42);
  const tree = KeyTree.fromPrf(new Uint8Array(prf));

  const secretHexes = (): string[] => {
    const t = KeyTree.fromPrf(new Uint8Array(prf));
    return [
      Buffer.from(t.prk().expose()).toString("hex"),
      Buffer.from(t.authorityKey().scalar.expose()).toString("hex"),
      Buffer.from(t.vaultKey(0, 0n).expose()).toString("hex"),
      Buffer.from(t.depositKey(0, 0n).privateKey.expose()).toString("hex"),
      Buffer.from(t.nonceKey(0, 0n).expose()).toString("hex"),
    ];
  };

  it("KeyTree, AuthorityKey, DepositKey and SecretBytes redact under JSON.stringify / String / inspect", () => {
    const authority = tree.authorityKey();
    const deposit = tree.depositKey(0, 0n);
    const grantee = generateGranteeKeypair();
    const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    const dumps = [
      JSON.stringify(tree),
      JSON.stringify(authority),
      JSON.stringify(deposit, bigintSafe),
      JSON.stringify(grantee),
      String(authority.scalar),
      `${deposit.privateKey}`,
      inspect(authority, { depth: 5 }),
      inspect(deposit, { depth: 5 }),
    ].join("\n");
    for (const secret of secretHexes()) {
      expect(dumps).not.toContain(secret);
      expect(dumps).not.toContain(secret.toUpperCase());
    }
    expect(dumps).toContain(SecretBytes.REDACTED);
    expect(dumps).toContain(deposit.address); // public parts still serialise
    expect(inspect(authority.scalar)).toBe("SecretBytes(k_id, 32 bytes)");
  });

  it("SecretBytes enforces lifetime", () => {
    const s = new SecretBytes(new Uint8Array([1, 2, 3]), "t");
    expect(s.length).toBe(3);
    expect(s.label).toBe("t");
    expect(s.use((b) => b[0])).toBe(1);
    const copy = s.clone("copy");
    expect(copy.label).toBe("copy");
    s.dispose();
    s.dispose(); // idempotent
    expect(s.disposed).toBe(true);
    expect(() => s.use((b) => b)).toThrow(CryptoError);
    expect(() => s.expose()).toThrow(CryptoError);
    expect(() => s.clone()).toThrow(CryptoError);
    expect(copy.expose()).toEqual(new Uint8Array([1, 2, 3]));
    {
      using scoped = new SecretBytes(new Uint8Array([9]), "scoped");
      expect(scoped.disposed).toBe(false);
    }
    const buf = new Uint8Array([5, 5]);
    zeroize(buf);
    expect(buf).toEqual(new Uint8Array([0, 0]));
    {
      using scopedTree = KeyTree.fromPrf(new Uint8Array(prf));
      expect(scopedTree.authorityKey().commitment).toBe(tree.authorityKey().commitment);
    }
  });
});
