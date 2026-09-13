import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  type Bytes32,
  ChainError,
  NotImplementedError,
  PaymentError,
  TransportError,
  ValidationError,
} from "@firsthand/core";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "./blobs/FsBlobStore.js";
import { IpfsBlobStore } from "./blobs/IpfsBlobStore.js";
import { anvil, createChainClients, monadTestnet } from "./chain.js";
import { OnchainErc8004Registry } from "./erc8004/OnchainErc8004Registry.js";
import { EnvioConsentLedger } from "./ledger/EnvioConsentLedger.js";
import {
  blobId,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryConsentLedger,
  MemoryErc8004Registry,
  MemoryFacilitator,
  MemoryTransport,
} from "./memory/index.js";
import type { AnchorRequest } from "./ports/AnchorWriter.js";
import type { BlobStore } from "./ports/BlobStore.js";
import {
  decodePaymentHeader,
  encodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
} from "./ports/X402Facilitator.js";
import { BtxTransport } from "./tx/BtxTransport.js";
import { MonadFacilitatorClient } from "./x402/MonadFacilitatorClient.js";

const b32 = (n: number): Bytes32 => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

/** Every BlobStore implementation must satisfy this contract. */
function describeBlobStoreConformance(name: string, make: () => BlobStore) {
  describe(`BlobStore conformance: ${name}`, () => {
    it("is content-addressed, idempotent and returns null for unknown refs", async () => {
      const store = make();
      const bytes = new TextEncoder().encode("sealed envelope bytes");
      const ref = await store.put(bytes);
      expect(ref.id).toBe(blobId(bytes));
      expect(ref.size).toBe(bytes.length);
      expect((await store.put(bytes)).id).toBe(ref.id);
      expect(await store.has(ref)).toBe(true);
      expect(await store.has(ref.id)).toBe(true);
      expect(await store.get(ref)).toEqual(bytes);
      expect(await store.get(b32(1))).toBeNull();
      expect(await store.has(b32(1))).toBe(false);
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), "firsthand-blobs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
describeBlobStoreConformance("memory", () => new MemoryBlobStore());
describeBlobStoreConformance("fs", () => new FsBlobStore(tmp));

describe("FsBlobStore", () => {
  it("rejects malformed ids and detects tampered files", async () => {
    const store = new FsBlobStore(tmp);
    await expect(store.get("0x12")).rejects.toThrow(ValidationError);
    const ref = await store.put(new Uint8Array([1, 2, 3]));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(ref.locator as string, new Uint8Array([9]));
    await expect(store.get(ref)).rejects.toThrow(/integrity/);
  });
});

describe("Recorder doubles", () => {
  it("record calls and inject one-shot failures", async () => {
    const t = new MemoryTransport({ now: () => 5 });
    const ref = await t.send({ to: addr(1), data: "0x" });
    expect(ref).toMatchObject({ transport: "memory", submittedAt: 5 });
    expect(t.callsTo("send")).toHaveLength(1);
    t.failNext(new TransportError("FH_TRANSPORT", "boom"));
    await expect(t.send({ to: addr(1), data: "0x" })).rejects.toThrow("boom");
    await expect(t.send({ to: addr(1), data: "0x" })).resolves.toBeDefined();
    expect((await t.capabilities()).encryptedMempool).toBe(false);
    expect(
      (await new MemoryTransport({ encryptedMempool: true }).capabilities()).encryptedMempool,
    ).toBe(true);
    t.reset();
    expect(t.calls).toHaveLength(0);
  });
});

describe("MemoryAnchorWriter", () => {
  const req = (root: number, ns = 0): AnchorRequest => ({
    principalId: b32(1),
    ns,
    epoch: 3n,
    batchRoot: b32(root),
    termsHash: b32(9),
    nonce: b32(root + 100),
    depositKeys: new Array<Address>(16).fill(addr(7)),
    depositSig: `0x${"00".repeat(65)}`,
  });
  it("is append-only with sequential batch indices per (principal, ns, epoch)", async () => {
    const w = new MemoryAnchorWriter();
    const a = await w.anchor(req(10));
    const b = await w.anchor(req(11));
    const c = await w.anchor(req(12, 1));
    expect([a.batchIndex, b.batchIndex, c.batchIndex]).toEqual([0, 1, 0]);
    expect(await w.isAnchored(b32(10))).toBe(true);
    expect(await w.anchorBlock(b32(10))).toBe(1n);
    expect(await w.anchorBlock(b32(99))).toBeNull();
    await expect(w.anchor(req(10))).rejects.toThrow(ChainError);
    w.mineBlocks(5);
    expect(w.head).toBe(8n);
    expect(w.anchored()).toHaveLength(3);
    expect(w.layout).toBe("memory");
  });
});

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "monad-testnet",
  maxAmountRequired: "1000",
  resource: "https://gw.example/v1/query",
  description: "one query",
  mimeType: "application/json",
  payTo: addr(0xaa),
  maxTimeoutSeconds: 60,
  asset: addr(0xdc),
};
const payload = (
  nonce: number,
  overrides: Partial<PaymentPayload["payload"]["authorization"]> = {},
): PaymentPayload => ({
  x402Version: 1,
  scheme: "exact",
  network: "monad-testnet",
  payload: {
    signature: `0x${"11".repeat(65)}`,
    authorization: {
      from: addr(0xbb),
      to: addr(0xaa),
      value: "1000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: b32(nonce),
      ...overrides,
    },
  },
});

describe("MemoryFacilitator", () => {
  it("verifies scheme, payee, amount and nonce freshness; settles once", async () => {
    const f = new MemoryFacilitator();
    expect(await f.supported()).toEqual([{ scheme: "exact", network: "monad-testnet" }]);
    expect(await f.verify(payload(1), requirements)).toEqual({ isValid: true, payer: addr(0xbb) });
    expect((await f.verify(payload(1, { to: addr(0xcc) }), requirements)).invalidReason).toBe(
      "wrong_pay_to",
    );
    expect((await f.verify(payload(1, { value: "999" }), requirements)).invalidReason).toBe(
      "wrong_amount",
    );
    expect((await f.verify({ ...payload(1), network: "other" }, requirements)).invalidReason).toBe(
      "unsupported_scheme_or_network",
    );
    const settled = await f.settle(payload(1), requirements);
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await f.verify(payload(1), requirements)).invalidReason).toBe("nonce_already_used");
    expect((await f.settle(payload(1), requirements)).success).toBe(false);
    expect(f.settlements).toHaveLength(2);
  });
});

describe("x402 header codec", () => {
  it("round-trips and rejects garbage", () => {
    const header = encodePaymentHeader(payload(2));
    expect(decodePaymentHeader(header)).toEqual(payload(2));
    expect(decodePaymentHeader(null)).toBeNull();
    expect(decodePaymentHeader("not base64 json")).toBeNull();
    expect(decodePaymentHeader(Buffer.from("{}").toString("base64"))).toBeNull();
  });
});

describe("MemoryErc8004Registry / MemoryConsentLedger", () => {
  it("resolve cards and filter ledger views", async () => {
    const reg = new MemoryErc8004Registry();
    const card = { cardId: b32(5), owner: addr(5), encryptionPubKey: b32(6), active: true };
    reg.register(card);
    expect(await reg.resolveCard(b32(5))).toEqual(card);
    reg.deactivate(b32(5));
    expect((await reg.resolveCard(b32(5)))?.active).toBe(false);
    reg.deactivate(b32(42));
    expect(await reg.resolveCard(b32(42))).toBeNull();

    const ledger = new MemoryConsentLedger();
    const receipt = {
      receiptId: b32(1),
      grantId: b32(2),
      payer: addr(3),
      ns: 0,
      termsHash: b32(4),
      epoch: 1n,
      blockNumber: 10n,
      txHash: b32(5),
    };
    ledger.addReceipt(receipt);
    ledger.addReceipt({ ...receipt, receiptId: b32(9), grantId: b32(3) });
    ledger.addAnchor(b32(7), {
      batchRoot: b32(8),
      ns: 0,
      epoch: 1n,
      termsHash: b32(4),
      blockNumber: 3n,
      batchIndex: 0,
    });
    ledger.addAnchor(b32(7), {
      batchRoot: b32(9),
      ns: 1,
      epoch: 1n,
      termsHash: b32(4),
      blockNumber: 4n,
      batchIndex: 0,
    });
    ledger.addEvent({
      kind: "rescinded",
      principalId: b32(7),
      grantId: b32(2),
      blockNumber: 20n,
      timestamp: 2n,
      txHash: null,
    });
    ledger.addEvent({
      kind: "enrolled",
      principalId: b32(7),
      grantId: null,
      blockNumber: 1n,
      timestamp: 1n,
      txHash: b32(1),
    });
    expect(await ledger.receiptsForGrant(b32(2))).toEqual([receipt]);
    expect(await ledger.anchorsFor(b32(7), 1)).toHaveLength(1);
    expect(await ledger.anchorsFor(b32(8), 1)).toHaveLength(0);
    expect((await ledger.consentTimeline(b32(7))).map((e) => e.kind)).toEqual([
      "enrolled",
      "rescinded",
    ]);
  });
});

describe("BtxTransport", () => {
  const rpc = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  it("reports unavailable when the node does not know the method, and refuses to send", async () => {
    const t = new BtxTransport({
      rpcUrl: "http://node",
      fetch: rpc({ error: { code: -32601, message: "method not found" } }),
    });
    expect(t.kind).toBe("btx");
    expect((await t.probe()).encryptedMempool).toBe(false);
    expect((await t.capabilities()).encryptedMempool).toBe(false);
    await expect(t.send({ to: addr(1), data: "0x" })).rejects.toMatchObject({
      code: "FH_BTX_UNAVAILABLE",
    });
  });
  it("reports available when the method exists (send still gated until Phase 4)", async () => {
    const t = new BtxTransport({
      rpcUrl: "http://node",
      fetch: rpc({ error: { code: -32602, message: "invalid params" } }),
    });
    expect((await t.capabilities()).encryptedMempool).toBe(true);
    await expect(t.send({ to: addr(1), data: "0x" })).rejects.toThrow(TransportError);
  });
  it("handles unreachable nodes", async () => {
    const t = new BtxTransport({
      rpcUrl: "http://down",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect((await t.probe()).detail).toContain("ECONNREFUSED");
  });
});

describe("MonadFacilitatorClient", () => {
  const mk = (handler: (path: string, init?: RequestInit) => Response | Promise<Response>) =>
    new MonadFacilitatorClient({
      baseUrl: "https://facilitator/",
      apiKey: "k",
      fetch: (async (url: string | URL | Request, init?: RequestInit) =>
        handler(new URL(String(url)).pathname, init)) as unknown as typeof fetch,
    });
  it("calls /supported, /verify, /settle with JSON bodies and bearer auth", async () => {
    const seen: string[] = [];
    const client = mk((path, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(`${init?.method} ${path} ${headers["authorization"]}`);
      if (path === "/supported")
        return new Response(
          JSON.stringify({ kinds: [{ scheme: "exact", network: "monad-testnet" }] }),
        );
      if (path === "/verify")
        return new Response(JSON.stringify({ isValid: true, payer: addr(1) }));
      return new Response(
        JSON.stringify({ success: true, network: "monad-testnet", transaction: b32(1) }),
      );
    });
    expect(await client.supported()).toHaveLength(1);
    expect((await client.verify(payload(1), requirements)).isValid).toBe(true);
    expect((await client.settle(payload(1), requirements)).transaction).toBe(b32(1));
    expect(seen).toEqual([
      "GET /supported Bearer k",
      "POST /verify Bearer k",
      "POST /settle Bearer k",
    ]);
  });
  it("retries 5xx, does not retry 4xx, surfaces settlement failures as PaymentError", async () => {
    let calls = 0;
    const flaky = mk(() =>
      ++calls < 2 ? new Response("", { status: 503 }) : new Response(JSON.stringify({ kinds: [] })),
    );
    expect(await flaky.supported()).toEqual([]);
    expect(calls).toBe(2);
    const forbidden = mk(() => new Response("", { status: 403 }));
    await expect(forbidden.supported()).rejects.toMatchObject({
      code: "FH_TRANSPORT",
      retryable: false,
    });
    const failing = mk(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            network: "monad-testnet",
            errorReason: "insufficient_funds",
          }),
        ),
    );
    await expect(failing.settle(payload(1), requirements)).rejects.toThrow(PaymentError);
    const down = mk(() => {
      throw new Error("socket hang up");
    });
    await expect(down.supported()).rejects.toMatchObject({ code: "FH_TRANSPORT" });
  });
});

describe("shells and chain wiring", () => {
  it("typed shells throw NotImplemented with context", async () => {
    const clients = createChainClients({ rpcUrl: "http://127.0.0.1:8545", chain: anvil });
    expect(clients.walletClient).toBeNull();
    const signed = createChainClients({
      rpcUrl: "http://127.0.0.1:8545",
      chain: anvil,
      privateKey: `0x${"01".repeat(32)}`,
    });
    expect(signed.account?.address).toMatch(/^0x/);
    expect(monadTestnet.id).toBe(10143);
    const reg = new OnchainErc8004Registry(clients.publicClient, addr(1));
    expect(reg.chainId).toBe(31337);
    expect(reg.address).toBe(addr(1));
    await expect(reg.resolveCard(b32(1))).rejects.toThrow(NotImplementedError);
    const ledger = new EnvioConsentLedger({
      graphqlUrl: "http://envio/graphql",
      fetch: (async () =>
        new Response(JSON.stringify({ data: { ok: 1 } }))) as unknown as typeof fetch,
    });
    expect(ledger.url).toBe("http://envio/graphql");
    await expect(ledger.receiptsForGrant(b32(1))).rejects.toThrow(NotImplementedError);
    await expect(ledger.anchorsFor(b32(1), 0)).rejects.toThrow(NotImplementedError);
    await expect(ledger.consentTimeline(b32(1))).rejects.toThrow(NotImplementedError);
    expect(await ledger.query<{ ok: number }>("{ ok }", {})).toEqual({ ok: 1 });
    const erroring = new EnvioConsentLedger({
      graphqlUrl: "x",
      fetch: (async () =>
        new Response(JSON.stringify({ errors: [{ message: "bad" }] }))) as unknown as typeof fetch,
    });
    await expect(erroring.query("{ x }", {})).rejects.toThrow("bad");
    const ipfs = new IpfsBlobStore({ apiUrl: "http://127.0.0.1:5001" });
    expect(ipfs.apiUrl).toContain("5001");
    await expect(ipfs.put(new Uint8Array())).rejects.toThrow(NotImplementedError);
    await expect(ipfs.get(b32(1))).rejects.toThrow(NotImplementedError);
    await expect(ipfs.has(b32(1))).rejects.toThrow(NotImplementedError);
  });
});
