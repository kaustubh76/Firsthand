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
 * fixes it. Then it counts the tests that actually ran and fails if the answer is zero, because
 * "turbo had nothing to do" and "the round trips pass" must never look the same from outside.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the latter stays percent-encoded, so a checkout under a path
// with a space resolves to a directory that does not exist.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
/** anvil's well-known account #1 — a published test key for a throwaway chain, the same one CI uses. */
const ANVIL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const deployments = process.env["DEPLOYMENTS_FILE"] ?? join(root, "deployments", "31337.json");

function die(what, fix) {
  console.error(`\nanvil-gate: ${what}\n\n  ${fix}\n`);
  process.exit(1);
}

/**
 * Enrolment verifies a P-256 signature through the RIP-7212 precompile. Foundry before 1.7 hides it
 * behind `--odyssey`; 1.7 removed the flag and ships it by default. Ask the installed binary rather
 * than naming a flag — CI still pins v1.1.0, so a hard-coded message is wrong for somebody.
 */
function anvilFlags() {
  const help = spawnSync("anvil", ["--help"], { encoding: "utf8" });
  if (help.error) return null;
  return help.stdout?.includes("--odyssey") ? "--odyssey --silent" : "--silent";
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  // A JSON-RPC error is a node fault, not a verdict about the deployment — surface it as itself,
  // or the caller below blames a stale document for what is really an unreachable chain.
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

const flags = anvilFlags();
const startCmd =
  flags === null
    ? "install Foundry (https://getfoundry.sh), then: anvil --silent --port 8545 &"
    : `anvil ${flags} --port 8545 &`;

let chainId;
try {
  chainId = await rpc("eth_chainId");
} catch (err) {
  die(`no chain answering at ${RPC} (${err.message})`, startCmd);
}
console.log(`anvil-gate: chain ${Number(chainId)} at ${RPC}`);

if (!existsSync(deployments)) {
  die(
    `no deployment document at ${deployments}`,
    "cd contracts && DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \\\n    USDC_ADDRESS=0x0000000000000000000000000000000000000dc0 \\\n    forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast",
  );
}

// A document left over from a previous anvil points at addresses this chain has never heard of, and
// the suites would fail deep inside a call rather than here. Ask the chain instead of trusting the
// file.
const doc = JSON.parse(readFileSync(deployments, "utf8"));
if (typeof doc.PrincipalRegistry !== "string") {
  die(`${deployments} has no PrincipalRegistry address — is it a deployment document?`, startCmd);
}
let code;
try {
  code = await rpc("eth_getCode", [doc.PrincipalRegistry, "latest"]);
} catch (err) {
  die(`the chain at ${RPC} stopped answering (${err.message})`, startCmd);
}
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
// No --force: turbo.json already declares `"cache": false` for this task, because it depends on
// chain state turbo cannot hash. --force would additionally invalidate the whole ^build closure and
// rebuild the contracts inside a step named for the round trips.
const child = spawn("pnpm", ["turbo", "run", "test:anvil", "--concurrency=1"], {
  cwd: root,
  env,
  stdio: ["inherit", "pipe", "pipe"],
});

let transcript = "";
for (const [stream, sink] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    transcript += chunk.toString();
    sink.write(chunk);
  });
}
const status = await new Promise((resolve) => child.on("close", resolve));
if (status !== 0) process.exit(status ?? 1);

// The whole point of this script: turbo exiting 0 is not evidence. Count what vitest reported.
// Strip the colour codes first — turbo writes `Tests \x1b[1m\x1b[32m11 passed`, so a regex over the
// raw bytes finds nothing and this check would report zero on a perfectly good run.
// ESC is built rather than written: a literal control character in a regular expression is a lint
// error (Biome's noControlCharactersInRegex), and suppressing the rule to strip colour codes would
// be the wrong trade.
const CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = transcript.replace(CSI, "");
const ran = [...plain.matchAll(/Tests\s+(\d+) passed/g)].reduce((n, m) => n + Number(m[1]), 0);
if (ran === 0) {
  die(
    "turbo succeeded but no test reported running — the suites were skipped, or no package declares `test:anvil` any more",
    "check that packages/sdk and apps/gateway still have a test:anvil script, and that test/anvil/** is not empty",
  );
}
console.log(`\nanvil-gate: ${ran} tests ran against the chain at ${RPC}`);
