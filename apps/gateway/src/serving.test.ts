import {
  buildAgentURI,
  encodePaymentHeader,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryConsentLedger,
  MemoryDeviceRegistry,
  MemoryErc8004Registry,
  MemoryGrantReader,
  MemoryPassportCatalog,
  MemorySettlement,
  MemoryTransport,
} from "@firsthand/adapters";
import {
  type Attestation,
  AttestationClass,
  type Bytes32,
  hashTerms,
  LICENSE_FH_1_0,
  type PassportSidecar,
  Scope,
  sidecarToWire,
  type Terms,
  VerifyFailure,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { noopLogger } from "@firsthand/runtime";
import {
  Batcher,
  BuyerSession,
  createBuyerKeys,
  deposit,
  deviceClassFor,
  exportLocker,
  importLocker,
  Locker,
  mintPassport,
  parseBundle,
  planGrant,
  publishDeposit,
  publishWrap,
  serialiseBundle,
  sidecarFor,
  signCaptureWitness,
} from "@firsthand/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { createGateway, LENS_REASONS } from "./server.js";
import { Serving } from "./services/Serving.js";

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

async function scenario(erc8004?: MemoryErc8004Registry) {
  const gw = createGateway(
    loadConfig({
      PASSPORT_ANCHORS: `0x${"a1".repeat(20)}`,
      PAY_TO: `0x${"aa".repeat(20)}`,
      CHAIN_ID: "10143",
      RATE_LIMIT_CAPACITY: "1000",
      ...(erc8004 ? { ERC8004_FEEDBACK: "true" } : {}),
    }),
    {
      logger: noopLogger,
      ...(erc8004 ? { erc8004, relayerAddress: erc8004.client } : {}),
    },
  );
  if (!gw.memory) throw new Error("memory mode expected");
  // The buyer's own fetch, with the last `payment-response` header kept: x402 v2 returns the
  // settlement in that header, and the SDK does not surface response headers to its caller.
  let lastPaymentResponse: string | null = null;
  const fetchApp = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await gw.app.request(String(input).replace("http://gw", ""), init);
    lastPaymentResponse = res.headers.get("payment-response") ?? lastPaymentResponse;
    return res;
  }) as unknown as typeof fetch;

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
    paymentResponse: () => lastPaymentResponse,
    plaintext,
    sidecar: sidecarFor(locker, batcher, r, terms),
  };
}

describe("gateway serving path (memory mode)", () => {
  it("publishes, prices from the sidecar's terms, serves paid queries with receipts, and enforces rescission and rate limits", async () => {
    const s = await scenario();
    const url = `/v1/query/${s.grantId}/${s.r.passportId}`;

    // Discovery: a buyer handed the principal's locker link lists what it can buy.
    const listed = (await (
      await s.gw.app.request(`/v1/principals/${s.sidecar.principalId}/passports`)
    ).json()) as {
      passports: { passportId: string; ns: number; price: string; class: number | null }[];
      freshness: Record<string, { lastAnchoredAt: string | null; staleness: number }>;
    };
    // The attestation preimage travels with the sidecar, so a buyer sees the class in the open …
    expect(listed.passports).toEqual([
      expect.objectContaining({
        passportId: s.r.passportId,
        ns: 0,
        price: "1000",
        class: AttestationClass.IMPORT,
        capturedAt: "0",
      }),
    ]);
    // … filters on it (README §13), and reads the namespace's freshness signal (README §7.3) —
    // memory mode has no block clock, so nothing is dated and staleness is the honest 1.
    const byClass = async (klass: number) =>
      (
        (await (
          await s.gw.app.request(`/v1/principals/${s.sidecar.principalId}/passports?class=${klass}`)
        ).json()) as { passports: unknown[] }
      ).passports.length;
    expect(await byClass(AttestationClass.IMPORT)).toBe(1);
    expect(await byClass(AttestationClass.DEVICE_CAPTURE)).toBe(0);
    expect(
      (await s.gw.app.request(`/v1/principals/${s.sidecar.principalId}/passports?class=7`)).status,
    ).toBe(400);
    expect(listed.freshness["0"]).toEqual({
      lastAnchoredAt: null,
      halfLifeSeconds: expect.any(String),
      staleness: 1,
    });
    expect(
      (
        (await (
          await s.gw.app.request(`/v1/principals/${s.sidecar.principalId}/passports?ns=3`)
        ).json()) as { passports: unknown[] }
      ).passports,
    ).toEqual([]);
    expect(
      (await s.gw.app.request(`/v1/principals/${s.sidecar.principalId}/passports?ns=99`)).status,
    ).toBe(400);

    const offer = await s.gw.app.request(url);
    expect(offer.status).toBe(402);
    const body = (await offer.json()) as {
      x402Version: number;
      accepts: Record<string, unknown>[];
    };
    // The price is offered in both protocol versions' spelling, so a v1 buyer and an off-the-shelf
    // x402 v2 agent can each read it (ADR-0014).
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({
      maxAmountRequired: "1000",
      network: "monad-testnet",
      payTo: `0x${"aa".repeat(20)}`,
      extra: { chainId: "10143" },
    });
    expect(body.accepts[1]).toMatchObject({
      amount: "1000",
      network: "eip155:10143",
      resource: { url: expect.stringContaining("/v1/query/") },
    });
    // …and v2's header carries the same thing for a client that reads headers, not bodies.
    const required = offer.headers.get("payment-required");
    expect(required).toBeTruthy();
    expect(JSON.parse(atob(required as string))).toMatchObject({ x402Version: 2 });

    const { result, plaintext } = await s.buyer.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId },
      s.gw.domain,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("served plaintext");
    expect(result.receipt.receiptId).toMatch(/^0x/);
    // x402 v2 hands the settlement back in a header, so a standard client learns what happened
    // without parsing a body it does not know (ADR-0014).
    const settlement = s.paymentResponse();
    expect(settlement, "no payment-response header on a served query").toBeTruthy();
    expect(JSON.parse(atob(settlement as string))).toMatchObject({
      success: true,
      network: "eip155:10143",
      receiptId: result.receipt.receiptId,
      payer: expect.stringMatching(/^0x[0-9a-f]{40}$/),
    });
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
    // A carried attestation must be the preimage the passport committed to.
    expect(
      (
        await post("/v1/passports", {
          ...wire,
          attestation: { ...wire.attestation, class: AttestationClass.DEVICE_CAPTURE },
        })
      ).status,
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

  it("ERC-8004: a paid query by a carded agent becomes feedback; an unbound agent gets none", async () => {
    const reg = new MemoryErc8004Registry({
      identityRegistry: `0x${"80".repeat(20)}`,
      reputationRegistry: `0x${"81".repeat(20)}`,
    });
    const s = await scenario(reg);
    // The buyer registered an ERC-8004 identity from its own key, naming its card in metadata.
    const agentId = reg.mint(
      s.buyer.owner,
      buildAgentURI({
        name: "Outside agent",
        description: "",
        owner: s.buyer.owner,
        cardId: s.buyer.cardId,
        encryptionPubKey: s.buyer.encryptionPubKey,
      }),
      s.buyer.cardId,
    );
    const impostor = reg.mint(`0x${"ee".repeat(20)}`, "data:application/json,{}", s.buyer.cardId);

    // The agents route shows who is asking, before any grant.
    const who = (await (await s.gw.app.request(`/v1/agents/${agentId}`)).json()) as {
      owner: string;
      cardId: string;
      reputation: { paidQueriesHere: string };
    };
    expect(who).toMatchObject({ owner: s.buyer.owner, cardId: s.buyer.cardId });
    expect(who.reputation.paidQueriesHere).toBe("0");
    expect((await s.gw.app.request("/v1/agents/999")).status).toBe(404);
    expect((await s.gw.app.request("/v1/agents/abc")).status).toBe(400);

    await s.buyer.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId, agentId },
      s.gw.domain,
    );
    await new Promise((r) => setTimeout(r, 20)); // feedback is off the response path
    expect(reg.feedback).toHaveLength(1);
    expect(reg.feedback[0]).toMatchObject({
      agentId,
      tag1: "firsthand",
      tag2: "paid-query",
      value: 1n,
      feedbackURI: `http://localhost:8402/v1/grants/${s.grantId}/receipts`,
    });
    const after = (await (await s.gw.app.request(`/v1/agents/${agentId}`)).json()) as {
      reputation: { paidQueriesHere: string };
    };
    expect(after.reputation.paidQueriesHere).toBe("1");

    // Someone else's agent naming this card is not bound: the owner does not match. No feedback.
    await s.buyer.queryAndOpen(
      {
        gatewayUrl: "http://gw",
        grantId: s.grantId,
        passportId: s.r.passportId,
        agentId: impostor,
      },
      s.gw.domain,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.feedback).toHaveLength(1);
    // Discovery names the registries and who gives feedback.
    const disco = (await (await s.gw.app.request("/.well-known/firsthand.json")).json()) as {
      erc8004: { identityRegistry: string; feedbackBy: string };
    };
    expect(disco.erc8004).toMatchObject({
      identityRegistry: `0x${"80".repeat(20)}`,
      feedbackBy: reg.client,
    });
  });

  it("ERC-8004: a rate-limited RPC delays the feedback, it does not lose it", async () => {
    // Measured on the live gateway 2026-09-24: a real paid query credited the agent nothing because
    // `getMetadata(agentId, "firsthand.card")` — one of four chain reads fired in the same second as
    // the query — came back "requests limited to 15/sec". Monad returns that as a JSON-RPC error
    // inside an HTTP 200, so viem does not retry it, and the catch turned a dropped credit into a
    // log line. Feedback runs off the response path, so it can afford to wait the window out.
    const reg = new MemoryErc8004Registry({
      identityRegistry: `0x${"80".repeat(20)}`,
      reputationRegistry: `0x${"81".repeat(20)}`,
    });
    // The read Monad actually refused, refusing once.
    let refusals = 0;
    const realVerify = reg.verifyCardBinding.bind(reg);
    reg.verifyCardBinding = async (...args) => {
      if (refusals++ === 0) throw new Error("HTTP request failed: requests limited to 15/sec");
      return realVerify(...args);
    };
    const s = await scenario(reg);
    const agentId = reg.mint(
      s.buyer.owner,
      buildAgentURI({
        name: "Outside agent",
        description: "",
        owner: s.buyer.owner,
        cardId: s.buyer.cardId,
        encryptionPubKey: s.buyer.encryptionPubKey,
      }),
      s.buyer.cardId,
    );

    // …and the write refused once too, which is safe to repeat: a rate limit is a refusal before
    // the transaction reaches a mempool.
    reg.failNext(new Error("requests limited to 15/sec"));

    await s.buyer.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId, agentId },
      s.gw.domain,
    );
    await vi.waitFor(() => expect(reg.feedback).toHaveLength(1), { timeout: 10_000 });
    expect(reg.feedback[0]).toMatchObject({ agentId, tag1: "firsthand", tag2: "paid-query" });
    expect(refusals).toBeGreaterThan(1); // it really did retry the read

    // And the outcome is visible from outside the function. The retry above works against a double;
    // on the hosted gateway (2026-09-27) two live runs credited nothing anyway, and from outside
    // there was no way to tell a rate-limited read from the feature being off. Now there is.
    const health = (await (await s.gw.app.request("/healthz")).json()) as {
      reputation: { agentId: string; ok: boolean; detail?: string } | null;
    };
    expect(health.reputation).toMatchObject({ agentId: agentId.toString(), ok: true });
  });

  it("ERC-8004: a write that timed out is NOT retried — crediting twice is worse than crediting late", async () => {
    // The asymmetry is deliberate. A rate limit is refused before broadcast; a timeout may be a
    // transaction that landed and whose reply was lost, and an agent credited twice for one paid
    // query is a lie about its reputation. So the send retries the first and never the second.
    const reg = new MemoryErc8004Registry({
      identityRegistry: `0x${"80".repeat(20)}`,
      reputationRegistry: `0x${"81".repeat(20)}`,
    });
    const s = await scenario(reg);
    const agentId = reg.mint(
      s.buyer.owner,
      buildAgentURI({
        name: "Outside agent",
        description: "",
        owner: s.buyer.owner,
        cardId: s.buyer.cardId,
        encryptionPubKey: s.buyer.encryptionPubKey,
      }),
      s.buyer.cardId,
    );
    reg.failNext(new Error("socket hang up: request timed out"));
    await s.buyer.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: s.grantId, passportId: s.r.passportId, agentId },
      s.gw.domain,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(reg.feedback).toHaveLength(0);
    // Not credited, and `/healthz` says so with the reason. A dropped credit used to be visible only
    // as an agent that had never been credited, which is the same symptom as the feature being off.
    const health = (await (await s.gw.app.request("/healthz")).json()) as {
      reputation: { ok: boolean; detail?: string } | null;
    };
    expect(health.reputation?.ok).toBe(false);
    expect(health.reputation?.detail).toMatch(/timed out/);
  });

  it("the verify route reports the predicate off chain, and says plainly when no chain was asked", async () => {
    // README §7.3: `FirsthandLens.verify` is the on-chain twin of core's `verifyPredicate`, and the
    // two must agree down to the reason. In memory mode there is no Lens to ask, and the honest
    // answer is `null` — never a `true` that nothing checked. The live parity check runs on anvil.
    const s = await scenario();
    const res = await s.fetchApp(`http://gw/v1/verify/${s.r.passportId}?grant=${s.grantId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offchain: { ok: boolean; reason: string };
      onchain: unknown;
      agree: boolean | null;
    };
    expect(body.offchain).toMatchObject({ ok: true, reason: "NONE" });
    expect(body.onchain).toBeNull();
    expect(body.agree).toBeNull();

    // A grant that does not exist is refused, with the reason named rather than a bare false.
    const absent = await s.fetchApp(
      `http://gw/v1/verify/${s.r.passportId}?grant=0x${"77".repeat(32)}`,
    );
    const absentBody = (await absent.json()) as { offchain: { ok: boolean; reason: string } };
    expect(absentBody.offchain).toMatchObject({ ok: false, reason: "GRANT_NOT_LIVE" });

    // Without ?grant there is nothing to verify against; say so rather than guessing one.
    expect((await s.fetchApp(`http://gw/v1/verify/${s.r.passportId}`)).status).toBe(400);
  });

  it("the Lens reason ordinals still line up with core's VerifyFailure", () => {
    // Solidity enums cross the ABI as integers, so this table is the only place the two spellings
    // meet. If someone reorders either enum, a verdict would decode to the wrong name and the twin
    // would look like it disagreed when it did not — so the coupling is asserted, not assumed.
    expect(LENS_REASONS).toEqual(["NONE", ...Object.keys(VerifyFailure)]);
  });

  it("exit: a locker bundle re-hosts on another conformant gateway, and the buyer's query works there", async () => {
    // README §4/§12/§13: "exit = keys + blobs walk away … any conformant client resumes". Gateway A
    // hosts the locker; the bundle is its public objects only; gateway B is empty.
    const s = await scenario();
    const bundle = await exportLocker({
      gatewayUrl: "http://gw",
      principalId: s.sidecar.principalId,
      chainId: 10143n,
      grantIds: [s.grantId],
      fetch: s.fetchApp,
      now: () => 99n,
    });
    expect(bundle.passports).toHaveLength(1);
    expect(bundle.wraps).toEqual([{ grantId: s.grantId, wrap: expect.any(String) }]);
    // No plaintext, no key: the file is ciphertext, sidecars and wrap bytes, base64.
    const file = serialiseBundle(bundle);
    expect(file).not.toContain("served plaintext");
    expect(parseBundle(file).passports[0]?.sidecar.principalId).toBe(s.sidecar.principalId);

    const b = createGateway(
      loadConfig({
        PASSPORT_ANCHORS: `0x${"a1".repeat(20)}`,
        PAY_TO: `0x${"aa".repeat(20)}`,
        CHAIN_ID: "10143",
        RATE_LIMIT_CAPACITY: "1000",
      }),
      { logger: noopLogger },
    );
    if (!b.memory) throw new Error("memory mode expected");
    const fetchB = ((input: string | URL | Request, init?: RequestInit) =>
      b.app.request(String(input).replace("http://gw-b", ""), init)) as unknown as typeof fetch;
    // A conformant gateway takes nothing on trust: with B's chain view empty, every sidecar and
    // the wrap are refused with the gateway's reason …
    const refused = await importLocker({ gatewayUrl: "http://gw-b", bundle: file, fetch: fetchB });
    expect(refused.passports).toBe(0);
    expect(refused.skipped.map((x) => x.reason)).toEqual([
      expect.stringMatching(/not anchored/),
      expect.stringMatching(/unknown grant/),
    ]);
    // … and once B sees the same chain (the anchors and the grant, as it would on Monad), the
    // same bundle lands whole.
    if (!s.gw.memory) throw new Error("memory mode expected");
    for (const call of s.gw.memory.anchors.callsTo("anchor")) {
      await b.memory.anchors.anchor(call.args[0] as never);
    }
    b.memory.grants.setEpoch(5n);
    b.memory.grants.enroll(s.locker.principalId, 5n);
    b.memory.grants.registerCard(s.buyer.owner, s.buyer.encryptionPubKey);
    b.memory.grants.acceptTerms(s.buyer.cardId, s.locker.principalId, s.terms);
    b.memory.grants.grant({
      principalId: s.locker.principalId,
      granteeCard: s.buyer.cardId,
      ns: 0,
      termsHash: hashTerms(s.terms),
      wrapRef: s.plan.wrapRef,
      term: 4n,
    });
    const report = await importLocker({ gatewayUrl: "http://gw-b", bundle: file, fetch: fetchB });
    expect(report).toEqual({ passports: 1, blobs: 2, wraps: 1, skipped: [] });
    expect((await b.app.request(`/v1/passports/${s.r.passportId}`)).status).toBe(200);

    // The buyer, with the grant it already holds, opens the same plaintext on B.
    const buyerB = new BuyerSession({
      keys: createBuyerKeys(
        new Uint8Array(32).fill(0x0b),
        privateKeyToAccount(`0x${"0b".repeat(32)}`),
        new Uint8Array(32).fill(0x0c),
      ),
      grantManager: `0x${"b1".repeat(20)}`,
      chainId: 10143n,
      transport: new MemoryTransport(),
      fetch: fetchB,
    });
    const { plaintext } = await buyerB.queryAndOpen(
      { gatewayUrl: "http://gw-b", grantId: s.grantId, passportId: s.r.passportId },
      b.domain,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("served plaintext");
    // A bundle whose ciphertext was altered is refused before any request is made.
    const tampered = parseBundle(file);
    const altered = {
      ...tampered,
      passports: tampered.passports.map((p) => ({ ...p, blob: btoa("not the ciphertext") })),
    };
    const bad = await importLocker({ gatewayUrl: "http://gw-b", bundle: altered, fetch: fetchB });
    expect(bad.skipped[0]?.reason).toMatch(/does not hash/);
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

/**
 * The class-3 ingest gate (ADR-0015).
 *
 * This is the enforcement point that matters. A locker checks its own deposits, but a buyer
 * trusts the gateway, and the sidecar is the first place the attestation preimage and the witness
 * are both in hand. Everything here runs against memory doubles — the same code path the anvil
 * tier runs for real.
 */

const domain = { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` } as const;

/**
 * Lockers and a device key, opened once for the whole suite.
 *
 * Deriving a key tree is the expensive part of a locker, and under `--coverage` nine of them is
 * the difference between a five-second test and a timeout. The anchors are shared too, because a
 * `Serving` can only confirm a root its own anchor writer saw; each test still gets its own
 * `Serving` and its own device registry, which is what the tests actually vary.
 */
const shared = (async () => {
  const anchors = new MemoryAnchorWriter();
  const locker = await Locker.open(prfSource(1), {
    domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    epochs,
    anchors,
    blobs: new MemoryBlobStore(),
    clock,
    namespaces: [{ ns: 0, label: "captures" }],
  });
  // A software stand-in for the phone's secure element. It is a real P-256 key, so the witness is
  // well formed; what it is not is *registered*, which is the whole point of the registry checks.
  const device = (
    await Locker.open(prfSource(9), {
      domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      epochs,
      anchors,
      blobs: new MemoryBlobStore(),
      clock,
    })
  ).authorityKey();
  return { anchors, locker, device };
})();

async function harness(
  options: { devices?: MemoryDeviceRegistry; requireVerifiedBoot?: boolean } = {},
) {
  const { anchors, locker, device } = await shared;
  const grants = new MemoryGrantReader();
  const serving = new Serving({
    anchors,
    blobs: new MemoryBlobStore(),
    catalog: new MemoryPassportCatalog(),
    grants,
    settlement: new MemorySettlement(grants, new MemoryConsentLedger()),
    domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    logger: noopLogger,
    ...(options.devices ? { devices: options.devices } : {}),
    ...(options.requireVerifiedBoot ? { requireVerifiedBoot: true } : {}),
  });
  grants.setEpoch(5n);
  grants.enroll(locker.principalId, 5n);

  const terms: Terms = {
    price: 1_000n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 2,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  };

  const attestation: Attestation = {
    class: AttestationClass.HARDWARE,
    capturedAt: 1_700_000_000n,
    sourceTag: ZERO_HASH,
    deviceClass: deviceClassFor(device.publicKey),
    metaHash: ZERO_HASH,
  };

  /** A published-shaped sidecar for a class-3 deposit, with whatever witness the caller wants. */
  async function sidecarOf(
    mutate: (witness: PassportSidecar["hardware"]) => PassportSidecar["hardware"] = (w) => w,
    att: Attestation = attestation,
  ): Promise<PassportSidecar> {
    const batcher = new Batcher(locker, anchors, 1);
    const bytes = new TextEncoder().encode(`capture ${att.capturedAt}-${Math.random()}`);
    const signed = mintPassport(locker, {
      ns: 0,
      datum: { kind: "bytes", bytes },
      terms,
      attestation: att,
    });
    const hardware = signCaptureWitness(device, {
      chainId: domain.chainId,
      passport: signed.passport,
      attestation: att,
    });
    const result = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes },
      terms,
      attestation: att,
      hardware,
    });
    const sidecar = sidecarFor(locker, batcher, result, terms);
    const mutated = mutate(sidecar.hardware);
    const { hardware: _drop, ...rest } = sidecar;
    return mutated ? { ...rest, hardware: mutated } : rest;
  }

  return { serving, locker, terms, attestation, device, sidecarOf, anchors };
}

describe("gateway ingest — a class-3 passport is checked, not believed", () => {
  it("accepts a witnessed capture from a registered device", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });

    const sidecar = await h.sidecarOf();
    await expect(h.serving.ingestPassport(sidecar)).resolves.toBeDefined();
  });

  it("refuses when this gateway cannot reach a device registry at all", async () => {
    // Absence is a refusal, not a pass: a gateway that cannot ask whether a key is hardware-backed
    // has no business hosting a passport that says it is.
    const h = await harness();
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/cannot reach a device registry/),
    });
  });

  it("refuses a device that was never registered", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/not registered to this principal, or has been revoked/),
    });
  });

  it("refuses a revoked device, so a stolen phone stops depositing", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    const id = devices.register({
      principalId: h.locker.principalId,
      publicKey: h.device.publicKey,
    });
    devices.revoke(id, 1_700_000_500n);
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
    });
  });

  it("refuses a device registered to somebody else", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({
      principalId: `0x${"ee".repeat(32)}` as Bytes32,
      publicKey: h.device.publicKey,
    });
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
    });
  });

  it("refuses a class-3 sidecar carrying no witness", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    await expect(
      h.serving.ingestPassport(await h.sidecarOf(() => undefined)),
    ).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/no secure-element witness/),
    });
  });

  it("refuses a witness whose signature does not verify", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    const tampered = await h.sidecarOf((w) =>
      w ? { ...w, signature: `0x${"22".repeat(64)}` } : w,
    );
    await expect(h.serving.ingestPassport(tampered)).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/does not verify over this passport/),
    });
  });

  it("applies verified-boot policy here, because the chain deliberately does not", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices, requireVerifiedBoot: true });
    // Registered, live, correctly witnessed — and booted unverified. The chain recorded that and
    // accepted the device; refusing it is this gateway's published choice, not the protocol's.
    devices.register({
      principalId: h.locker.principalId,
      publicKey: h.device.publicKey,
      verifiedBootState: 2,
    });
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/verified-boot state is Verified/),
    });

    // A gateway that has not published that policy takes the same deposit.
    const lenient = await harness({ devices });
    devices.register({
      principalId: lenient.locker.principalId,
      publicKey: lenient.device.publicKey,
      verifiedBootState: 2,
    });
    await expect(lenient.serving.ingestPassport(await lenient.sidecarOf())).resolves.toBeDefined();
  });

  it("rejects a witness attached to a passport that never claimed class 3", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    const classTwo: Attestation = { ...h.attestation, class: AttestationClass.DEVICE_CAPTURE };
    // Well-formed, verifiable, and meaningless — storing it where a reader might mistake it for a
    // checked claim is worse than refusing it.
    await expect(h.serving.ingestPassport(await h.sidecarOf((w) => w, classTwo))).rejects.toThrow(
      /does not claim class 3/,
    );
  });
});
