import { handle } from "hono/vercel";
import monadTestnet from "../../../deployments/10143.json" with { type: "json" };
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

/**
 * The hosted gateway: one Vercel function fronting the whole Hono app (`scripts/vercel-bundle.mjs`
 * builds it into a self-contained tree). Public-host defaults are set here rather than in the
 * dashboard so the only manual configuration is the two secrets. Each default yields to an
 * explicit environment variable, and each one that needs a secret degrades visibly — `/healthz`
 * reports `memory` for a store or settlement that could not bind — instead of refusing to boot.
 */
const env = process.env;
const defaults: Record<string, string> = {
  CHAIN_ID: String(monadTestnet.chainId),
  DEPLOYMENT_JSON: JSON.stringify(monadTestnet),
  LOG_JSON: "true",
  // The relay is the point of hosting: keyless browsers cannot anchor without it.
  RELAY_ENABLED: "true",
  // A stranger looping on the relay burns the relayer float, so the public defaults are tight.
  RATE_LIMIT_CAPACITY: "20",
  RATE_LIMIT_REFILL_PER_SECOND: "0.2",
  ...(env["RELAYER_PRIVATE_KEY"] ? { SETTLEMENT_MODE: "onchain" } : {}),
  ...(env["BLOB_READ_WRITE_TOKEN"] ? { BLOB_STORE: "vercel", CATALOG: "vercel" } : {}),
  ...(env["VERCEL_PROJECT_PRODUCTION_URL"]
    ? { PUBLIC_URL: `https://${env["VERCEL_PROJECT_PRODUCTION_URL"]}` }
    : {}),
};
for (const [key, value] of Object.entries(defaults)) env[key] ??= value;

const gateway = createGateway(loadConfig());
const missing = [
  ...(env["RELAYER_PRIVATE_KEY"] ? [] : ["RELAYER_PRIVATE_KEY (relay + on-chain settlement)"]),
  ...(env["BLOB_READ_WRITE_TOKEN"] ? [] : ["BLOB_READ_WRITE_TOKEN (durable blobs + passports)"]),
];
if (missing.length > 0) gateway.logger.warn("hosted gateway is degraded", { missing });

export default handle(gateway.app);
