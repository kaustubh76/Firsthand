import {
  anvil,
  BtxTransport,
  createChainClients,
  FsBlobStore,
  MemoryAnchorWriter,
  MemoryFacilitator,
  MemoryTransport,
  monadTestnet,
  PublicMempoolTransport,
  type TxTransport,
} from "@firsthand/adapters";
import { type Address, ConfigError, hexToBytes } from "@firsthand/core";
import { StaticPrfSource } from "@firsthand/crypto";
import { createLogger } from "@firsthand/runtime";
import { BuyerSession, createBuyerKeys, FirsthandClient, type LockerSession } from "@firsthand/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

const config = loadConfig();
// stdout is the MCP channel; logs must go to stderr.
const logger = createLogger({
  level: config.LOG_LEVEL,
  sink: (_l, line) => process.stderr.write(`${line}\n`),
});

// With a relayer key the verbs broadcast for real; without one, tools return signed calldata.
const relayerClients =
  config.RPC_URL && config.RELAYER_PRIVATE_KEY
    ? createChainClients({
        rpcUrl: config.RPC_URL,
        chain: config.CHAIN_ID === 31337n ? anvil : monadTestnet,
        privateKey: config.RELAYER_PRIVATE_KEY as `0x${string}`,
      })
    : null;
// BTX when an endpoint is configured (probe-gated — a direct btx plan never degrades to the public
// mempool, ADR-0012), else the public mempool, else the memory double (calldata only).
const transport: TxTransport = relayerClients?.walletClient
  ? config.BTX_RPC_URL
    ? new BtxTransport({
        rpcUrl: config.BTX_RPC_URL,
        wallet: relayerClients.walletClient,
        method: config.BTX_METHOD,
      })
    : new PublicMempoolTransport(relayerClients.walletClient)
  : new MemoryTransport();
if (transport.kind === "btx") {
  const caps = await transport.capabilities();
  logger.info("btx transport", { encryptedMempool: caps.encryptedMempool, detail: caps.detail });
}

const client = new FirsthandClient({
  domain: {
    chainId: config.CHAIN_ID,
    verifyingContract: config.PASSPORT_ANCHORS.toLowerCase() as Address,
  },
  epochs: { genesis: config.EPOCH_GENESIS, length: config.EPOCH_LENGTH },
  // Phase 2/4 swap these for OnchainAnchorWriter / BtxTransport built from the deployment file.
  anchors: new MemoryAnchorWriter(),
  blobs: new FsBlobStore(config.BLOB_DIR),
  transport,
  facilitator: new MemoryFacilitator(),
  addresses: {
    grantManager: config.GRANT_MANAGER.toLowerCase() as Address,
    rescissions: config.RESCISSIONS.toLowerCase() as Address,
    principalRegistry: config.PRINCIPAL_REGISTRY.toLowerCase() as Address,
  },
  logger,
});

let session: Promise<LockerSession> | null = null;
const openSession = () => {
  if (session === null) {
    if (!config.FIRSTHAND_STATIC_PRF_HEX) {
      throw new ConfigError(
        "FIRSTHAND_STATIC_PRF_HEX is required for PRF_SOURCE=static (demo/dev only)",
      );
    }
    session = client.open(
      new StaticPrfSource(hexToBytes(config.FIRSTHAND_STATIC_PRF_HEX as `0x${string}`), {
        unsafeAcknowledged: true,
        warn: (m) => logger.warn(m),
      }),
    );
  }
  return session;
};

let buyer: Promise<BuyerSession> | null = null;
const openBuyer = () => {
  if (buyer === null) {
    if (!config.BUYER_PRIVATE_KEY || !config.GRANTEE_SEED_HEX) {
      throw new ConfigError("BUYER_PRIVATE_KEY and GRANTEE_SEED_HEX are required for buyer tools");
    }
    const account = privateKeyToAccount(config.BUYER_PRIVATE_KEY as `0x${string}`);
    buyer = Promise.resolve(
      new BuyerSession({
        keys: createBuyerKeys(
          hexToBytes(config.BUYER_PRIVATE_KEY as `0x${string}`),
          account,
          hexToBytes(config.GRANTEE_SEED_HEX as `0x${string}`),
        ),
        grantManager: config.GRANT_MANAGER.toLowerCase() as Address,
        chainId: config.CHAIN_ID,
        transport,
      }),
    );
  }
  return buyer;
};

const server = createMcpServer({
  session: openSession,
  logger,
  canBroadcast: transport.kind !== "memory",
  buyer: openBuyer,
  passportDomain: {
    chainId: config.CHAIN_ID,
    verifyingContract: config.PASSPORT_ANCHORS.toLowerCase() as Address,
  },
});
await server.connect(new StdioServerTransport());
logger.info("firsthand-mcp ready on stdio");
