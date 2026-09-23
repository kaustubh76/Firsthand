import { noopLogger } from "@firsthand/runtime";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

const b32 = `0x${"ab".repeat(32)}`;

describe("gateway", () => {
  const config = loadConfig({
    X402_MODE: "memory",
    PAY_TO: `0x${"aa".repeat(20)}`,
    RATE_LIMIT_CAPACITY: "2",
    RATE_LIMIT_REFILL_PER_SECOND: "0",
  });
  const { app } = createGateway(config, { logger: noopLogger });

  it("answers health and the discovery document", async () => {
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      // The verifier is named, with the network in the spelling a v2 facilitator uses.
      x402: { mode: "memory", network: "eip155:10143", lastVerifiedBy: null },
    });
    const wk = await app.request("/.well-known/firsthand.json");
    expect(await wk.json()).toMatchObject({
      protocol: "firsthand",
      verbs: ["deposit", "query", "rescind"],
      limits: { maxUploadBytes: 8 * 1024 * 1024 },
    });
    expect(health.headers.get("x-firsthand-gateway")).toBe("0.1.0");
  });

  it("answers 404 for a passport it does not host, before any payment negotiation", async () => {
    const res = await app.request(`/v1/query/${b32}/${b32}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "FH_NOT_FOUND" });
  });

  it("rate-limits the query route as a pre-filter (429 with retry-after)", async () => {
    // Capacity 2, no refill: the third hit on the same IP trips the limiter before any lookup.
    await app.request(`/v1/query/${b32}/${b32}`);
    const limited = await app.request(`/v1/query/${b32}/${b32}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
    expect(limited.headers.get("content-type")).toContain("problem+json");
  });

  it("validates ids and serves blobs / anchor lookups", async () => {
    const fresh = createGateway(loadConfig({}), { logger: noopLogger });
    expect((await fresh.app.request("/v1/blobs/0x12")).status).toBe(400);
    expect((await fresh.app.request(`/v1/blobs/${b32}`)).status).toBe(404);
    expect((await fresh.app.request("/v1/anchors/0x12")).status).toBe(400);
    expect(await (await fresh.app.request(`/v1/anchors/${b32}`)).json()).toEqual({
      root: b32,
      anchored: false,
    });
    const put = await fresh.app.request("/v1/blobs", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
    });
    expect(put.status).toBe(201);
    const { id } = (await put.json()) as { id: string };
    expect((await fresh.app.request(`/v1/blobs/${id}`)).status).toBe(200);
  });

  it("binds read-only on-chain anchors from a deployment file and rejects chain-id mismatches", {
    // The RPC here is unreachable on purpose, and the chain client now backs off 300·2^n ms ×4.
    timeout: 30_000,
  }, async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fh-gw-"));
    const file = join(dir, "31337.json");
    writeFileSync(
      file,
      JSON.stringify({
        chainId: 31337,
        PassportAnchors: `0x${"ab".repeat(20)}`,
        PassportAnchorsBaseline: `0x${"ab".repeat(20)}`,
        PassportAnchorsPaged: `0x${"bb".repeat(20)}`,
        PrincipalRegistry: `0x${"ac".repeat(20)}`,
        Rescissions: `0x${"bc".repeat(20)}`,
        GrantManager: `0x${"ad".repeat(20)}`,
        ReceiptLedger: `0x${"ae".repeat(20)}`,
        RoyaltyRouter: `0x${"af".repeat(20)}`,
        FirsthandLens: `0x${"bf".repeat(20)}`,
        USDC: `0x${"b0".repeat(20)}`,
        anchorsLayout: "baseline",
        genesis: 1_700_000_000,
        epochLength: 604_800,
        revealWindowBlocks: 1000,
      }),
    );
    const gw = createGateway(
      loadConfig({
        DEPLOYMENTS_FILE: file,
        CHAIN_ID: "31337",
        MONAD_RPC_URL: "http://127.0.0.1:1",
      }),
      { logger: noopLogger },
    );
    expect(gw.serving).toBeDefined();
    expect(gw.memory).toBeNull();
    expect(gw.domain.verifyingContract).toBe(`0x${"ab".repeat(20)}`);
    expect(() =>
      createGateway(
        loadConfig({
          DEPLOYMENTS_FILE: file,
          CHAIN_ID: "31337",
          MONAD_RPC_URL: "http://127.0.0.1:1",
          SETTLEMENT_MODE: "onchain",
        }),
        { logger: noopLogger },
      ),
    ).toThrow(/RELAYER_PRIVATE_KEY/);
    const relayed = createGateway(
      loadConfig({
        DEPLOYMENTS_FILE: file,
        CHAIN_ID: "31337",
        MONAD_RPC_URL: "http://127.0.0.1:1",
        SETTLEMENT_MODE: "onchain",
        RELAYER_PRIVATE_KEY: `0x${"01".repeat(32)}`,
      }),
      { logger: noopLogger },
    );
    const health = (await (await relayed.app.request("/healthz")).json()) as {
      settlement: string;
      relayer: { address?: string; error?: string } | null;
    };
    expect(health.settlement).toBe("onchain");
    // With a relayer configured, /healthz reports the float (here the node is unreachable: honest).
    expect(health.relayer).toEqual({ error: "balance unavailable" });
    // Without a relayer key there is nothing to report.
    expect(
      ((await (await gw.app.request("/healthz")).json()) as { relayer: unknown }).relayer,
    ).toBeNull();
    expect(() =>
      createGateway(loadConfig({ DEPLOYMENTS_FILE: file, CHAIN_ID: "10143" }), {
        logger: noopLogger,
      }),
    ).toThrow(/chain 31337/);

    // The discovery document is the browser's DEPLOYMENTS_FILE: it must carry every address and
    // epoch parameter, or the PWA cannot build the domain the gateway verifies under.
    const disco = (await (await gw.app.request("/.well-known/firsthand.json")).json()) as {
      contracts: Record<string, string> | null;
      epochs: { genesis: string; length: string } | null;
      anchorsLayout: string | null;
      relay: { enabled: boolean };
    };
    expect(disco.contracts).toMatchObject({
      PrincipalRegistry: `0x${"ac".repeat(20)}`,
      PassportAnchors: `0x${"ab".repeat(20)}`,
      GrantManager: `0x${"ad".repeat(20)}`,
      Rescissions: `0x${"bc".repeat(20)}`,
    });
    expect(disco.epochs).toEqual({ genesis: "1700000000", length: "604800" });
    expect(disco.anchorsLayout).toBe("baseline");
    expect(disco.relay.enabled).toBe(false);

    // A JSON API that 404s at the root looks broken; the landing page is how a human checks it works.
    const landing = await gw.app.request("/");
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");
    expect(await landing.text()).toContain("/.well-known/firsthand.json");
    // With an app configured, the landing page and discovery point at it.
    const withApp = createGateway(loadConfig({ CAPTURE_URL: "https://app.example" }), {
      logger: noopLogger,
    });
    expect(await (await withApp.app.request("/")).text()).toContain("https://app.example");
    expect(
      ((await (await withApp.app.request("/.well-known/firsthand.json")).json()) as { app: string })
        .app,
    ).toBe("https://app.example");

    // Relay is off unless asked for, and refuses anything outside the deployment's authority
    // contracts — an open relay would be a free-gas faucet.
    expect(relayed.relay).toBeNull();
    const withRelay = createGateway(
      loadConfig({
        DEPLOYMENTS_FILE: file,
        CHAIN_ID: "31337",
        MONAD_RPC_URL: "http://127.0.0.1:1",
        RELAYER_PRIVATE_KEY: `0x${"01".repeat(32)}`,
        RELAY_ENABLED: "true",
      }),
      { logger: noopLogger },
    );
    expect([...(withRelay.relay?.allowList ?? [])].sort()).toEqual(
      [
        `0x${"ab".repeat(20)}`, // PassportAnchors
        `0x${"ac".repeat(20)}`, // PrincipalRegistry
        `0x${"ad".repeat(20)}`, // GrantManager
        `0x${"bc".repeat(20)}`, // Rescissions
      ].sort(),
    );
    expect((await withRelay.app.request("/v1/relay/capabilities")).status).toBe(200);
    const offTarget = await withRelay.app.request("/v1/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: `0x${"99".repeat(20)}`, data: "0x1234" }),
    });
    expect(offTarget.status).toBe(400);
    expect(((await offTarget.json()) as { code: string }).code).toBe("FH_VALIDATION");
    const withValue = await withRelay.app.request("/v1/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: `0x${"ad".repeat(20)}`, data: "0x1234", value: "1" }),
    });
    expect(withValue.status).toBe(400);
    // Relay disabled → the route says so rather than 404ing like an unknown path.
    expect((await relayed.app.request("/v1/relay/capabilities")).status).toBe(404);

    // The faucet double's mint rides the relay only when asked for, and only that selector: a
    // keyless browser can fund a demo buyer, but the relay is still not a USDC transaction service.
    const faucet = createGateway(
      loadConfig({
        DEPLOYMENTS_FILE: file,
        CHAIN_ID: "31337",
        MONAD_RPC_URL: "http://127.0.0.1:1",
        RELAYER_PRIVATE_KEY: `0x${"01".repeat(32)}`,
        RELAY_ENABLED: "true",
        RELAY_FAUCET_MINT: "true",
        RATE_LIMIT_CAPACITY: "3",
        RATE_LIMIT_REFILL_PER_SECOND: "0",
      }),
      { logger: noopLogger },
    );
    const usdc = `0x${"b0".repeat(20)}`;
    expect(faucet.relay?.allowList).toContain(`${usdc}:0x40c10f19`); // mint(address,uint256)
    const relayTo = (to: string, data: string) =>
      faucet.app.request("/v1/relay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.7" },
        body: JSON.stringify({ to, data }),
      });
    const transfer = await relayTo(usdc, `0xa9059cbb${"00".repeat(64)}`); // transfer(address,uint256)
    expect(transfer.status).toBe(400);
    expect(((await transfer.json()) as { detail: string }).detail).toMatch(/not relayable/);
    // The faucet pays for a demo, not a treasury: an amount above RELAY_FAUCET_MAX_UNITS is refused
    // on the calldata, before any simulation.
    const tooMuch = await relayTo(usdc, `0x40c10f19${"00".repeat(32)}${"ff".repeat(32)}`);
    expect(tooMuch.status).toBe(400);
    expect(((await tooMuch.json()) as { detail: string }).detail).toMatch(
      /exceeds the relayed cap/,
    );
    // A permitted selector gets past the allow-list to the simulation (which fails: no node here).
    const mint = await relayTo(usdc, `0x40c10f19${"00".repeat(64)}`);
    expect(mint.status).not.toBe(400);
    expect(((await mint.json()) as { code: string }).code).toBe("FH_CHAIN");
    // The relay has its own bucket: capacity 3, no refill — the fourth call from one IP is 429.
    const limited = await relayTo(usdc, `0x40c10f19${"00".repeat(64)}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
    // Without the flag the token is not on the list at all.
    expect(withRelay.relay?.allowList.some((a) => a.startsWith(usdc))).toBe(false);
  });

  it("answers a rate-limited chain RPC with 503 + retry-after, not an opaque 500", async () => {
    const gw = createGateway(loadConfig({}), { logger: noopLogger });
    // A route that throws what viem throws when the RPC says "too many requests" — and one that
    // throws a plain bug. (Routes go in before the first request; Hono then seals its matcher.)
    gw.app.get("/boom", () => {
      throw new Error(
        "HTTP request failed. Status: 429 Too Many Requests — requests limited to 15/sec",
      );
    });
    gw.app.get("/bug", () => {
      throw new Error("undefined is not a function");
    });
    const res = await gw.app.request("/boom");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toMatchObject({ code: "FH_CHAIN", retryable: true });
    // Everything else non-FIRSTHAND stays an opaque 500.
    expect((await gw.app.request("/bug")).status).toBe(500);
  });

  it("verifies x402 payments for anyone, and refuses to settle a stranger's", async () => {
    // FIRSTHAND needed a real `exact`-scheme verifier for its own gate; it offers the same one to
    // other Monad teams. Free and read-only — and no /settle, which would spend our relayer's gas.
    const gw = createGateway(loadConfig({ X402_NETWORK: "eip155:10143" }), { logger: noopLogger });
    const supported = (await (await gw.app.request("/x402/supported")).json()) as {
      x402Version: number;
      kinds: { scheme: string; network: string }[];
      settle: boolean;
    };
    expect(supported).toMatchObject({ x402Version: 2, settle: false });
    expect(supported.kinds).toEqual([
      { scheme: "exact", network: "eip155:10143", x402Version: 2 },
      { scheme: "exact", network: "monad-testnet", x402Version: 1 },
    ]);
    expect((await gw.app.request("/x402/settle", { method: "POST" })).status).toBe(404);

    const verify = (body: unknown) =>
      gw.app.request("/x402/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify(body),
      });
    const requirements = {
      scheme: "exact",
      network: "eip155:10143",
      amount: "1000",
      asset: `0x${"dc".repeat(20)}`,
      payTo: `0x${"aa".repeat(20)}`,
      maxTimeoutSeconds: 300,
      extra: { chainId: "10143", name: "USD Coin", version: "2" },
    };
    const payload = {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: `0x${"0b".repeat(20)}`,
        to: `0x${"aa".repeat(20)}`,
        value: "1000",
        validAfter: "0",
        validBefore: "99999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    };
    // Monad's envelope (`payload`/`accepted`/`resource`) and the specification's both parse.
    const monadShape = await verify({ x402Version: 2, payload, accepted: requirements });
    expect(monadShape.status).toBe(200);
    expect(await monadShape.json()).toMatchObject({
      isValid: false,
      // A garbage signature is refused by the real check — the memory double would have passed it.
      invalidReason: "invalid_exact_evm_payload_signature",
      verifiedBy: "local",
    });
    const specShape = await verify({
      x402Version: 2,
      paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:10143", payload },
      paymentRequirements: {
        ...requirements,
        resource: { url: "https://gw.test/x", description: "", mimeType: "application/json" },
      },
    });
    expect(await specShape.json()).toMatchObject({ isValid: false, verifiedBy: "local" });
    expect((await verify({ nonsense: true })).status).toBe(400);
  });

  it("bounds ?fromBlock= on the audit routes and rejects garbage", async () => {
    // Memory mode has no chain head, so the value passes through unclamped; the format is still checked.
    const gw = createGateway(loadConfig({}), { logger: noopLogger });
    const bad = await gw.app.request(`/v1/principals/${b32}/timeline?fromBlock=abc`);
    expect(bad.status).toBe(400);
    const ok = await gw.app.request(`/v1/principals/${b32}/timeline?fromBlock=12`);
    expect(ok.status).toBe(200);
    // The route reports what the scan covered, so a viewer can tell "nothing older" from "not looked".
    expect(await ok.json()).toMatchObject({
      principalId: b32,
      events: [],
      scan: { fromBlock: "12", partial: false, clamped: false, requestedFromBlock: "12" },
    });
    const receipts = await gw.app.request(`/v1/grants/${b32}/receipts?fromBlock=0`);
    expect(receipts.status).toBe(200);
  });

  it("boots from DEPLOYMENT_JSON on hosts with no disk, and answers browsers cross-origin", async () => {
    const deployment = {
      chainId: 31337,
      PassportAnchors: `0x${"ab".repeat(20)}`,
      PassportAnchorsBaseline: `0x${"ab".repeat(20)}`,
      PassportAnchorsPaged: `0x${"bb".repeat(20)}`,
      PrincipalRegistry: `0x${"ac".repeat(20)}`,
      Rescissions: `0x${"bc".repeat(20)}`,
      GrantManager: `0x${"ad".repeat(20)}`,
      ReceiptLedger: `0x${"ae".repeat(20)}`,
      RoyaltyRouter: `0x${"af".repeat(20)}`,
      FirsthandLens: `0x${"bf".repeat(20)}`,
      USDC: `0x${"b0".repeat(20)}`,
      anchorsLayout: "baseline",
      genesis: 1_700_000_000,
      epochLength: 604_800,
      revealWindowBlocks: 1000,
    };
    const base = { CHAIN_ID: "31337", MONAD_RPC_URL: "http://127.0.0.1:1" };
    const gw = createGateway(loadConfig({ ...base, DEPLOYMENT_JSON: JSON.stringify(deployment) }), {
      logger: noopLogger,
    });
    expect(gw.memory).toBeNull();
    expect(gw.domain.verifyingContract).toBe(`0x${"ab".repeat(20)}`);
    expect(() =>
      createGateway(loadConfig({ ...base, DEPLOYMENT_JSON: "{nope" }), { logger: noopLogger }),
    ).toThrow(/not valid JSON/);
    expect(() =>
      createGateway(loadConfig({ ...base, DEPLOYMENT_JSON: JSON.stringify({ chainId: 31337 }) }), {
        logger: noopLogger,
      }),
    ).toThrow(/DEPLOYMENT_JSON: missing or malformed/);

    // The PWA is served from another host: a preflight must succeed, and the payment headers the
    // x402 handshake uses must be readable by the page.
    const preflight = await gw.app.request("/v1/relay", {
      method: "OPTIONS",
      headers: {
        origin: "https://capture.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-payment");
    const narrow = createGateway(
      loadConfig({ CORS_ORIGINS: "https://a.example, https://b.example" }),
      {
        logger: noopLogger,
      },
    );
    const allowed = await narrow.app.request("/healthz", {
      headers: { origin: "https://b.example" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://b.example");
    const denied = await narrow.app.request("/healthz", {
      headers: { origin: "https://c.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses the vercel stores without a token, and binds them when one is present", async () => {
    expect(() =>
      createGateway(loadConfig({ BLOB_STORE: "vercel" }), { logger: noopLogger }),
    ).toThrow(/BLOB_READ_WRITE_TOKEN/);
    expect(() => createGateway(loadConfig({ CATALOG: "vercel" }), { logger: noopLogger })).toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    );
    const gw = createGateway(
      loadConfig({
        BLOB_STORE: "vercel",
        CATALOG: "vercel",
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x",
      }),
      { logger: noopLogger },
    );
    expect(await (await gw.app.request("/healthz")).json()).toMatchObject({ blobs: "vercel" });
  });

  it("defaults monad mode to Monad's own facilitator, and accepts an explicit one", () => {
    // X402_FACILITATOR_URL used to be mandatory; the endpoint is published now
    // (https://x402-facilitator.molandak.org, probed 2026-09-23), so the default is the real one
    // and discovery always says which URL is in use.
    const gw = createGateway(loadConfig({ X402_MODE: "monad" }), { logger: noopLogger });
    expect(gw).toBeTruthy();
    expect(() =>
      createGateway(
        loadConfig({
          X402_MODE: "monad",
          X402_FACILITATOR_URL: "https://f",
          BLOB_STORE: "fs",
          BLOB_DIR: "/tmp/fh-test",
        }),
        { logger: noopLogger },
      ),
    ).not.toThrow();
  });
});
