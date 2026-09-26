import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { base32Lower, rawKeccakCid } from "./cid.js";
import { IpfsBlobStore } from "./IpfsBlobStore.js";

/**
 * The live contract is proved against a real Kubo node in `test/testnet/ipfs.interop.test.ts`.
 * What is checked here is everything that must hold without one: the CID derivation, and the
 * store's refusals — because those are the paths a live test is least likely to reach.
 */
const bytes = new TextEncoder().encode("hello firsthand ipfs");
/** Measured against Kubo 0.43.1 for exactly these bytes — a fixture, not a re-implementation. */
const KUBO_CID = "bafkrwiabcloyee5du32bpjhd2xocwvqs3my2nmouyhvbxxo2egxt5bb6ca";

/** A Kubo stand-in: `add` echoes the CID the real node would return, reads come from a map. */
function fakeKubo(blocks = new Map<string, Uint8Array>()): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const cid = url.searchParams.get("arg") ?? "";
    if (url.pathname.endsWith("/add")) {
      blocks.set(rawKeccakCid(keccak256(bytes)), bytes);
      return new Response(JSON.stringify({ Hash: rawKeccakCid(keccak256(bytes)), Size: "20" }));
    }
    const held = blocks.get(cid);
    if (held === undefined) return new Response("no block", { status: 500 });
    if (url.pathname.endsWith("/block/stat")) return new Response(JSON.stringify({ Key: cid }));
    return new Response(held as unknown as BodyInit);
  }) as typeof fetch;
}

describe("the keccak CID", () => {
  it("is the one Kubo produces for the same bytes", () => {
    expect(rawKeccakCid(keccak256(bytes))).toBe(KUBO_CID);
  });

  it("encodes the multihash prefix a raw keccak-256 block must carry", () => {
    // 0x01 CIDv1 · 0x55 raw · 0x1b keccak-256 · 0x20 length — the reason the id maps to a CID at all.
    const id = `0x${"ab".repeat(32)}` as const;
    const prefix = new Uint8Array([0x01, 0x55, 0x1b, 0x20]);
    expect(rawKeccakCid(id).startsWith(`b${base32Lower(prefix).slice(0, 6)}`)).toBe(true);
  });

  it("refuses anything that is not a 32-byte lower-case id", () => {
    expect(() => rawKeccakCid("0xABCD" as `0x${string}`)).toThrow();
    expect(() => rawKeccakCid(`0x${"AB".repeat(32)}` as `0x${string}`)).toThrow(); // upper case
  });
});

describe("IpfsBlobStore", () => {
  it("round-trips through the id, and reports a miss as null rather than throwing", async () => {
    const store = new IpfsBlobStore({ apiUrl: "http://ipfs.test/", fetch: fakeKubo() });
    const ref = await store.put(bytes);
    expect(ref).toEqual({ id: keccak256(bytes), size: bytes.length, locator: KUBO_CID });
    expect(await store.get(ref.id)).toEqual(bytes);
    expect(await store.has(ref.id)).toBe(true);
    expect(await store.get(`0x${"11".repeat(32)}`)).toBeNull();
    expect(await store.has(`0x${"11".repeat(32)}`)).toBe(false);
  });

  it("refuses a CID that is not the blob's keccak id", async () => {
    // A node built without keccak-256 answers with a sha2-256 CID: that blob could never be read
    // back by id, so writing must fail here rather than succeed into somewhere unreachable.
    const wrong = (async () =>
      new Response(JSON.stringify({ Hash: "bafybeiwrong" }))) as typeof fetch;
    const store = new IpfsBlobStore({ apiUrl: "http://ipfs.test", fetch: wrong });
    await expect(store.put(bytes)).rejects.toThrow(/not this blob's keccak id/);
  });

  it("refuses bytes that do not hash to what was asked for", async () => {
    const tampered = new Map([
      [rawKeccakCid(keccak256(bytes)), new TextEncoder().encode("swapped")],
    ]);
    const store = new IpfsBlobStore({ apiUrl: "http://ipfs.test", fetch: fakeKubo(tampered) });
    await expect(store.get(keccak256(bytes))).rejects.toThrow(/integrity/);
  });

  it("calls an unreachable node a retryable transport failure, not a missing blob", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const store = new IpfsBlobStore({ apiUrl: "http://ipfs.test", fetch: down });
    await expect(store.get(keccak256(bytes))).rejects.toMatchObject({ retryable: true });
  });
});
