import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayUrl } from "./config.js";

/** One hosted build must be pointable at any gateway without a rebuild — that is what a judge with a local gateway needs. */
describe("resolveGatewayUrl", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  afterEach(() => store.clear());

  it("prefers a ?gateway= override and remembers it", () => {
    expect(resolveGatewayUrl("?gateway=https://gw.example")).toBe("https://gw.example");
    expect(resolveGatewayUrl("")).toBe("https://gw.example");
  });

  it("an empty ?gateway= forgets the override and falls back to the build-time value", () => {
    resolveGatewayUrl("?gateway=https://gw.example");
    const fallback = resolveGatewayUrl("?gateway=");
    expect(fallback).toBe((import.meta.env["VITE_GATEWAY_URL"] as string | undefined) ?? null);
  });

  it("still honours the query when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    expect(resolveGatewayUrl("?gateway=https://gw.example")).toBe("https://gw.example");
  });
});

describe("loadConfig", () => {
  it("degrades to offline mode with a reason when the gateway is unreachable or in memory mode", async () => {
    const { loadConfig } = await import("./config.js");
    vi.stubGlobal("localStorage", {
      getItem: () => "http://gw.test",
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    let c = await loadConfig();
    expect(c.live).toBe(false);
    expect(c.reason).toMatch(/gw.test is unreachable/);

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    c = await loadConfig();
    expect(c.reason).toMatch(/answered 503/);

    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ contracts: null, epochs: null }), { status: 200 }),
    );
    c = await loadConfig();
    expect(c.reason).toMatch(/memory mode/);

    const disco = {
      chainId: "10143",
      rpcUrl: "https://rpc.test",
      anchorsLayout: "baseline",
      relay: { enabled: true },
      contracts: {
        PassportAnchors: `0x${"01".repeat(20)}`,
        GrantManager: `0x${"02".repeat(20)}`,
        Rescissions: `0x${"03".repeat(20)}`,
        PrincipalRegistry: `0x${"04".repeat(20)}`,
      },
      epochs: { genesis: "1", length: "604800" },
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(disco), { status: 200 }));
    c = await loadConfig();
    expect(c.live).toBe(true);
    expect(c.reason).toBeNull();
    expect(c.chainId).toBe(10143n);

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ ...disco, relay: { enabled: false } }), { status: 200 }),
    );
    c = await loadConfig();
    expect(c.live).toBe(false);
    expect(c.reason).toMatch(/RELAY_ENABLED=false/);
  });
});
