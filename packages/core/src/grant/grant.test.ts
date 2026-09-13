import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { type Address, type Bytes32, bytesToHex, hexToBytes, u256be, ZERO_HASH } from "../bytes.js";
import { GrantError } from "../errors.js";
import { buildTree, hashLeaf, proveIndex } from "../merkle/merkle.js";
import { hashTerms, LICENSE_FH_1_0, passportDigest, passportId } from "../passport/typed.js";
import type { Passport, Terms } from "../passport/types.js";
import { addressOfPublicKey } from "../passport/verify.js";
import { effectiveGrantStatus, GrantStatus, isGrantLive, nextGrantStatus } from "./state.js";
import { VerifyFailure, type VerifyInput, verifyPredicate } from "./verify.js";

describe("grant state machine", () => {
  const active = { status: GrantStatus.ACTIVE, epochStart: 10n, term: 4n };
  it("derives EXPIRED / FROZEN / ACTIVE lazily with the documented precedence", () => {
    expect(effectiveGrantStatus(active, { lastAttestedEpoch: 10n }, 11n)).toBe(GrantStatus.ACTIVE);
    expect(effectiveGrantStatus(active, { lastAttestedEpoch: 10n }, 13n)).toBe(GrantStatus.FROZEN);
    expect(effectiveGrantStatus(active, { lastAttestedEpoch: 10n }, 13n, { grace: 5n })).toBe(
      GrantStatus.ACTIVE,
    );
    expect(effectiveGrantStatus(active, { lastAttestedEpoch: 10n }, 14n, { grace: 99n })).toBe(
      GrantStatus.EXPIRED,
    );
    // EXPIRED beats FROZEN.
    expect(effectiveGrantStatus(active, { lastAttestedEpoch: 0n }, 14n)).toBe(GrantStatus.EXPIRED);
    expect(
      effectiveGrantStatus(
        { ...active, status: GrantStatus.RESCINDED },
        { lastAttestedEpoch: 10n },
        11n,
      ),
    ).toBe(GrantStatus.RESCINDED);
    expect(
      effectiveGrantStatus(
        { ...active, status: GrantStatus.NONE },
        { lastAttestedEpoch: 10n },
        11n,
      ),
    ).toBe(GrantStatus.NONE);
    expect(isGrantLive(active, { lastAttestedEpoch: 10n }, 11n)).toBe(true);
  });
  it("only writes NONE→ACTIVE and ACTIVE→RESCINDED", () => {
    expect(nextGrantStatus(GrantStatus.NONE, { type: "grant" })).toBe(GrantStatus.ACTIVE);
    expect(nextGrantStatus(GrantStatus.ACTIVE, { type: "rescind" })).toBe(GrantStatus.RESCINDED);
    expect(() => nextGrantStatus(GrantStatus.ACTIVE, { type: "grant" })).toThrow(GrantError);
    expect(() => nextGrantStatus(GrantStatus.RESCINDED, { type: "rescind" })).toThrow(GrantError);
    expect(() => nextGrantStatus(GrantStatus.NONE, { type: "rescind" })).toThrow(GrantError);
    expect(() => nextGrantStatus(GrantStatus.ACTIVE, { type: "bogus" } as never)).toThrow(
      GrantError,
    );
    try {
      nextGrantStatus(GrantStatus.RESCINDED, { type: "rescind" });
    } catch (e) {
      expect((e as GrantError).code).toBe("FH_GRANT_RESCINDED");
    }
  });
});

describe("verifyPredicate", () => {
  const privateKey = u256be(7n);
  const origin = addressOfPublicKey(secp256k1.getPublicKey(privateKey, false));
  const domain = { chainId: 10143n, verifyingContract: `0x${"dd".repeat(20)}` as Address };
  const terms: Terms = {
    price: 5n,
    licenseId: LICENSE_FH_1_0,
    scope: 1,
    ns: 0,
    rateLimit: 100,
    payees: [origin],
    weights: [10n ** 18n],
  };
  const termsHash = hashTerms(terms);
  const passport: Passport = {
    h: `0x${"01".repeat(32)}`,
    origin,
    attest: ZERO_HASH,
    termsHash,
    epoch: 12n,
    nonce: `0x${"02".repeat(32)}`,
  };
  const rec = secp256k1.sign(hexToBytes(passportDigest(passport, domain)), privateKey, {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  const sig = new Uint8Array(65);
  sig.set(rec.subarray(1), 0);
  sig[64] = 27 + (rec[0] as number);
  const signature = bytesToHex(sig);
  const id = passportId(passport);
  const tree = buildTree([hashLeaf(`0x${"aa".repeat(32)}`), hashLeaf(id)]);
  const proof = proveIndex(tree, 1);

  const good: VerifyInput = {
    passport,
    signature,
    domain,
    proof,
    batchRoot: tree.root,
    rootAnchored: true,
    grant: { status: GrantStatus.ACTIVE, epochStart: 10n, term: 8n, termsHash },
    principal: { lastAttestedEpoch: 12n },
    epochNow: 12n,
  };

  it("accepts a fully valid tuple", () => {
    expect(verifyPredicate(good)).toEqual({ ok: true, passportId: id });
  });

  const expectFail = (input: VerifyInput, reason: VerifyFailure) => {
    const result = verifyPredicate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  };

  it("reports each failure with a stable reason code, in predicate order", () => {
    expectFail({ ...good, passport: { ...passport, h: ZERO_HASH } }, VerifyFailure.SIG_INVALID);
    expectFail({ ...good, rootAnchored: false }, VerifyFailure.ROOT_UNKNOWN);
    expectFail({ ...good, proof: { ...proof, index: 0 } }, VerifyFailure.MERKLE_INVALID);
    expectFail(
      { ...good, grant: { ...good.grant, termsHash: ZERO_HASH as Bytes32 } },
      VerifyFailure.TERMS_MISMATCH,
    );
    expectFail(
      { ...good, grant: { ...good.grant, status: GrantStatus.RESCINDED } },
      VerifyFailure.GRANT_RESCINDED,
    );
    expectFail(
      { ...good, epochNow: 18n, passport, principal: { lastAttestedEpoch: 18n } },
      VerifyFailure.GRANT_EXPIRED,
    );
    expectFail({ ...good, principal: { lastAttestedEpoch: 5n } }, VerifyFailure.GRANT_FROZEN);
    expectFail(
      { ...good, grant: { ...good.grant, status: GrantStatus.NONE } },
      VerifyFailure.GRANT_NOT_LIVE,
    );
    expectFail(
      {
        ...good,
        grant: { ...good.grant, epochStart: 13n },
        epochNow: 13n,
        principal: { lastAttestedEpoch: 13n },
      },
      VerifyFailure.EPOCH_OUT_OF_GRANT,
    );
  });

  it("rejects roots anchored by another principal or namespace when the owner is known", () => {
    const owned = {
      ...good,
      anchorOwner: { principalId: ZERO_HASH as Bytes32, ns: 0 },
      grant: { ...good.grant, principalId: ZERO_HASH as Bytes32, ns: 0 },
    };
    expect(verifyPredicate(owned)).toEqual({ ok: true, passportId: id });
    expectFail(
      { ...owned, anchorOwner: { principalId: `0x${"11".repeat(32)}`, ns: 0 } },
      VerifyFailure.SCOPE_MISMATCH,
    );
    expectFail(
      { ...owned, anchorOwner: { principalId: ZERO_HASH as Bytes32, ns: 1 } },
      VerifyFailure.SCOPE_MISMATCH,
    );
    // Without grant-side identity the check is skipped (memory/offline verifiers).
    expect(
      verifyPredicate({ ...good, anchorOwner: { principalId: `0x${"11".repeat(32)}`, ns: 3 } }).ok,
    ).toBe(true);
  });

  it("rejects passports from epochs after e_now (no future-epoch admission)", () => {
    // Grant started at 10, passport epoch 12, but the world is still at epoch 11.
    expectFail(
      { ...good, epochNow: 11n, principal: { lastAttestedEpoch: 11n } },
      VerifyFailure.EPOCH_OUT_OF_GRANT,
    );
  });
});
