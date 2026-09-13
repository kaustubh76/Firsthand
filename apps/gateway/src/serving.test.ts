import { encodePaymentHeader, MemoryBlobStore, MemoryTransport } from "@firsthand/adapters";
import {
  type Address,
  AttestationClass,
  type Bytes32,
  hashTerms,
  LICENSE_FH_1_0,
  Scope,
  sidecarToWire,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { noopLogger } from "@firsthand/runtime";
import {
  Batcher,
  BuyerSession,
  createBuyerKeys,
  deposit,
  Locker,
  planGrant,
  sidecarFor,
} from "@firsthand/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

/**
 * Full memory-mode flow through the HTTP surface: a principal deposits and publishes, grants to a
 * buyer, the buyer pays per query and opens the plaintext; then consent is withdrawn and the next
 * query is refused. No chain, no network — the same code paths the anvil tier runs for real.
 */
const epochs = { genesis: 1_000_000n, length: 604_800n };
const clock = () => 1_000_000n + 5n * 604_800n + 17n; // epoch 5
const prfSource = (fill: number) => ({
  kind: "test",
  evaluate: async () => new Uint8Array(32).fill(fill),
});

async function scenario() {
  const gw = createGateway(
    loadConfig({
      PASSPORT_ANCHORS: `0x${"a1".repeat(20)}`,
      PAY_TO: `0x${"aa".repeat(20)}`,
      CHAIN_ID: "10143",
      RATE_LIMIT_CAPACITY: "1000",
    }),
    { logger: noopLogger },
  );
  if (!gw.memory) throw new Error("memory mode expected");
  const fetchApp = ((input: string | URL | Request, init?: RequestInit) =>
    gw.app.request(String(input).replace("http://gw", ""), init)) as unknown as typeof fetch;

  // Principal: locker anchored into the gateway's memory anchors, then published.
  const locker = await Locker.open(prfSource(1), {
    domain: gw.domain,
    epochs,
    anchors: gw.memory.anchors,
    blobs: new MemoryBlobStore(),
    clock,
    namespaces: [{ ns: 0, label: "chat" }],
  });
  gw.memory.grants.setEpoch(5n);
  gw.memory.grants.enroll(locker.principalId, 5n);
  const batcher = new Batcher(locker, gw.memory.anchors, 1);
  const terms: Terms = {
    price: 1_000n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 2,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  };
  const attestation = {
    class: AttestationClass.IMPORT,
    capturedAt: 0n,
    sourceTag: ZERO_HASH,
    deviceClass: ZERO_HASH,
    metaHash: ZERO_HASH,
  };
  const plaintext = new TextEncoder().encode("served plaintext");
  const r = await deposit(locker, batcher, {
    ns: 0,
    datum: { kind: "bytes", bytes: plaintext },
    terms,
    attestation,
  });
  const target = { gateway: "http://gw", fetch: fetchApp };
  const { publishDeposit } = await import("@firsthand/sdk");
  await publishDeposit({ gatewayUrl: target.gateway, fetch: fetchApp }, locker, batcher, r, terms);

  // Buyer: card + terms + grant (seeded into the memory grant reader as the contract would).
  const account = privateKeyToAccount(`0x${"0b".repeat(32)}`);
  const buyer = new BuyerSession({
    keys: createBuyerKeys(new Uint8Array(32).fill(0x0b), account, new Uint8Array(32).fill(0x0c)),
    grantManager: `0x${"b1".repeat(20)}`,
    chainId: 10143n,
    transport: new MemoryTransport(),
    fetch: fetchApp,
  });
  gw.memory.grants.registerCard(buyer.owner, buyer.encryptionPubKey);
  const termsHash = gw.memory.grants.acceptTerms(buyer.cardId, locker.principalId, terms);
  const plan = planGrant(locker, `0x${"b1".repeat(20)}`, {
    granteeCard: buyer.cardId,
    granteeEncryptionPubKey: buyer.encryptionPubKey,
    ns: 0,
    termsHash,
    term: 4n,
  });
  const grantId = gw.memory.grants.grant({
    principalId: locker.principalId,
    granteeCard: buyer.cardId,
    ns: 0,
    termsHash: hashTerms(terms),
    wrapRef: plan.wrapRef,
    term: 4n,
  });
  expect(grantId).toBe(plan.grantId);
  const { publishWrap } = await import("@firsthand/sdk");
  await publishWrap({ gatewayUrl: target.gateway, fetch: fetchApp }, grantId, plan.wrap);

  return {
    gw,
    locker,
    batcher,
    terms,
    attestation,
    r,
    buyer,
    grantId,
    plan,
    fetchApp,
    plaintext,
    sidecar: sidecarFor(locker, batcher, r, terms),
  };
}

describe("gateway serving path (memory mode)", () => {
  it("publishes, prices from the sidecar's terms, serves paid queries with receipts, and enforces rescission and rate limits", async () => {
    const s = await scenario();
    const url = `/v1/query/${s.grantId}/${s.r.passportId}`;

    const offer = await s.gw.app.request(url);
    expect(offer.status).toBe(402);
    const body = (await offer.json()) as {
      accepts: { maxAmountRequired: string; payTo: string; extra: { chainId: string } }[];
    };
    expect(body.accepts[0]).toMatchObject({
      maxAmountRequired: "1000",
      payTo: `0x${"aa".repeat(20)}`,
      extra: { chainId: "10143" },
    });

    const { result, plaintext } = await s.buyer.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId },
      s.gw.domain,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("served plaintext");
    expect(result.receipt.receiptId).toMatch(/^0x/);
    expect((await s.gw.memory?.ledger.receiptsForGrant(s.grantId))?.length).toBe(1);

    // Second query within the rate limit (2) succeeds; the third is refused on-chain-equivalently.
    await s.buyer.query({
      gatewayUrl: "http://gw",
      grantId: s.grantId,
      passportId: s.r.passportId,
    });
    await expect(
      s.buyer.query({ gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId }),
    ).rejects.toMatchObject({ context: { code: "FH_RATE_LIMITED", status: 429 } });

    // Rescission: consent withdrawn → the next paid attempt is refused before any settlement.
    s.gw.memory?.grants.setEpoch(6n);
    s.gw.memory?.grants.attest(s.locker.principalId, 6n);
    s.gw.memory?.grants.rescind(s.grantId);
    await expect(
      s.buyer.query({ gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId }),
    ).rejects.toMatchObject({ context: { code: "FH_GRANT_RESCINDED", status: 403 } });
    expect((await s.gw.memory?.ledger.receiptsForGrant(s.grantId))?.length).toBe(2);

    // Public reads.
    const sidecarRes = await s.gw.app.request(`/v1/passports/${s.r.passportId}`);
    expect(sidecarRes.status).toBe(200);
    expect(((await sidecarRes.json()) as { principalId: string }).principalId).toBe(
      s.locker.principalId,
    );
    expect((await s.gw.app.request(`/v1/passports/${ZERO_HASH}`)).status).toBe(404);
    expect((await s.gw.app.request(`/v1/grants/${s.grantId}/wrap`)).status).toBe(200);
    expect((await s.gw.app.request(`/v1/grants/${ZERO_HASH}/wrap`)).status).toBe(404);
    expect(
      (
        (await (await s.gw.app.request("/.well-known/firsthand.json")).json()) as {
          endpoints: { ingest: unknown };
        }
      ).endpoints.ingest,
    ).toBeDefined();
  });

  it("refuses unverifiable ingest: bad signature, unanchored root, wrong owner, wrong index, mismatched terms, wrap hash", async () => {
    const s = await scenario();
    const post = (path: string, body: unknown, contentType = "application/json") =>
      s.gw.app.request(path, {
        method: "POST",
        headers: { "content-type": contentType },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const wire = sidecarToWire(s.sidecar);

    expect((await post("/v1/passports", "not json")).status).toBe(400);
    expect(
      (
        await post("/v1/passports", {
          ...wire,
          signed: { ...wire.signed, signature: `0x${"11".repeat(65)}` },
        })
      ).status,
    ).toBe(422);
    expect(
      (await post("/v1/passports", { ...wire, batchRoot: `0x${"77".repeat(32)}` })).status,
    ).toBe(422);
    expect(
      (await post("/v1/passports", { ...wire, principalId: `0x${"78".repeat(32)}` })).status,
    ).toBe(422);
    expect(
      (await post("/v1/passports", { ...wire, proof: { ...wire.proof, index: 3 } })).status,
    ).toBe(422);
    expect(
      (await post("/v1/passports", { ...wire, terms: { ...wire.terms, price: "2" } })).status,
    ).toBe(400);
    expect((await post("/v1/passports", wire)).status).toBe(201); // re-ingest of a valid sidecar is fine

    const bad = await s.gw.app.request(`/v1/grants/${s.grantId}/wrap`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await s.gw.app.request(`/v1/grants/${ZERO_HASH}/wrap`, {
          method: "POST",
          body: new Uint8Array([1]).buffer as ArrayBuffer,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await s.gw.app.request("/v1/blobs", {
          method: "POST",
          body: new Uint8Array(0).buffer as ArrayBuffer,
        })
      ).status,
    ).toBe(400);
    const gwSmall = createGateway(loadConfig({ MAX_UPLOAD_BYTES: "2" }), { logger: noopLogger });
    expect(
      (
        await gwSmall.app.request("/v1/blobs", {
          method: "POST",
          body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
        })
      ).status,
    ).toBe(400);
  });

  it("refuses payment for an unhosted passport and unknown grants cleanly", async () => {
    const s = await scenario();
    expect((await s.gw.app.request(`/v1/query/${s.grantId}/${ZERO_HASH}`)).status).toBe(404);
    const header = encodePaymentHeader({
      x402Version: 1,
      scheme: "exact",
      network: "monad-testnet",
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: s.buyer.owner,
          to: `0x${"aa".repeat(20)}`,
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"05".repeat(32)}`,
        },
      },
    });
    const unknownGrant = await s.gw.app.request(
      `/v1/query/${`0x${"99".repeat(32)}`}/${s.r.passportId}`,
      { headers: { "x-payment": header } },
    );
    expect(unknownGrant.status).toBe(403);
    expect(((await unknownGrant.json()) as { code: string }).code).toBe("FH_GRANT_NOT_LIVE");
    expect(
      (await s.gw.app.request("/v1/query/0x12/0x34", { headers: { "x-payment": header } })).status,
    ).toBe(400);
    expect(typeof s.plaintext).toBe("object");
  });

  it("read-only chain mode refuses on-chain settlement without a relayer", () => {
    expect(() =>
      createGateway(loadConfig({ SETTLEMENT_MODE: "onchain" }), { logger: noopLogger }),
    ).toThrow(/DEPLOYMENTS_FILE/);
  });
});
