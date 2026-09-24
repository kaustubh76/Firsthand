import {
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters";
import type { Address } from "@firsthand/core";
import { encodeDelegation, issueDelegation, KeyTree, StaticPrfSource } from "@firsthand/crypto";
import { noopLogger } from "@firsthand/runtime";
import { FirsthandClient } from "@firsthand/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

async function connect(
  canBroadcast = true,
  delegation?: string,
  extra: { gatewayUrl?: string; agentId?: bigint } = {},
) {
  StaticPrfSource.resetWarning();
  const fh = new FirsthandClient({
    domain: { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` as Address },
    epochs: { genesis: 0n, length: 604_800n },
    anchors: new MemoryAnchorWriter(),
    blobs: new MemoryBlobStore(),
    transport: new MemoryTransport(),
    facilitator: new MemoryFacilitator(),
    addresses: {
      grantManager: `0x${"b1".repeat(20)}` as Address,
      rescissions: `0x${"b2".repeat(20)}` as Address,
      principalRegistry: `0x${"b3".repeat(20)}` as Address,
    },
    namespaces: [{ ns: 0, label: "notes" }],
  });
  let session: ReturnType<FirsthandClient["open"]> | null = null;
  const server = createMcpServer({
    session: () =>
      (session ??= delegation
        ? Promise.resolve(fh.openDelegated(delegation))
        : fh.open(
            new StaticPrfSource(new Uint8Array(32).fill(5), {
              unsafeAcknowledged: true,
              warn: () => {},
            }),
          )),
    logger: noopLogger,
    canBroadcast,
    canAnchor: false, // memory anchors: deposits stay local, the tool says so in its warning
    passportDomain: { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` as Address },
    ...extra,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const textOf = (r: { content: unknown }) =>
  JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");

describe("firsthand-mcp", () => {
  it("lists the verbs, enroll/attest and status", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "firsthand_accept_terms",
      "firsthand_agent_reputation",
      "firsthand_attest",
      "firsthand_deposit",
      "firsthand_enroll",
      "firsthand_export_locker",
      "firsthand_export_manifest",
      "firsthand_grant",
      "firsthand_import",
      "firsthand_import_locker",
      "firsthand_list_passports",
      "firsthand_query",
      "firsthand_register_agent",
      "firsthand_register_card",
      "firsthand_request_access",
      "firsthand_rescind",
      "firsthand_status",
    ]);
  });

  it("request_access and export_manifest say plainly what they need", async () => {
    const client = await connect();
    const request = await client.callTool({
      name: "firsthand_request_access",
      arguments: { passportId: `0x${"11".repeat(32)}` },
    });
    expect(request.isError).toBe(true);
    expect(textOf(request as { content: unknown }).message).toMatch(/no buyer keys/);
    const agent = await client.callTool({
      name: "firsthand_register_agent",
      arguments: { name: "Test buyer" },
    });
    expect(agent.isError).toBe(true);
    expect(textOf(agent as { content: unknown }).message).toMatch(/no buyer keys/);
    const listing = await client.callTool({
      name: "firsthand_list_passports",
      arguments: { principalId: `0x${"11".repeat(32)}` },
    });
    expect(listing.isError).toBe(true);
    expect(textOf(listing as { content: unknown }).message).toMatch(/GATEWAY_URL/);
    const manifest = await client.callTool({
      name: "firsthand_export_manifest",
      arguments: {
        gatewayUrl: "http://gw.test",
        grantId: `0x${"22".repeat(32)}`,
        passportIds: [`0x${"11".repeat(32)}`],
      },
    });
    expect(manifest.isError).toBe(true);
    expect(textOf(manifest as { content: unknown }).message).toMatch(/no buyer keys/);
  });

  it("deposits, reports status, refuses bad namespaces, and posts a rescission commitment", async () => {
    const client = await connect();
    const deposited = await client.callTool({
      name: "firsthand_deposit",
      arguments: { ns: 0, text: "hello", payee: `0x${"cc".repeat(20)}` },
    });
    const body = textOf(deposited as { content: unknown });
    expect(body.passportId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.anchored).toBeNull();
    // Honest about the dead end: without a deployment a deposit can never be recalled by a buyer.
    expect(body.published).toBeNull();
    expect(body.warning).toMatch(/cannot be recalled/);

    const status = textOf(
      (await client.callTool({ name: "firsthand_status", arguments: {} })) as { content: unknown },
    );
    expect(status.pending).toBe(1);
    expect(status.locker.principalId).toMatch(/^0x/);

    const refused = await client.callTool({
      name: "firsthand_deposit",
      arguments: {
        ns: 3,
        text: "x",
        payee: `0x${"cc".repeat(20)}`,
        attestationClass: "import",
        sourceTag: "chatgpt-export-v1",
      },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as { content: unknown }).error).toBe("FH_VALIDATION");

    const rescinded = textOf(
      (await client.callTool({
        name: "firsthand_rescind",
        arguments: { grantId: `0x${"dd".repeat(32)}`, path: "commit-reveal" },
      })) as { content: unknown },
    );
    expect(rescinded.path).toBe("commit-reveal");
    expect(rescinded.commitment).toMatch(/^0x/);
    const direct = textOf(
      (await client.callTool({
        name: "firsthand_rescind",
        arguments: { grantId: `0x${"dd".repeat(32)}` },
      })) as {
        content: unknown;
      },
    );
    expect(direct.path).toBe("btx");
    expect(direct.txHash).toMatch(/^0x/);
    const reveal = textOf(
      (await client.callTool({
        name: "firsthand_rescind",
        arguments: { grantId: `0x${"dd".repeat(32)}`, path: "commit-reveal", salt: rescinded.salt },
      })) as { content: unknown },
    );
    expect(reveal.commitment).toBe(rescinded.commitment);
    const granted = textOf(
      (await client.callTool({
        name: "firsthand_grant",
        arguments: {
          granteeCard: `0x${"ca".repeat(32)}`,
          granteeEncryptionPubKey: `0x${"25".repeat(32)}`,
          ns: 0,
          termsHash: `0x${"7e".repeat(32)}`,
        },
      })) as { content: unknown },
    );
    expect(granted.broadcast).toBe(true);
    expect(granted.grantId).toMatch(/^0x/);
    expect(granted.wrapRef).toMatch(/^0x/);
    const query = await client.callTool({
      name: "firsthand_query",
      arguments: {
        gatewayUrl: "http://gw",
        grantId: `0x${"dd".repeat(32)}`,
        passportId: `0x${"ee".repeat(32)}`,
      },
    });
    expect(query.isError).toBe(true); // no buyer keys configured in this session
  });
});

describe("firsthand_import", () => {
  it("mints one passport per conversation and keeps going when one is refused", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fh-import-"));
    const file = join(dir, "conversations.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "c1",
          title: "first",
          create_time: 1_700_000_000,
          current_node: "a",
          mapping: {
            a: {
              id: "a",
              parent: null,
              message: {
                author: { role: "user" },
                create_time: 1,
                content: { parts: ["hello"] },
              },
            },
          },
        },
        {
          id: "c2",
          title: "second",
          create_time: 1_700_000_100,
          current_node: "b",
          mapping: {
            b: {
              id: "b",
              parent: null,
              message: {
                author: { role: "user" },
                create_time: 2,
                content: { parts: ["world"] },
              },
            },
          },
        },
      ]),
    );
    const client = await connect();
    const out = textOf(
      (await client.callTool({
        name: "firsthand_import",
        arguments: { source: "chatgpt", path: file, payee: `0x${"cc".repeat(20)}` },
      })) as { content: unknown },
    );
    expect(out.minted).toBe(2);
    expect(out.passports[0].passportId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.passports.map((p: { title: string }) => p.title)).toEqual(["first", "second"]);
    // No deployment configured in this test, so it says the import is not anchored.
    expect(out.warning).toMatch(/not anchored/);
  });
});

describe("enroll / attest tools", () => {
  it("broadcast through the transport when a relayer is configured", async () => {
    const client = await connect(true);
    const enrolled = textOf(
      (await client.callTool({ name: "firsthand_enroll", arguments: {} })) as { content: unknown },
    );
    expect(enrolled.broadcast).toBe(true);
    expect(enrolled.principalId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(enrolled.txHash).toMatch(/^0x/);
    const attested = textOf(
      (await client.callTool({ name: "firsthand_attest", arguments: { epoch: "3" } })) as {
        content: unknown;
      },
    );
    expect(attested.broadcast).toBe(true);
    expect(attested.epoch).toBe("3");
    expect(attested.depositKeysRoot).toMatch(/^0x/);
  });

  it("return signed calldata for out-of-band submission without a relayer", async () => {
    const client = await connect(false);
    const plan = textOf(
      (await client.callTool({ name: "firsthand_enroll", arguments: { epoch: "7" } })) as {
        content: unknown;
      },
    );
    expect(plan.broadcast).toBe(false);
    expect(plan.tx.to).toBe(`0x${"b3".repeat(20)}`);
    expect(plan.tx.data.startsWith("0x")).toBe(true);
    const attest = textOf(
      (await client.callTool({ name: "firsthand_attest", arguments: {} })) as { content: unknown },
    );
    expect(attest.broadcast).toBe(false);
    expect(attest.tx.to).toBe(`0x${"b3".repeat(20)}`);
    const bad = await client.callTool({ name: "firsthand_enroll", arguments: { epoch: "x" } });
    expect(bad.isError).toBe(true);
    // Explicit public path without a relayer: calldata for out-of-band submission, path preserved.
    const pub = textOf(
      (await client.callTool({
        name: "firsthand_rescind",
        arguments: { grantId: `0x${"dd".repeat(32)}`, path: "public" },
      })) as { content: unknown },
    );
    expect(pub).toMatchObject({
      broadcast: false,
      path: "public",
      tx: { to: `0x${"b1".repeat(20)}` },
    });
  });
});

describe("a session on a deposit delegation (the MCP↔PWA handoff)", () => {
  it("deposits into the human's locker under their principal, and refuses what needs the passkey", async () => {
    // What the app issues: the passkey's tree, one namespace, this epoch.
    const tree = KeyTree.fromPrf(new Uint8Array(32).fill(5));
    const epoch = BigInt(Math.floor(Date.now() / 1000)) / 604_800n;
    const code = encodeDelegation(
      issueDelegation(tree, {
        ns: 0,
        epoch,
        chainId: 10143n,
        expiresAt: (epoch + 1n) * 604_800n,
      }),
    );
    const client = await connect(true, code);
    const status = textOf(
      (await client.callTool({ name: "firsthand_status", arguments: {} })) as { content: unknown },
    );
    expect(status.locker.principalId).toBe(tree.authorityKey().commitment);
    expect(status.session).toMatchObject({ kind: "delegated", ns: 0, epoch: epoch.toString() });
    expect(status.session.scope).toMatch(/namespace 0/);

    const deposited = textOf(
      (await client.callTool({
        name: "firsthand_deposit",
        arguments: { ns: 0, text: "from the laptop", payee: `0x${"cc".repeat(20)}` },
      })) as { content: unknown },
    );
    expect(deposited.passportId).toMatch(/^0x[0-9a-f]{64}$/);

    for (const name of ["firsthand_enroll", "firsthand_attest"] as const) {
      const refused = await client.callTool({ name, arguments: {} });
      expect(refused.isError).toBe(true);
      expect(textOf(refused as { content: unknown })).toMatchObject({
        error: "FH_DELEGATION_SCOPE",
        message: expect.stringMatching(/open the app/),
      });
    }
    const rescind = await client.callTool({
      name: "firsthand_rescind",
      arguments: { grantId: `0x${"dd".repeat(32)}`, path: "public" },
    });
    expect(rescind.isError).toBe(true);
    expect(textOf(rescind as { content: unknown }).error).toBe("FH_DELEGATION_SCOPE");
  });
});

describe("config", () => {
  it("parses the BTX endpoint and method, defaulting the method name", () => {
    const c = loadConfig({ BTX_RPC_URL: "http://btx.local:8545" });
    expect(c.BTX_RPC_URL).toBe("http://btx.local:8545");
    expect(c.BTX_METHOD).toBe("eth_sendEncryptedRawTransaction");
    expect(loadConfig({ BTX_METHOD: "monad_sendSealedTransaction" }).BTX_METHOD).toBe(
      "monad_sendSealedTransaction",
    );
    expect(() => loadConfig({ BTX_RPC_URL: "not a url" })).toThrow();
  });
});

describe("the buyer-side and portability tools say what they need", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Mcp = Awaited<ReturnType<typeof connect>>;
  const call = async (client: Mcp, name: string, args: Record<string, unknown> = {}) =>
    textOf((await client.callTool({ name, arguments: args })) as { content: unknown });

  // Five of the seventeen tools had no test at all: the exit pair and the buyer-onboarding pair,
  // which are two of the features the last passes were about, plus the reputation read. An operator
  // meets these first as refusals when a key or URL is missing, so the refusal is the contract — it
  // has to name the variable to set, not merely fail.
  it("export_locker and import_locker need a gateway, and name it", async () => {
    const client = await connect();
    for (const name of ["firsthand_export_locker", "firsthand_import_locker"]) {
      const r = await call(client, name, { path: "/tmp/does-not-matter.json" });
      expect(r.error, name).toBe("FH_INTERNAL");
      expect(r.message, name).toContain("GATEWAY_URL");
    }
  });

  it("register_card and accept_terms need buyer keys, and name both", async () => {
    const client = await connect();
    const card = await call(client, "firsthand_register_card");
    expect(card.message).toContain("BUYER_PRIVATE_KEY");
    expect(card.message).toContain("GRANTEE_SEED_HEX");
    const terms = await call(client, "firsthand_accept_terms", {
      principalId: `0x${"33".repeat(32)}`,
      ns: 0,
      priceUnits: "1000",
      payee: `0x${"44".repeat(20)}`,
    });
    expect(terms.message).toContain("BUYER_PRIVATE_KEY");
  });

  it("agent_reputation needs a gateway first, then an agent id", async () => {
    const bare = await connect();
    expect((await call(bare, "firsthand_agent_reputation")).message).toContain("GATEWAY_URL");

    const withGateway = await connect(true, undefined, { gatewayUrl: "http://gw" });
    expect((await call(withGateway, "firsthand_agent_reputation")).message).toContain(
      "BUYER_AGENT_ID",
    );
  });

  it("agent_reputation reads the gateway, and reports a refusal as one", async () => {
    const client = await connect(true, undefined, { gatewayUrl: "http://gw", agentId: 1925n });
    // BUYER_AGENT_ID is used when the caller names no agent…
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("http://gw/v1/agents/1925");
      return new Response(
        JSON.stringify({ agentId: "1925", reputation: { paidQueriesHere: "2" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    expect((await call(client, "firsthand_agent_reputation")).reputation.paidQueriesHere).toBe("2");

    // …and an explicit agentId overrides it; a gateway that refuses is reported, not swallowed.
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("http://gw/v1/agents/7");
      return new Response("nope", { status: 404 });
    });
    expect((await call(client, "firsthand_agent_reputation", { agentId: "7" })).message).toContain(
      "404",
    );
  });
});
