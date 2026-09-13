import { type Bytes32, bytesToHex, CryptoError, hexToBytes } from "@firsthand/core";
import { loadVectors } from "@firsthand/test-vectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { granteeKeyFromSeed } from "../wrap/granteeKeys.js";
import { unwrapVaultKey, wrapVaultKeyToGrantee } from "../wrap/wrap.js";
import { SecretBytes } from "../zeroize.js";
import { DEK_LENGTH, generateDek, openBlob, sealBlob, unwrapDek, wrapDek } from "./envelope.js";
import { decodeEnvelope, ENVELOPE_VERSION, encodeEnvelope, HEADER_LENGTH } from "./format.js";

const Hex = z
  .string()
  .regex(/^0x[0-9a-f]*$/)
  .transform((v) => v as `0x${string}`);
const B32 = Hex.transform((v) => v as Bytes32);
const Input = z.object({
  plaintext: Hex,
  dek: Hex,
  vaultKey: Hex,
  granteeSeed: Hex,
  passportId: B32,
  grantId: B32,
  ns: z.number(),
  epoch: z.string().transform(BigInt),
  blobNonce: Hex,
  dekNonce: Hex,
  wrapNonce: Hex,
  ephemeralSecret: Hex,
});
const Expected = z.object({
  blob: Hex,
  wrappedDek: Hex,
  granteePublicKey: B32,
  wrap: Hex,
  wrapRef: B32,
});
const vectors = loadVectors("envelope", { input: Input, expected: Expected });

describe("envelope vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const { input: i, expected: e } = c;
      const dek = new SecretBytes(hexToBytes(i.dek), "dek");
      const vault = new SecretBytes(hexToBytes(i.vaultKey), "vault");
      const grantee = granteeKeyFromSeed(hexToBytes(i.granteeSeed));
      const ctx = { grantId: i.grantId, ns: i.ns, epoch: i.epoch };

      expect(
        bytesToHex(
          sealBlob(dek, hexToBytes(i.plaintext), i.passportId, { nonce: hexToBytes(i.blobNonce) }),
        ),
      ).toBe(e.blob);
      expect(
        bytesToHex(
          wrapDek(vault, dek, i.passportId, i.ns, i.epoch, { nonce: hexToBytes(i.dekNonce) }),
        ),
      ).toBe(e.wrappedDek);
      expect(grantee.publicKey).toBe(e.granteePublicKey);
      const wrap = wrapVaultKeyToGrantee(vault, grantee.publicKey, ctx, {
        ephemeralSecret: hexToBytes(i.ephemeralSecret),
        nonce: hexToBytes(i.wrapNonce),
      });
      expect(bytesToHex(wrap.bytes)).toBe(e.wrap);
      expect(wrap.ref).toBe(e.wrapRef);

      // Full grantee-side round trip from the committed ciphertexts.
      const vk = unwrapVaultKey(grantee.secretKey, hexToBytes(e.wrap), ctx);
      const dek2 = unwrapDek(vk, hexToBytes(e.wrappedDek), i.passportId, i.ns, i.epoch);
      expect(bytesToHex(openBlob(dek2, hexToBytes(e.blob), i.passportId))).toBe(i.plaintext);
    });
  }
});

describe("envelope behaviour", () => {
  const passportId: Bytes32 = `0x${"0a".repeat(32)}`;
  const otherId: Bytes32 = `0x${"0b".repeat(32)}`;
  const plaintext = new TextEncoder().encode("hello");

  it("uses random nonces by default and round-trips", () => {
    const dek = generateDek();
    expect(dek.length).toBe(DEK_LENGTH);
    const a = sealBlob(dek, plaintext, passportId);
    const b = sealBlob(dek, plaintext, passportId);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(openBlob(dek, a, passportId)).toEqual(plaintext);
  });

  it("binds ciphertext to the passport id and namespace-epoch via AAD", () => {
    const dek = generateDek();
    const vault = new SecretBytes(new Uint8Array(32).fill(1), "vault");
    const blob = sealBlob(dek, plaintext, passportId);
    expect(() => openBlob(dek, blob, otherId)).toThrow(CryptoError);
    const wrapped = wrapDek(vault, dek, passportId, 1, 2n);
    expect(() => unwrapDek(vault, wrapped, passportId, 1, 3n)).toThrow(CryptoError);
    expect(() => unwrapDek(vault, wrapped, passportId, 2, 2n)).toThrow(CryptoError);
    expect(bytesToHex(unwrapDek(vault, wrapped, passportId, 1, 2n).expose())).toBe(
      bytesToHex(dek.expose()),
    );
  });

  it("detects tampering and rejects malformed containers", () => {
    const dek = generateDek();
    const blob = sealBlob(dek, plaintext, passportId);
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openBlob(dek, tampered, passportId)).toThrow(CryptoError);
    expect(() => decodeEnvelope(new Uint8Array(10))).toThrow(/too short/);
    const badMagic = new Uint8Array(blob);
    badMagic[0] = 0;
    expect(() => decodeEnvelope(badMagic)).toThrow(/bad magic/);
    const badVersion = new Uint8Array(blob);
    badVersion[4] = ENVELOPE_VERSION + 1;
    expect(() => decodeEnvelope(badVersion)).toThrow(/unsupported version/);
    expect(() => encodeEnvelope({ nonce: new Uint8Array(3), sealed: new Uint8Array(16) })).toThrow(
      CryptoError,
    );
    expect(() => sealBlob(dek, plaintext, passportId, { nonce: new Uint8Array(12) })).toThrow(
      CryptoError,
    );
    expect(decodeEnvelope(blob).sealed.length).toBe(blob.length - HEADER_LENGTH);
  });

  it("unwrapDek rejects a wrapped value of the wrong length", () => {
    const vault = new SecretBytes(new Uint8Array(32).fill(2), "vault");
    const notADek = new SecretBytes(new Uint8Array(16).fill(3), "short");
    const wrapped = wrapDek(vault, notADek, passportId, 0, 0n);
    expect(() => unwrapDek(vault, wrapped, passportId, 0, 0n)).toThrow(/unexpected length/);
  });
});
