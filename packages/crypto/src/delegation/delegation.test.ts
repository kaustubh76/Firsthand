import { describe, expect, it } from "vitest";
import { KeyTree } from "../kdf/keytree.js";
import {
  DelegatedKeys,
  decodeDelegation,
  encodeDelegation,
  issueDelegation,
} from "./delegation.js";

const tree = () => KeyTree.fromPrf(new Uint8Array(32).fill(0x42));
const H = `0x${"ab".repeat(32)}` as const;

describe("deposit delegation — a scoped, expiring, deposit-only capability", () => {
  const scope = { ns: 1, epoch: 7n, chainId: 10143n, expiresAt: 2_000n };

  it("round-trips as one pasteable code and yields exactly the tree's keys for its (ns, epoch)", () => {
    const t = tree();
    const d = issueDelegation(t, scope);
    expect(d).toMatchObject({ v: 1, chainId: "10143", ns: 1, epoch: "7", expiresAt: "2000" });
    expect(d.principalId).toBe(t.authorityKey().commitment);
    expect(d.depositAddresses).toHaveLength(16);
    expect(d.depositAddresses[1]).toBe(t.depositKey(1, 7n).address);

    const code = encodeDelegation(d);
    expect(code.startsWith("fhd1.")).toBe(true);
    expect(code).not.toContain("=");
    const keys = DelegatedKeys.fromCode(code, { now: () => 1_000n });
    expect(keys.principalId).toBe(d.principalId);
    expect(keys.depositKey(1, 7n).address).toBe(t.depositKey(1, 7n).address);
    expect(keys.vaultKey(1, 7n).use((k) => [...k])).toEqual(t.vaultKey(1, 7n).use((k) => [...k]));
    expect(keys.passportNonce(1, 7n, H)).toBe(t.passportNonce(1, 7n, H));
    expect(keys.depositAddresses(7n)).toEqual(d.depositAddresses);
    expect(keys.depositAddresses(8n)).toBeNull();
    expect(keys.nonceKey(1, 7n).use((k) => [...k])).toEqual(t.nonceKey(1, 7n).use((k) => [...k]));
    expect(JSON.stringify(keys)).toBe('"[DelegatedKeys]"');
    expect(keys.describe()).toMatch(/namespace 1, epoch 7/);
    // `using` disposal, and a decode with the real clock for a far-future expiry.
    {
      using scopedKeys = DelegatedKeys.fromCode(
        encodeDelegation({ ...d, expiresAt: "9999999999" }),
      );
      expect(scopedKeys.ns).toBe(1);
    }
  });

  it("refuses everything outside its scope with FH_DELEGATION_SCOPE — that refusal is the point", () => {
    const keys = new DelegatedKeys(issueDelegation(tree(), scope));
    expect(() => keys.authorityKey()).toThrow(
      expect.objectContaining({ code: "FH_DELEGATION_SCOPE" }),
    );
    expect(() => keys.depositKey(0, 7n)).toThrow(
      expect.objectContaining({ code: "FH_DELEGATION_SCOPE" }),
    );
    expect(() => keys.depositKey(1, 8n)).toThrow(
      expect.objectContaining({ code: "FH_DELEGATION_SCOPE" }),
    );
    expect(() => keys.vaultKey(2, 7n)).toThrow(/outside it/);
    expect(() => keys.passportNonce(1, 6n, H)).toThrow(/outside it/);
    keys.dispose();
    expect(() => keys.depositKey(1, 7n)).toThrow();
  });

  it("expires with its epoch, and rejects malformed or inconsistent codes", () => {
    const d = issueDelegation(tree(), scope);
    const code = encodeDelegation(d);
    expect(() => decodeDelegation(code, { now: () => 2_000n })).toThrow(
      expect.objectContaining({ code: "FH_DELEGATION_SCOPE" }),
    );
    expect(() => decodeDelegation("nope")).toThrow(/fhd1/);
    expect(() => decodeDelegation("fhd1.!!!")).toThrow(/base64url/);
    expect(() => decodeDelegation(encodeDelegation({ ...d, v: 2 as never }))).toThrow(/version/);
    expect(() => decodeDelegation(encodeDelegation({ ...d, ns: 99 }))).toThrow(/ns/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, chainId: "x" as never }), { now: () => 1n }),
    ).toThrow(/chainId/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, principalId: "0x12" as never }), { now: () => 1n }),
    ).toThrow(/principalId/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, epoch: "seven" }), { now: () => 1n }),
    ).toThrow(/epoch/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, expiresAt: "soon" }), { now: () => 1n }),
    ).toThrow(/expiresAt/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, vaultKey: "0x12" as never }), { now: () => 1n }),
    ).toThrow(/vaultKey must be 32 bytes hex/);
    expect(() =>
      decodeDelegation(encodeDelegation({ ...d, depositAddresses: d.depositAddresses.slice(1) })),
    ).toThrow(/16 deposit addresses/);
    // A deposit key that is not the namespace's attested address is refused at construction.
    const other = issueDelegation(KeyTree.fromPrf(new Uint8Array(32).fill(0x43)), scope);
    expect(() => new DelegatedKeys({ ...d, depositKey: other.depositKey })).toThrow(
      /does not match the namespace's attested address/,
    );
  });
});
