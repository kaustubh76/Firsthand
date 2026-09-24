#!/usr/bin/env node
/**
 * The local-chain tier: the SDK's enroll → attest, deposit → anchor and rescind round trips, and the
 * gateway's grant → three paid queries → receipts → manifest → rate limit → rescission. They run
 * against a real chain, which means they need one, so every suite is `describe.skipIf(!enabled)`.
 *
 * That made `pnpm test:anvil` exit 0 having run nothing whenever ANVIL_RPC_URL, DEPLOYMENTS_FILE or
 * RELAYER_PRIVATE_KEY were unset — a green gate that measured nothing, which is worse than a red
 * one. This script refuses to be that: it finds the chain and the deployment itself, fills in what
 * CI passes explicitly, and when it cannot, says which precondition failed and the command that
 * fixes it. Silence is never an outcome here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const RPC = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
/** anvil's well-known account #1 — a published test key for a throwaway chain, the same one CI uses. */
const ANVIL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const deployments = process.env["DEPLOYMENTS_FILE"] ?? join(root, "deployments", "31337.json");

function die(what, fix) {
  console.error(`\nanvil-gate: ${what}\n\n  ${fix}\n`);
  process.exit(1);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}

let chainId;
try {
  chainId = await rpc("eth_chainId");
} catch {
  die(
    `no chain answering at ${RPC}`,
    "anvil --silent --port 8545 &   # on foundry before 1.7, add --odyssey for the RIP-7212 precompile",
  );
}
console.log(`anvil-gate: chain ${Number(chainId)} at ${RPC}`);

if (!existsSync(deployments)) {
  die(
    `no deployment document at ${deployments}`,
    "cd contracts && DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \\\n    USDC_ADDRESS=0x0000000000000000000000000000000000000dc0 \\\n    forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast",
  );
}

// A document left over from a previous anvil run points at addresses this chain has never heard of,
// and the suites would fail deep inside a call rather than here. Ask the chain instead of trusting
// the file.
const doc = JSON.parse(readFileSync(deployments, "utf8"));
const code = await rpc("eth_getCode", [doc.PrincipalRegistry, "latest"]);
if (!code || code === "0x") {
  die(
    `${deployments} names PrincipalRegistry at ${doc.PrincipalRegistry}, but this chain has no code there — the document is from an earlier anvil`,
    "restart anvil and redeploy (see the command above), or point DEPLOYMENTS_FILE at the right document",
  );
}

const env = {
  ...process.env,
  ANVIL_RPC_URL: RPC,
  DEPLOYMENTS_FILE: deployments,
  RELAYER_PRIVATE_KEY: process.env["RELAYER_PRIVATE_KEY"] ?? ANVIL_KEY,
};
// --force, deliberately: these suites depend on the state of a chain turbo cannot hash, so a cache
// hit would replay an old verdict — including, before this script existed, a cached *skip*.
const r = spawnSync("pnpm", ["turbo", "run", "test:anvil", "--concurrency=1", "--force"], {
  cwd: root,
  stdio: "inherit",
  env,
});
process.exit(r.status ?? 1);
