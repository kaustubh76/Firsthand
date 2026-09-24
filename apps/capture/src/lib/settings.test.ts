import { describe, expect, it } from "vitest";
import { describeSettlement, describeUploadCap, gatewayHref, validGatewayUrl } from "./settings.js";

describe("settings", () => {
  it("gatewayHref sets the override and drops the hash", () => {
    expect(gatewayHref("https://app.example/#locker", "https://gw.example/")).toBe(
      "https://app.example/?gateway=https%3A%2F%2Fgw.example",
    );
    expect(gatewayHref("https://app.example/?principal=0xab#verify", null)).toBe(
      "https://app.example/?principal=0xab&gateway=",
    );
  });
  it("validGatewayUrl accepts https and local http only", () => {
    expect(validGatewayUrl("https://firsthand-gateway.vercel.app/")).toBe(
      "https://firsthand-gateway.vercel.app",
    );
    expect(validGatewayUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(validGatewayUrl("http://gw.example")).toBeNull();
    expect(validGatewayUrl("not a url")).toBeNull();
  });
  it("describes the upload cap and the venue wiring", () => {
    expect(describeUploadCap(null)).toBe("upload limit not published");
    expect(describeUploadCap(4 * 1_048_576)).toBe("4.0 MiB per capture (gateway limit)");
    expect(describeSettlement(null)).toBe("unknown");
    expect(
      describeSettlement({
        ok: true,
        relayer: null,
        x402: { mode: "monad" },
        settlement: "onchain",
        blobs: "vercel",
      }),
    ).toBe("x402 monad · settlement onchain · blobs vercel");
    // `/healthz` serves x402 as an object; typing it as a string here silently dropped the verifier
    // from the sheet for two days. Pinned so a shape change fails a test instead.
    expect(
      describeSettlement({
        ok: true,
        relayer: null,
        x402: { mode: "monad", network: "eip155:10143", lastVerifiedBy: "local" },
        settlement: "onchain",
        blobs: "vercel",
      }),
    ).toBe("x402 monad (verified by local) · settlement onchain · blobs vercel");
  });
});
