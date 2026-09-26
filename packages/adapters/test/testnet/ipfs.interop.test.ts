import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { rawKeccakCid } from "../../src/blobs/cid.js";
import { IpfsBlobStore } from "../../src/blobs/IpfsBlobStore.js";

/**
 * `IpfsBlobStore` against a real Kubo node — the only way to know the CID trick holds, because it
 * depends on what the node does with `hash=keccak-256`, not on what we believe about multihashes.
 *
 *   docker run -d --name fh-ipfs -p 5001:5001 ipfs/kubo:latest
 *   IPFS_API_URL=http://127.0.0.1:5001 pnpm --filter @firsthand/adapters test:testnet
 *
 * Kept out of `check:all` for the same reason as the x402 interop suite: no gate in this repo should
 * depend on a service being up. Skips with a printed reason when there is no node.
 */
const API = process.env["IPFS_API_URL"] ?? "http://127.0.0.1:5001";

const reachable = await fetch(`${API}/api/v0/version`, { method: "POST" })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) console.log(`ipfs: no node at ${API} — skipping (docker run … ipfs/kubo)`);

describe.skipIf(!reachable)("IpfsBlobStore against a live Kubo node", () => {
  const store = new IpfsBlobStore({ apiUrl: API });
  const bytes = new TextEncoder().encode(`firsthand ipfs interop ${Date.now()}`);

  it("stores ciphertext under the same keccak id every other backend uses", async () => {
    const ref = await store.put(bytes);
    expect(ref.id).toBe(keccak256(bytes));
    expect(ref.size).toBe(bytes.length);
    // The claim the whole design rests on: the CID is derivable from the id, so nothing is indexed.
    expect(ref.locator).toBe(rawKeccakCid(ref.id));
  });

  it("reads a blob back from the id alone — no CID, no index, no side table", async () => {
    const ref = await store.put(bytes);
    const got = await store.get(ref.id);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got as Uint8Array)).toBe(new TextDecoder().decode(bytes));
    await expect(store.has(ref.id)).resolves.toBe(true);
  });

  it("answers a miss quickly instead of going looking on the DHT", async () => {
    // `cat` would try the network and block; this is why the reads are `block/*` with offline=true.
    const absent = keccak256(new TextEncoder().encode(`never stored ${Date.now()}`));
    const started = Date.now();
    await expect(store.get(absent)).resolves.toBeNull();
    await expect(store.has(absent)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a node that hashes differently, rather than storing something unfindable", async () => {
    // A node without keccak-256 returns a sha2-256 CID; that blob could never be read back by id,
    // so `put` must fail loudly at write time instead of succeeding into a black hole.
    const sha = new IpfsBlobStore({
      apiUrl: API,
      fetch: async (input, init) =>
        fetch(String(input).replace("hash=keccak-256", "hash=sha2-256"), init),
    });
    await expect(sha.put(new TextEncoder().encode("wrong hash"))).rejects.toThrow(/not this blob/);
  });

  it("reports an unreachable node as a retryable transport failure", async () => {
    const dead = new IpfsBlobStore({ apiUrl: "http://127.0.0.1:1", timeoutMs: 2_000 });
    await expect(dead.put(new Uint8Array([1]))).rejects.toMatchObject({ retryable: true });
  });
});
