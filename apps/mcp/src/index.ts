import {
  FsBlobStore,
  MemoryAnchorWriter,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters";
import { type Address, ConfigError, hexToBytes } from "@firsthand/core";
import { StaticPrfSource } from "@firsthand/crypto";
import { createLogger } from "@firsthand/runtime";
import { FirsthandClient, type LockerSession } from "@firsthand/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

const config = loadConfig();
// stdout is the MCP channel; logs must go to stderr.
const logger = createLogger({
  level: config.LOG_LEVEL,
  sink: (_l, line) => process.stderr.write(`${line}\n`),
});

const client = new FirsthandClient({
  domain: {
    chainId: config.CHAIN_ID,
    verifyingContract: config.PASSPORT_ANCHORS.toLowerCase() as Address,
  },
  epochs: { genesis: config.EPOCH_GENESIS, length: config.EPOCH_LENGTH },
  // Phase 2/4 swap these for OnchainAnchorWriter / BtxTransport built from the deployment file.
  anchors: new MemoryAnchorWriter(),
  blobs: new FsBlobStore(config.BLOB_DIR),
  transport: new MemoryTransport(),
  facilitator: new MemoryFacilitator(),
  addresses: {
    grantManager: config.GRANT_MANAGER.toLowerCase() as Address,
    rescissions: config.RESCISSIONS.toLowerCase() as Address,
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

const server = createMcpServer({ session: openSession, logger });
await server.connect(new StdioServerTransport());
logger.info("firsthand-mcp ready on stdio");
