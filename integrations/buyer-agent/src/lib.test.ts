import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalLink,
  type Buyer,
  discover,
  fetchSidecar,
  listing,
  listPassports,
  reputation,
  resilientFetch,
} from "./lib.js";

/**
 * The partner template is the code an integrator reads first, and until now it had no test at all —
 * `passWithNoTests` meant its suite went green at zero coverage while it drove real paid queries.
 *
 * What is covered here is everything that needs no chain: the HTTP surface a gateway answers, and
 * `resilientFetch`, which is the reason this template survives a serverless host. The chain-bound
 * half (`prepare`, `registerAgent`, `awaitGrant`, `buy`, `complianceFile`) is exercised end to end
 * by the browser tier against the live links — `apps/capture/e2e/capture.e2e.ts` imports these very
 * functions for its outside buyer, so the two halves together cover the file.
 */
const GW = "https://gw.example";
const PRINCIPAL = `0x${"11".repeat(32)}` as const;
const PASSPORT = `0x${"22".repeat(32)}` as const;

/** A fetch stub that replays a queued script and records what it was asked for. */
function stubFetch(...responses: (Response | Error)[]): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      // A Response body can only be read once, so hand back a fresh clone per call.
      return (next as Response).clone();
    },
  );
  return { calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** Node throws a bare "fetch failed" with the real reason on `cause.code`. */
const netError = (code: string) =>
  Object.assign(new Error("fetch failed"), { cause: { code } as { code: string } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resilientFetch", () => {
  it("retries a read through a dropped keep-alive socket", async () => {
    // The symptom this exists for: a serverless host closed a socket Node still had pooled, so the
    // very first call fails with no status at all on an endpoint that is perfectly healthy.
    const s = stubFetch(netError("UND_ERR_SOCKET"), json({ ok: true }));
    const res = await resilientFetch(GW);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.calls).toHaveLength(2);
  });

  it("waits out a 503 and honours retry-after", async () => {
    // The gateway answers 503 + retry-after when its own chain RPC is rate-limiting it. A read is
    // worth waiting for; the header is capped so a hostile value cannot park the buyer for an hour.
    const s = stubFetch(json({ busy: true }, { status: 503, headers: { "retry-after": "1" } }));
    const started = Date.now();
    const res = await resilientFetch(GW);
    expect(res.status).toBe(503); // gives up after the attempts, rather than looping forever
    expect(s.calls.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("does not repeat a write that may have been sent", async () => {
    // A POST that failed after the bytes left is not safe to repeat — only a connection that was
    // never made is. ECONNRESET could be either, so it is not in the not-sent set.
    const s = stubFetch(netError("ECONNRESET"));
    await expect(resilientFetch(GW, { method: "POST" })).rejects.toThrow("fetch failed");
    expect(s.calls).toHaveLength(1);
  });

  it("does repeat a write that provably never left", async () => {
    const s = stubFetch(netError("ECONNREFUSED"), json({ ok: true }));
    const res = await resilientFetch(GW, { method: "POST" });
    expect(res.status).toBe(200);
    expect(s.calls).toHaveLength(2);
  });
});

describe("discovery", () => {
  it("reads the well-known document", async () => {
    const s = stubFetch(json({ chainId: "10143", x402: { asset: "0xa", payTo: "0xb" } }));
    const d = await discover(`${GW}/`); // trailing slash must not double up
    expect(d.chainId).toBe("10143");
    expect(s.calls[0]).toBe(`GET ${GW}/.well-known/firsthand.json`);
  });

  it("fails loudly when the gateway does not publish one", async () => {
    stubFetch(json({}, { status: 404 }));
    await expect(discover(GW)).rejects.toThrow("discovery failed: 404");
  });
});

describe("listing a principal's passports", () => {
  it("asks for the namespace and class the buyer wants", async () => {
    const s = stubFetch(json({ passports: [], freshness: {} }));
    await listing(GW, PRINCIPAL, 0, { class: 2 });
    expect(s.calls[0]).toContain(`/v1/principals/${PRINCIPAL}/passports?`);
    expect(s.calls[0]).toContain("ns=0");
    expect(s.calls[0]).toContain("class=2");
  });

  it("omits filters it was not given", async () => {
    const s = stubFetch(json({ passports: [], freshness: {} }));
    await listing(GW, PRINCIPAL);
    expect(s.calls[0]).not.toContain("ns=");
    expect(s.calls[0]).not.toContain("class=");
  });

  it("tolerates a gateway too old to publish freshness", async () => {
    // Older gateways answer without the block; a buyer must still be able to list.
    stubFetch(json({ passports: [{ passportId: PASSPORT, ns: 0 }] }));
    const l = await listing(GW, PRINCIPAL);
    expect(l.freshness).toEqual({});
    expect(l.passports).toHaveLength(1);
  });

  it("listPassports is the listing without the pricing block", async () => {
    stubFetch(json({ passports: [{ passportId: PASSPORT, ns: 0 }], freshness: { "0": {} } }));
    await expect(listPassports(GW, PRINCIPAL)).resolves.toHaveLength(1);
  });

  it("fails loudly on a refusal", async () => {
    stubFetch(json({}, { status: 500 }));
    await expect(listing(GW, PRINCIPAL)).rejects.toThrow("listing failed: 500");
  });
});

describe("fetchSidecar", () => {
  it("names the passport the gateway does not host", async () => {
    stubFetch(json({}, { status: 404 }));
    await expect(fetchSidecar(GW, PASSPORT)).rejects.toThrow(
      `the gateway does not host ${PASSPORT} (404)`,
    );
  });

  it("refuses a body that is not a sidecar rather than passing it on", async () => {
    // parseSidecar is the buyer's first line of defence: a gateway cannot hand it a shape it has
    // not checked, because everything downstream trusts the parse.
    stubFetch(json({ not: "a sidecar" }));
    await expect(fetchSidecar(GW, PASSPORT)).rejects.toThrow();
  });
});

describe("approvalLink", () => {
  const buyer = {
    cardId: `0x${"ab".repeat(32)}`,
    encryptionPubKey: `0x${"cd".repeat(32)}`,
  } as unknown as Buyer;

  it("carries the card, the key, the namespace and who is asking", () => {
    const url = new URL(approvalLink(`${GW}/`, buyer, 3, "My agent"));
    expect(url.searchParams.get("grant")).toBe(buyer.cardId);
    expect(url.searchParams.get("pub")).toBe(buyer.encryptionPubKey);
    expect(url.searchParams.get("ns")).toBe("3");
    expect(url.searchParams.get("from")).toBe("My agent");
    expect(url.searchParams.get("agent")).toBeNull();
    expect(url.pathname).toBe("/"); // the trailing slash was not doubled
  });

  it("names the ERC-8004 agent when the buyer has one, so the human can check the binding", () => {
    const url = new URL(approvalLink(GW, buyer, 0, "My agent", 1925n));
    expect(url.searchParams.get("agent")).toBe("1925");
  });

  it("escapes a label rather than letting it forge query parameters", () => {
    const url = new URL(approvalLink(GW, buyer, 0, "evil&agent=9999"));
    expect(url.searchParams.get("agent")).toBeNull();
    expect(url.searchParams.get("from")).toBe("evil&agent=9999");
  });
});

describe("reputation", () => {
  it("reports what the venue credited", async () => {
    stubFetch(
      json({
        owner: "0xowner",
        reputation: { paidQueriesHere: "2", firsthandFeedbackAll: "5" },
      }),
    );
    await expect(reputation(GW, 1925n)).resolves.toEqual({
      owner: "0xowner",
      paidQueriesHere: "2",
      firsthandFeedbackAll: "5",
    });
  });

  it("is null on a chain with no registry, rather than throwing", async () => {
    stubFetch(json({}, { status: 404 }));
    await expect(reputation(GW, 1n)).resolves.toBeNull();
  });
});
