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
