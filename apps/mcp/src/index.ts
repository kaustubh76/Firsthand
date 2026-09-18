import {
  anvil,
  BtxTransport,
  createChainClients,
  FsBlobStore,
  HttpRelayTransport,
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
import { loadDotenv } from "@firsthand/runtime/node";
import { BuyerSession, createBuyerKeys, FirsthandClient, type LockerSession } from "@firsthand/sdk";
import {
  assertChain,
  clientOptionsFromDeployment,
  type Deployment,
  loadDeployment,
} from "@firsthand/sdk/deployment";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

// Before config: otherwise every value in .env is silently ignored (the same trap as the gateway).
const envFile = loadDotenv();
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
// A key-less reader when there is an RPC but no relayer: the buyer path (card, terms, query) and
// anchoring can all ride a gateway's relay — an agent needs no MON to take part.
const readerClients =
  relayerClients ??
  (config.RPC_URL
    ? createChainClients({
        rpcUrl: config.RPC_URL,
        chain: config.CHAIN_ID === 31337n ? anvil : monadTestnet,
      })
    : null);
// BTX when an endpoint is configured (probe-gated — a direct btx plan never degrades to the public
// mempool, ADR-0012), else the public mempool, else the gateway's relay, else the memory double
// (calldata only).
const transport: TxTransport = relayerClients?.walletClient
  ? config.BTX_RPC_URL
    ? new BtxTransport({
        rpcUrl: config.BTX_RPC_URL,
        wallet: relayerClients.walletClient,
        method: config.BTX_METHOD,
      })
    : new PublicMempoolTransport(relayerClients.walletClient)
  : config.GATEWAY_URL
    ? new HttpRelayTransport({ baseUrl: config.GATEWAY_URL })
    : new MemoryTransport();
const relayed = transport instanceof HttpRelayTransport;
if (transport.kind === "btx") {
  const caps = await transport.capabilities();
  logger.info("btx transport", { encryptedMempool: caps.encryptedMempool, detail: caps.detail });
}

// A deployment file is what makes deposits *recallable*: without it the anchors adapter is an
// in-process double, nothing reaches the chain, and the gateway refuses the sidecar as unanchored.
const deployment: Deployment | null = config.DEPLOYMENTS_FILE
  ? loadDeployment(config.DEPLOYMENTS_FILE)
  : null;
if (deployment && BigInt(deployment.chainId) !== config.CHAIN_ID) {
  throw new ConfigError(
    `DEPLOYMENTS_FILE is for chain ${deployment.chainId}, CHAIN_ID is ${config.CHAIN_ID}`,
  );
}
if (deployment && readerClients)
  await assertChain(readerClients.publicClient, deployment, "DEPLOYMENTS_FILE");

const blobs = new FsBlobStore(config.BLOB_DIR);
const client = new FirsthandClient(
  deployment && readerClients
    ? clientOptionsFromDeployment({
        deployment,
        publicClient: readerClients.publicClient,
        ...(readerClients.walletClient ? { walletClient: readerClients.walletClient } : {}),
        blobs,
        transport,
        logger,
      })
    : {
        domain: {
          chainId: config.CHAIN_ID,
          verifyingContract: config.PASSPORT_ANCHORS.toLowerCase() as Address,
        },
        epochs: { genesis: config.EPOCH_GENESIS, length: config.EPOCH_LENGTH },
        // No deployment file: keys and calldata still work, but anchoring is a local double.
        anchors: new MemoryAnchorWriter(),
        blobs,
        transport,
        facilitator: new MemoryFacilitator(),
        addresses: {
          grantManager: config.GRANT_MANAGER.toLowerCase() as Address,
          rescissions: config.RESCISSIONS.toLowerCase() as Address,
          principalRegistry: config.PRINCIPAL_REGISTRY.toLowerCase() as Address,
        },
        logger,
      },
);
logger.info("firsthand-mcp", {
  envFile: envFile.path ?? `none (${envFile.reason})`,
  chainId: String(config.CHAIN_ID),
  anchors:
    deployment && readerClients
      ? relayed
        ? "onchain via the gateway relay"
        : "onchain"
      : "memory (deposits stay local)",
  gateway: config.GATEWAY_URL ?? "none",
  transport: transport.kind,
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
        // The deployment file wins over the transcribed env addresses, as it does for the locker.
        grantManager: client.options.addresses.grantManager,
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
  canAnchor: deployment !== null && (relayerClients?.walletClient !== undefined || relayed),
  ...(readerClients
    ? {
        publicClient: readerClients.publicClient as never,
        anchors: client.options.anchors,
        waitForTx: async (hash: `0x${string}`) => {
          await readerClients.publicClient.waitForTransactionReceipt({ hash });
        },
      }
    : {}),
  ...(config.GATEWAY_URL ? { gatewayUrl: config.GATEWAY_URL } : {}),
  buyer: openBuyer,
  passportDomain: client.options.domain,
});
await server.connect(new StdioServerTransport());
logger.info("firsthand-mcp ready on stdio");
