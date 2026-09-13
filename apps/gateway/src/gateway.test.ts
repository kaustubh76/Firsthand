import { encodePaymentHeader } from "@firsthand/adapters";
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
    expect(await health.json()).toMatchObject({ ok: true, x402: "memory" });
    const wk = await app.request("/.well-known/firsthand.json");
    expect(await wk.json()).toMatchObject({
      protocol: "firsthand",
      verbs: ["deposit", "query", "rescind"],
    });
    expect(health.headers.get("x-firsthand-gateway")).toBe("0.1.0");
  });

  it("returns 402 with requirements when no payment is presented", async () => {
    const res = await app.request(`/v1/query/${b32}/${b32}`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Record<string, unknown>[] };
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      payTo: `0x${"aa".repeat(20)}`,
      maxAmountRequired: "1",
    });
    expect(body.accepts[0]?.["resource"]).toContain(b32);
  });

  it("rejects invalid payments as problem+json and rate-limits", async () => {
    const header = encodePaymentHeader({
      x402Version: 1,
      scheme: "exact",
      network: "monad-testnet",
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: `0x${"bb".repeat(20)}`,
          to: `0x${"cc".repeat(20)}`,
          value: "1",
          validAfter: "0",
          validBefore: "1",
          nonce: b32,
        },
      },
    });
    // Third request on the same IP trips the pre-filter (capacity 2, no refill).
    const bad = await app.request(`/v1/query/${b32}/${b32}`, { headers: { "x-payment": header } });
    expect(bad.status).toBe(402);
    expect(bad.headers.get("content-type")).toContain("problem+json");
    expect(await bad.json()).toMatchObject({ code: "FH_PAYMENT_INVALID" });
    const limited = await app.request(`/v1/query/${b32}/${b32}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
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
    const paid = encodePaymentHeader({
      x402Version: 1,
      scheme: "exact",
      network: "monad-testnet",
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: `0x${"bb".repeat(20)}`,
          to: `0x${"00".repeat(20)}`,
          value: "1",
          validAfter: "0",
          validBefore: "1",
          nonce: b32,
        },
      },
    });
    const notYet = await fresh.app.request(`/v1/query/${b32}/${b32}`, {
      headers: { "x-payment": paid },
    });
    expect(notYet.status).toBe(501); // Phase 3
    const badId = await fresh.app.request(`/v1/query/0x12/${b32}`, {
      headers: { "x-payment": paid },
    });
    expect(badId.status).toBe(400);
  });

  it("refuses to boot in monad mode without a facilitator URL", () => {
    expect(() => createGateway(loadConfig({ X402_MODE: "monad" }), { logger: noopLogger })).toThrow(
      /X402_FACILITATOR_URL/,
    );
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
