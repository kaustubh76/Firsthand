import { waitUntil } from "@vercel/functions";
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
  // The relay is the point of hosting: keyless browsers cannot anchor without it. On testnet the
  // USDC is the MockUSDC faucet double, so its `mint` relays too — a demo buyer funds itself.
  RELAY_ENABLED: "true",
  RELAY_FAUCET_MINT: "true",
  // ERC-8004 reference registries are live on Monad testnet: paid queries feed buyer reputation.
  ERC8004_FEEDBACK: "true",
  // Monad's native x402 facilitator verifies every payment (README §8 claim 4, ADR-0014); if it is
  // unreachable or declines the kind of payment, the gateway's own verifier answers instead — it
  // never degrades to accepting an unverified signature.
  X402_MODE: "monad",
  X402_NETWORK: "eip155:10143",
  // A judge's own history: ?fromBlock= may reach back 12 000 blocks (~80 min at 0.4 s) — four
  // event walks of 120 windows each, four in flight at 20 starts/s ≈ 25 s — and the scan stops at
  // its budget with `scan.partial` rather than hitting the function's 60 s; the browser's journal
  // carries what is older.
  LEDGER_MAX_SCAN_BLOCKS: "12000",
  LEDGER_SCAN_BUDGET_MS: "40000",
  // The public RPC enforces a per-second window shared with everything behind the function's
  // egress ("requests limited to 15/sec", 2026-09-20): three walks in flight at ≤ 12 starts/s
  // leave room for the serving path's own reads, and the RPC layer backs off on a 429.
  LEDGER_MIN_REQUEST_INTERVAL_MS: "80",
  LEDGER_MAX_IN_FLIGHT: "3",
  // Vercel rejects request bodies above ~4.5 MB before the function runs (measured: 5 MB → 413);
  // publish a limit the PWA can honour instead of letting a photo fail at the edge.
  MAX_UPLOAD_BYTES: String(4 * 1024 * 1024),
  // Per IP, per function instance. A judging room shares one NAT and runs the ~12-relay script
  // more than once, so the burst is generous; the refill still bounds a stranger looping on the
  // relay (the faucet is capped per call as well, RELAY_FAUCET_MAX_UNITS).
  RATE_LIMIT_CAPACITY: "60",
  RATE_LIMIT_REFILL_PER_SECOND: "0.5",
  ...(env["RELAYER_PRIVATE_KEY"] ? { SETTLEMENT_MODE: "onchain" } : {}),
  ...(env["BLOB_READ_WRITE_TOKEN"] ? { BLOB_STORE: "vercel", CATALOG: "vercel" } : {}),
  CAPTURE_URL: "https://firsthand-capture.vercel.app",
  ...(env["VERCEL_PROJECT_PRODUCTION_URL"]
    ? { PUBLIC_URL: `https://${env["VERCEL_PROJECT_PRODUCTION_URL"]}` }
    : {}),
};
for (const [key, value] of Object.entries(defaults)) env[key] ??= value;

// Vercel freezes the function once it has answered; work after the response (ERC-8004 feedback)
// survives only through waitUntil.
const gateway = createGateway(loadConfig(), { defer: waitUntil });
const missing = [
  ...(env["RELAYER_PRIVATE_KEY"] ? [] : ["RELAYER_PRIVATE_KEY (relay + on-chain settlement)"]),
  ...(env["BLOB_READ_WRITE_TOKEN"] ? [] : ["BLOB_READ_WRITE_TOKEN (durable blobs + passports)"]),
];
if (missing.length > 0) gateway.logger.warn("hosted gateway is degraded", { missing });

// Vercel's web-standard `fetch` export: one function, every method, the original request URL —
// the documented shape for Hono-style apps (functions-api-reference, "fetch Web Standard").
export default {
  fetch: (request: Request): Response | Promise<Response> => gateway.app.fetch(request),
};
