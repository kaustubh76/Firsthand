import {
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters";
import type { Address } from "@firsthand/core";
import { StaticPrfSource } from "@firsthand/crypto";
import { noopLogger } from "@firsthand/runtime";
import { FirsthandClient } from "@firsthand/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";

async function connect(canBroadcast = true) {
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
      (session ??= fh.open(
        new StaticPrfSource(new Uint8Array(32).fill(5), {
          unsafeAcknowledged: true,
          warn: () => {},
        }),
      )),
    logger: noopLogger,
    canBroadcast,
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
      "firsthand_attest",
      "firsthand_deposit",
      "firsthand_enroll",
      "firsthand_query",
      "firsthand_rescind",
      "firsthand_status",
    ]);
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
    const direct = await client.callTool({
      name: "firsthand_rescind",
      arguments: { grantId: `0x${"dd".repeat(32)}` },
    });
    expect(direct.isError).toBe(true);
    const query = await client.callTool({
      name: "firsthand_query",
      arguments: {
        gatewayUrl: "http://gw",
        grantId: `0x${"dd".repeat(32)}`,
        passportId: `0x${"ee".repeat(32)}`,
      },
    });
    expect(query.isError).toBe(true);
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
  });
});
