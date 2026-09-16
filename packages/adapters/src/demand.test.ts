import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  type Bytes32,
  GrantStatus,
  hashTerms,
  LICENSE_FH_1_0,
  type PassportSidecar,
  passportId,
  Scope,
  type Terms,
  ZERO_HASH,
} from "@firsthand/core";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { FsPassportCatalog } from "./catalog/FsPassportCatalog.js";
import { ObjectPassportCatalog } from "./catalog/ObjectPassportCatalog.js";
import {
  MemoryConsentLedger,
  MemoryGrantReader,
  MemoryObjectStoreClient,
  MemoryPassportCatalog,
  MemorySettlement,
  receiptIdOf,
} from "./memory/index.js";
import type { PassportCatalog } from "./ports/PassportCatalog.js";
import { splitSignature } from "./ports/Settlement.js";
import type { PaymentRequirements } from "./ports/X402Facilitator.js";
import {
  assetDomainFrom,
  buildPaymentPayload,
  transferWithAuthorizationTypes,
} from "./x402/typedData.js";

const b32 = (n: number): Bytes32 => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

const terms: Terms = {
  price: 1_000n,
  licenseId: LICENSE_FH_1_0,
  scope: Scope.TRAIN,
  ns: 0,
  rateLimit: 2,
  payees: [addr(0xa), addr(0xb), addr(0xc)],
  weights: [333_333_333_333_333_333n, 333_333_333_333_333_333n, 333_333_333_333_333_334n],
};

const sidecar: PassportSidecar = {
  signed: {
    passport: {
      h: b32(1),
      origin: addr(1),
      attest: b32(2),
      termsHash: hashTerms(terms),
      epoch: 5n,
      nonce: b32(3),
    },
    signature: `0x${"11".repeat(65)}`,
  },
  principalId: b32(7),
  ns: 0,
  batchRoot: b32(8),
  proof: { index: 0, siblings: new Array<Bytes32>(8).fill(ZERO_HASH) },
  terms,
  blobRef: b32(9),
  wrappedDekRef: b32(10),
};

function describeCatalogConformance(name: string, make: () => PassportCatalog) {
  describe(`PassportCatalog conformance: ${name}`, () => {
    it("stores by passport id, round-trips bigints, and misses cleanly", async () => {
      const c = make();
      const id = passportId(sidecar.signed.passport);
      expect(await c.has(id)).toBe(false);
      await c.put(sidecar);
      expect(await c.has(id)).toBe(true);
      const back = await c.get(id);
      expect(back?.terms.price).toBe(1_000n);
      expect(back?.signed.passport.epoch).toBe(5n);
      expect(back?.proof.siblings).toHaveLength(8);
      expect(await c.get(b32(99))).toBeNull();
    });
  });
}
const tmp = mkdtempSync(join(tmpdir(), "fh-catalog-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
describeCatalogConformance("memory", () => new MemoryPassportCatalog());
describeCatalogConformance("fs", () => new FsPassportCatalog(tmp));
describeCatalogConformance(
  "object store",
  () => new ObjectPassportCatalog({ client: new MemoryObjectStoreClient() }),
);

describe("ObjectPassportCatalog", () => {
  it("lays passports out like the fs catalog, so a store can be migrated by copying", async () => {
    const client = new MemoryObjectStoreClient();
    await new ObjectPassportCatalog({ client, prefix: "gw/" }).put(sidecar);
    const id = passportId(sidecar.signed.passport);
    expect([...client.objects.keys()]).toEqual([`gw/${id.slice(2, 4)}/${id}.json`]);
    expect(client.objects.get(`gw/${id.slice(2, 4)}/${id}.json`)?.contentType).toBe(
      "application/json",
    );
  });
});

describe("MemoryGrantReader", () => {
  it("mirrors the contract: cards, terms by preimage, lazy status precedence", async () => {
    const r = new MemoryGrantReader({ epoch: 5n });
    const principal = b32(7);
    r.enroll(principal);
    const card = r.registerCard(addr(0xca), b32(0x25519));
    expect(await r.cardOf(card)).toEqual({ owner: addr(0xca), encryptionPubKey: b32(0x25519) });
    const th = r.acceptTerms(card, principal, terms);
    expect(await r.termsOf(th)).toEqual({ price: 1_000n, rateLimit: 2, ns: 0 });
    expect(() =>
      r.grant({ principalId: principal, granteeCard: card, ns: 1, termsHash: th, wrapRef: b32(1) }),
    ).toThrow(/not accepted/);
    const grantId = r.grant({
      principalId: principal,
      granteeCard: card,
      ns: 0,
      termsHash: th,
      wrapRef: b32(1),
      term: 3n,
    });
    expect((await r.grantState(grantId))?.status).toBe(GrantStatus.ACTIVE);
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.ACTIVE);
    r.setEpoch(7n);
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.ACTIVE); // 5 + grace 2
    r.setEpoch(8n);
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.EXPIRED); // 5 + term 3 → expired beats frozen
    r.setEpoch(7n);
    r.enroll(principal, 4n);
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.FROZEN);
    expect(await r.isPrincipalLive(principal)).toBe(false);
    // Re-attest after the gap (4 + grace 2 < 7): thaw is scheduled one boundary later (§7.6).
    r.attest(principal, 7n);
    expect(await r.isPrincipalLive(principal)).toBe(false);
    expect(await r.principalLiveness(principal)).toEqual({ lastAttestedEpoch: 7n, thawEpoch: 8n });
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.FROZEN);
    r.setEpoch(8n);
    expect(await r.isPrincipalLive(principal)).toBe(true);
    r.attest(principal, 8n); // within grace: thaw untouched, still live
    expect(await r.principalLiveness(principal)).toEqual({ lastAttestedEpoch: 8n, thawEpoch: 8n });
    expect(await r.isPrincipalLive(principal)).toBe(true);
    r.setEpoch(7n);
    r.rescind(grantId);
    expect(await r.effectiveStatus(grantId)).toBe(GrantStatus.RESCINDED);
    expect(await r.effectiveStatus(b32(42))).toBe(GrantStatus.NONE);
    expect(await r.grantState(b32(42))).toBeNull();
    expect(await r.principalLiveness(b32(43))).toBeNull();
    expect(() => r.rescind(b32(42))).toThrow(/unknown grant/);
  });
});

describe("MemorySettlement", () => {
  const buyer = addr(0xb0b);
  const requirements = (payTo: Address): PaymentRequirements => ({
    scheme: "exact",
    network: "monad-testnet",
    maxAmountRequired: "1000",
    resource: "https://gw/v1/query",
    description: "q",
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 60,
    asset: addr(0xdc),
    extra: { chainId: "31337" },
  });
  const payment = (nonce: number, value = "1000") => ({
    x402Version: 1 as const,
    scheme: "exact" as const,
    network: "monad-testnet",
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: buyer,
        to: addr(0xaa),
        value,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: b32(nonce),
      },
    },
  });

  function setup() {
    const grants = new MemoryGrantReader({ epoch: 5n });
    const ledger = new MemoryConsentLedger();
    const settlement = new MemorySettlement(grants, ledger);
    const principal = b32(7);
    grants.enroll(principal);
    const card = grants.registerCard(addr(0xca), b32(1));
    const th = grants.acceptTerms(card, principal, terms);
    const grantId = grants.grant({
      principalId: principal,
      granteeCard: card,
      ns: 0,
      termsHash: th,
      wrapRef: b32(2),
    });
    return { grants, ledger, settlement, grantId };
  }

  it("splits like the router, records receipts, and enforces every refusal", async () => {
    const { grants, ledger, settlement, grantId } = setup();
    const r1 = await settlement.settle({ grantId, terms, payment: payment(1) });
    expect(r1.receiptId).toBe(receiptIdOf(grantId, b32(1)));
    expect(r1.payer).toBe(buyer);
    expect(settlement.payouts.get(addr(0xa))).toBe(333n);
    expect(settlement.dust).toBe(1n);
    expect((await ledger.receiptsForGrant(grantId))[0]?.receiptId).toBe(r1.receiptId);
    expect(await grants.queriesThisEpoch(grantId, 5n)).toBe(1);

    await expect(settlement.settle({ grantId, terms, payment: payment(1) })).rejects.toMatchObject({
      code: "FH_PAYMENT_INVALID",
    });
    await expect(
      settlement.settle({ grantId, terms, payment: payment(2, "999") }),
    ).rejects.toMatchObject({ code: "FH_PAYMENT_INVALID" });
    await expect(
      settlement.settle({ grantId, terms: { ...terms, price: 999n }, payment: payment(2, "999") }),
    ).rejects.toMatchObject({ code: "FH_PAYMENT_INVALID" });
    await settlement.settle({ grantId, terms, payment: payment(2) });
    await expect(settlement.settle({ grantId, terms, payment: payment(3) })).rejects.toMatchObject({
      code: "FH_RATE_LIMITED",
    });
    grants.setEpoch(6n);
    grants.attest(b32(7), 6n);
    await settlement.settle({ grantId, terms, payment: payment(3) });
    grants.rescind(grantId);
    await expect(settlement.settle({ grantId, terms, payment: payment(4) })).rejects.toMatchObject({
      code: "FH_GRANT_RESCINDED",
    });
    await expect(
      settlement.settle({ grantId: b32(99), terms, payment: payment(5) }),
    ).rejects.toMatchObject({ code: "FH_GRANT_NOT_LIVE" });
    expect(requirements(addr(0xaa)).payTo).toBe(addr(0xaa));
  });
});

describe("toSettlementError", () => {
  it("maps decoded contract reasons to FIRSTHAND codes and passes unknown ones through", async () => {
    const { toSettlementError } = await import("./settlement/OnchainSettlement.js");
    const { ChainError } = await import("@firsthand/core");
    const mk = (reason: string) => new ChainError("x", { context: { reason } });
    expect(toSettlementError(mk("RateLimitExceeded")).code).toBe("FH_RATE_LIMITED");
    expect(toSettlementError(mk("GrantNotLive")).code).toBe("FH_GRANT_NOT_LIVE");
    expect(toSettlementError(mk("AuthorizationExpired")).code).toBe("FH_PAYMENT_INVALID");
    expect(toSettlementError(mk("Whatever")).code).toBe("FH_CHAIN");
  });
});

describe("x402 typed data", () => {
  const account = privateKeyToAccount(`0x${"07".repeat(32)}`);
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "monad-testnet",
    maxAmountRequired: "1000",
    resource: "https://gw/v1/query",
    description: "q",
    mimeType: "application/json",
    payTo: addr(0xaa),
    maxTimeoutSeconds: 60,
    asset: addr(0xdc),
    extra: { chainId: 31337, name: "USD Coin", version: "2" },
  };

  it("signs a TransferWithAuthorization viem can verify, bound to payTo and the asset domain", async () => {
    const payload = await buildPaymentPayload(account, requirements, {
      nonce: b32(5),
      now: () => 1_000_000,
    });
    const a = payload.payload.authorization;
    expect(a.from).toBe(account.address.toLowerCase());
    expect(a.to).toBe(addr(0xaa));
    expect(a.value).toBe("1000");
    expect(a.validBefore).toBe("1060");
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "USD Coin", version: "2", chainId: 31337n, verifyingContract: addr(0xdc) },
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as Address,
        to: a.to as Address,
        value: 1000n,
        validAfter: 0n,
        validBefore: 1060n,
        nonce: b32(5),
      },
      signature: payload.payload.signature as `0x${string}`,
    });
    expect(ok).toBe(true);
    const parts = splitSignature(payload.payload.signature as `0x${string}`);
    expect([27, 28]).toContain(parts.v);
    expect(parts.r).toHaveLength(66);
    const random = await buildPaymentPayload(account, requirements);
    expect(random.payload.authorization.nonce).not.toBe(b32(5));
    expect(assetDomainFrom({ ...requirements, extra: { chainId: "1" } }).name).toBe("USD Coin");
    expect(() => assetDomainFrom({ ...requirements, extra: {} })).toThrow(/chainId/);
  });
});
