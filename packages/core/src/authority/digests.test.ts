import { describe, expect, it } from "vitest";
import type { Address, Bytes32 } from "../bytes.js";
import {
  ACCEPT_TERMS_TYPEHASH,
  ANCHOR_TYPEHASH,
  ATTEST_TYPEHASH,
  acceptTermsStructHash,
  anchorStructHash,
  attestStructHash,
  authorityDigest,
  depositKeysRoot,
  ENROLL_TYPEHASH,
  enrollStructHash,
  GRANT_TYPEHASH,
  grantIdOf,
  grantStructHash,
  RESCIND_COMMIT_TYPEHASH,
  RESCIND_TYPEHASH,
  rescindCommitStructHash,
  rescindStructHash,
  rescissionCommitment,
} from "./digests.js";

const b = (n: number): Bytes32 => `0x${n.toString(16).padStart(64, "0")}`;

describe("authority digests", () => {
  it("type hashes match the Solidity twin (values from cast keccak)", () => {
    expect(ENROLL_TYPEHASH).toBe(
      "0xc42c9055b20f7856ed8aba0177e53f63bc9ab5177fab45b5223ebddef474f47c",
    );
    expect(ATTEST_TYPEHASH).toBe(
      "0xaf15e6a0fee4534521b87e65fcb3aec148622758c3e46236915e8bb0457d2e07",
    );
    expect(GRANT_TYPEHASH).toBe(
      "0xa965437826d5391d5383b20e6585b72c4b911f5602248e98c721dc521805005c",
    );
    expect(ACCEPT_TERMS_TYPEHASH).toBe(
      "0x996de7acc40660ce8933b391c1914c7780144d23dca730257a8a236cd65f2dc5",
    );
    expect(RESCIND_TYPEHASH).toBe(
      "0x4c89acadd747eaad0aa61627318b860cba97fbbd256e9b5d8d190aa4e179e4c7",
    );
    expect(RESCIND_COMMIT_TYPEHASH).toBe(
      "0xcca400fa08f22f853a00f1ea1870d760414d3206d02f9ee120efc6ea63c44a58",
    );
    expect(ANCHOR_TYPEHASH).toBe(
      "0x06d14469a38beb1fb1e25c0c1e5ad3f5da1946b38e960cc539c1264b6ac9dcd7",
    );
  });

  it("struct hashes are field-bound and verb-separated", () => {
    expect(enrollStructHash(b(1), 1n, b(2))).not.toBe(enrollStructHash(b(1), 2n, b(2)));
    expect(attestStructHash(b(1), 1n, b(1), b(2))).not.toBe(attestStructHash(b(1), 1n, b(2), b(2)));
    const g = {
      principalId: b(1),
      granteeCard: b(2),
      ns: 0,
      epochStart: 1n,
      term: 2n,
      termsHash: b(1),
      wrapRef: b(2),
      nonce: b(1),
    };
    expect(grantStructHash(g)).not.toBe(grantStructHash({ ...g, ns: 1 }));
    expect(acceptTermsStructHash(b(1), b(2), 0, b(1), b(2))).not.toBe(
      acceptTermsStructHash(b(2), b(1), 0, b(1), b(2)),
    );
    expect(rescindStructHash(b(1), 1n, b(2))).not.toBe(rescindCommitStructHash(b(1), b(2)));
    expect(rescindStructHash(b(1), 1n, b(2))).not.toBe(enrollStructHash(b(1), 1n, b(2)));
    const a = {
      principalId: b(1),
      ns: 0,
      epoch: 1n,
      batchRoot: b(1),
      termsHash: b(2),
      nonce: b(1),
    };
    expect(anchorStructHash(a)).not.toBe(anchorStructHash({ ...a, batchRoot: b(2) }));
  });

  it("commitment, grant id and deposit-keys root follow abi.encode / encodePacked", () => {
    // keccak256(abi.encode(grantId, salt)) with 32-byte words == keccak of the concatenation.
    expect(rescissionCommitment(b(1), b(2))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(grantIdOf(b(1), b(2), 3, 4n)).toMatch(/^0x[0-9a-f]{64}$/);
    const keys = new Array<Address>(16).fill(`0x${"ab".repeat(20)}`);
    expect(depositKeysRoot(keys)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => depositKeysRoot(keys.slice(1))).toThrow(TypeError);
  });

  it("authorityDigest composes the 0x1901 prefix under the FIRSTHAND domain", () => {
    const d = authorityDigest(b(7), { chainId: 10143n, verifyingContract: `0x${"dd".repeat(20)}` });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d).not.toBe(
      authorityDigest(b(7), { chainId: 1n, verifyingContract: `0x${"dd".repeat(20)}` }),
    );
  });
});
