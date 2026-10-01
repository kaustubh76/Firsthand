import { type Bytes32, bytesToHex, keccak256, sidecarToWire, ZERO_HASH } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import {
  exportLocker,
  fromBase64,
  importLocker,
  parseBundle,
  serialiseBundle,
  toBase64,
} from "./bundle.js";

const b32 = (n: number): Bytes32 => `0x${n.toString(16).padStart(64, "0")}` as Bytes32;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const id = (bytes: Uint8Array): Bytes32 => bytesToHex(keccak256(bytes)) as Bytes32;

const PRINCIPAL = b32(0x51);
const GRANT = b32(0x77);

/** A gateway's public objects for one locker, behind a scripted fetch: what `exportLocker` reads. */
function fakeGateway(options: { ciphertextTamper?: boolean } = {}) {
  const blob = new TextEncoder().encode("ciphertext-bytes");
  const wrappedDek = new TextEncoder().encode("wrapped-dek-bytes");
  const wrap = new TextEncoder().encode("grant-wrap-bytes");
  const sidecar = {
    signed: {
      passport: {
        h: b32(1),
        origin: addr(2),
        attest: b32(3),
        termsHash: b32(4),
        epoch: 5n,
        nonce: b32(6),
      },
      signature: `0x${"ab".repeat(65)}` as `0x${string}`,
    },
    principalId: PRINCIPAL,
    ns: 0,
    batchRoot: b32(9),
    proof: { index: 0, siblings: Array.from({ length: 8 }, (_, i) => b32(0x10 + i)) },
    terms: {
      price: 1n,
      licenseId: ZERO_HASH,
      scope: 1,
      ns: 0,
      rateLimit: 100,
      payees: [addr(7)],
      weights: [10n ** 18n],
    },
    blobRef: id(blob),
    wrappedDekRef: id(wrappedDek),
  };
  const passportId = b32(0x99);
  const posted: { path: string; size: number }[] = [];
  const fetch: typeof globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const path = url.replace("http://gw", "");
    if (init?.method === "POST") {
      posted.push({ path, size: (init.body as ArrayBuffer | string).toString().length });
      if (path === "/v1/blobs")
        return new Response(JSON.stringify({ id: "0x", size: 1 }), { status: 201 });
      if (path === "/v1/passports") {
        return options.ciphertextTamper
          ? new Response(
              JSON.stringify({ code: "FH_MERKLE_INVALID", detail: "batch root is not anchored" }),
              {
                status: 422,
              },
            )
          : new Response(JSON.stringify({ passportId }), { status: 201 });
      }
      if (path.endsWith("/wrap"))
        return new Response(JSON.stringify({ wrapRef: id(wrap) }), { status: 201 });
      return new Response("nope", { status: 404 });
    }
    if (path.startsWith(`/v1/principals/${PRINCIPAL}/passports`)) {
      return new Response(JSON.stringify({ passports: [{ passportId }] }));
    }
    if (path === `/v1/passports/${passportId}`)
      return new Response(JSON.stringify(sidecarToWire(sidecar)));
    if (path === `/v1/blobs/${sidecar.blobRef}`) {
      return new Response(options.ciphertextTamper ? new Uint8Array([1, 2, 3]) : blob);
    }
    if (path === `/v1/blobs/${sidecar.wrappedDekRef}`) return new Response(wrappedDek);
    if (path === `/v1/grants/${GRANT}/wrap`) return new Response(wrap);
    if (path === `/v1/grants/${b32(0x78)}/wrap`) return new Response("", { status: 404 });
    return new Response("", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, posted, sidecar, blob, wrappedDek, wrap };
}

describe("locker bundle — exit, README §4/§12/§13", () => {
  it("exports the gateway's public objects, checks every hash, reports progress, and serialises without bigints", async () => {
    const gw = fakeGateway();
    const progress: number[] = [];
    const bundle = await exportLocker({
      gatewayUrl: "http://gw/",
      principalId: PRINCIPAL,
      chainId: 10143n,
      grantIds: [GRANT, b32(0x78)],
      fetch: gw.fetch,
      now: () => 42n,
      onProgress: (done) => progress.push(done),
    });
    expect(bundle).toMatchObject({
      v: 1,
      chainId: "10143",
      principalId: PRINCIPAL,
      exportedAt: "42",
      gateway: "http://gw",
    });
    expect(bundle.passports).toHaveLength(1);
    expect(fromBase64(bundle.passports[0]?.blob ?? "")).toEqual(gw.blob);
    expect(fromBase64(bundle.passports[0]?.wrappedDek ?? "")).toEqual(gw.wrappedDek);
    // A wrap the gateway does not hold is simply absent, not an error.
    expect(bundle.wraps).toEqual([{ grantId: GRANT, wrap: toBase64(gw.wrap) }]);
    expect(progress).toEqual([1, 2, 3]);

    const file = serialiseBundle(bundle);
    expect(file).not.toMatch(/\d+n/);
    const back = parseBundle(file);
    expect(back.passports[0]?.sidecar).toEqual(gw.sidecar);
    // Parsed JSON and the in-memory form parse to the same thing.
    expect(parseBundle(JSON.parse(file))).toEqual(back);
    expect(parseBundle(back)).toEqual(back);
  });

  it("refuses to export ciphertext that does not hash to its sidecar's references", async () => {
    const gw = fakeGateway({ ciphertextTamper: true });
    await expect(
      exportLocker({
        gatewayUrl: "http://gw",
        principalId: PRINCIPAL,
        chainId: 1n,
        fetch: gw.fetch,
      }),
    ).rejects.toThrow(/does not hash/);
  });

  it("imports through verified ingest, and reports what the gateway refused rather than forcing it", async () => {
    const source = fakeGateway();
    const bundle = await exportLocker({
      gatewayUrl: "http://gw",
      principalId: PRINCIPAL,
      chainId: 1n,
      grantIds: [GRANT],
      fetch: source.fetch,
    });
    const target = fakeGateway();
    const report = await importLocker({ gatewayUrl: "http://gw", bundle, fetch: target.fetch });
    expect(report).toEqual({ passports: 1, blobs: 2, wraps: 1, skipped: [] });
    expect(target.posted.map((p) => p.path)).toEqual([
      "/v1/blobs",
      "/v1/blobs",
      "/v1/passports",
      `/v1/grants/${GRANT}/wrap`,
    ]);

    // The gateway says no (an unanchored root on its chain view): skipped with its reason.
    const refusing = fakeGateway({ ciphertextTamper: true });
    const refused = await importLocker({ gatewayUrl: "http://gw", bundle, fetch: refusing.fetch });
    expect(refused.passports).toBe(0);
    expect(refused.skipped[0]?.reason).toMatch(/not anchored/);

    // Ciphertext altered in the file: refused here, before any request is made.
    const altered = {
      ...bundle,
      passports: bundle.passports.map((p) => ({ ...p, blob: toBase64(new Uint8Array([9])) })),
    };
    const local = fakeGateway();
    const bad = await importLocker({
      gatewayUrl: "http://gw",
      bundle: altered,
      fetch: local.fetch,
    });
    expect(bad.skipped[0]?.reason).toMatch(/does not hash/);
    expect(local.posted.filter((p) => p.path !== `/v1/grants/${GRANT}/wrap`)).toEqual([]);
  });

  it("base64 round-trips large binaries without Buffer", () => {
    // Filled with a loop rather than `.map`: identical bytes, but 70 000 fewer instrumented
    // closure calls, which is the difference between this finishing inside the default timeout
    // under `--coverage` and not. Raising the timeout instead would hide a real regression here.
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    expect(fromBase64(toBase64(big))).toEqual(big);
  });
});
