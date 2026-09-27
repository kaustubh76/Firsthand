#!/usr/bin/env node
/**
 * Asserts that the two public surfaces are serving the bytes this repository has committed.
 *
 * CI already checks that the committed `deploy/` trees are what their sources produce — sources →
 * tree, on a runner, with no network call. Nothing checked the other half, and the gap was not
 * theoretical: eight commits of the capture PWA went live-stale unnoticed, and the step that was
 * supposed to have caught it said so in a comment while never fetching anything. This fetches.
 *
 * Deliberately not part of `ci`, for the reason interop.yml already gives: a check that depends on
 * Vercel being up must not be able to redden a pull request that did not touch it. Schedule it, and
 * run it by hand after a deploy.
 *
 * Usage: node scripts/live-gate.mjs [--gateway https://…] [--app https://…]
 * Exit 0 when live matches committed; 1 with a named difference otherwise.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const GATEWAY = arg("gateway", "https://firsthand-gateway.vercel.app").replace(/\/+$/, "");
const APP = arg("app", "https://firsthand-capture.vercel.app").replace(/\/+$/, "");
const TIMEOUT_MS = 20_000;

const failures = [];
const notes = [];
const fail = (what, expected, got) =>
  failures.push(`${what}\n      committed: ${expected}\n      live:      ${got}`);

async function get(url, as = "text") {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return as === "json" ? await res.json() : await res.text();
}

/** The asset filenames vite emits are content hashes, so the reference list is the whole check. */
const assetsOf = (html) =>
  [...html.matchAll(/(?:assets|src)\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]).sort();

async function checkCapture() {
  const local = join(ROOT, "deploy", "capture", "index.html");
  if (!existsSync(local)) {
    notes.push("deploy/capture/index.html is absent — nothing committed to compare against");
    return;
  }
  const committed = assetsOf(readFileSync(local, "utf8"));
  const live = assetsOf(await get(`${APP}/`));
  if (committed.length === 0) {
    notes.push("deploy/capture/index.html references no hashed assets — check the bundler");
    return;
  }
  if (committed.join(" ") !== live.join(" ")) {
    fail(`${APP} is not serving the committed capture tree`, committed.join(" "), live.join(" "));
  } else {
    notes.push(`capture: ${committed.length} asset(s) match (${committed[0]})`);
  }
}

async function checkGateway() {
  const local = join(ROOT, "deploy", "gateway", "public", "build.txt");
  const bundle = join(ROOT, "deploy", "gateway", "api", "index.js");
  if (!existsSync(local)) {
    notes.push("deploy/gateway/public/build.txt is absent — regenerate the tree to stamp it");
  } else {
    const committed = readFileSync(local, "utf8").trim();
    // The stamp must also describe the bundle beside it, or the tree is internally inconsistent.
    if (existsSync(bundle)) {
      const actual = createHash("sha256").update(readFileSync(bundle)).digest("hex");
      if (actual !== committed) {
        fail("deploy/gateway/public/build.txt does not describe api/index.js", committed, actual);
      }
    }
    const live = (await get(`${GATEWAY}/build.txt`)).trim();
    if (live !== committed) {
      fail(`${GATEWAY} is not serving the committed gateway bundle`, committed, live);
    } else {
      notes.push(`gateway: build ${committed.slice(0, 12)}… matches`);
    }
  }

  const health = await get(`${GATEWAY}/healthz`, "json");
  if (health.ok !== true)
    fail(`${GATEWAY}/healthz is not ok`, "ok: true", JSON.stringify(health.ok));
  // The venue running dry is the other way the live links stop being the project.
  const relayer = health.relayer ?? null;
  if (relayer === null) {
    notes.push("gateway reports no relayer float — writes may be disabled");
  } else if (relayer.low === true) {
    fail(`${GATEWAY} relayer float is low`, "low: false", `${relayer.balanceMon} MON`);
  } else {
    notes.push(`relayer: ${relayer.balanceMon} MON (low: false)`);
  }
}

/** Every address this repo deployed should be addressable by a client reading discovery. */
async function checkDiscovery() {
  const disco = await get(`${GATEWAY}/.well-known/firsthand.json`, "json");
  const contracts = disco.contracts ?? {};
  const file = join(ROOT, "deployments", `${disco.chainId}.json`);
  if (!existsSync(file)) {
    notes.push(`no committed deployment for chain ${disco.chainId} — discovery not cross-checked`);
    return;
  }
  const deployment = JSON.parse(readFileSync(file, "utf8"));
  // `PassportAnchors` is the bound alias of one of the two layouts; the aliases are not published.
  const skip = new Set(["PassportAnchorsBaseline", "PassportAnchorsPaged", "USDC"]);
  const missing = Object.entries(deployment)
    .filter(([, v]) => typeof v === "string" && v.startsWith("0x") && v.length === 42)
    .filter(([k]) => !skip.has(k))
    .filter(([k, v]) => (contracts[k] ?? "").toLowerCase() !== v.toLowerCase())
    .map(([k]) => k);
  if (missing.length > 0) {
    fail(
      `${GATEWAY} discovery does not publish every deployed address`,
      Object.keys(deployment)
        .filter((k) => !skip.has(k))
        .join(", "),
      `missing or mismatched: ${missing.join(", ")}`,
    );
  } else {
    notes.push(
      `discovery: ${Object.keys(contracts).length} address(es), all match chain ${disco.chainId}`,
    );
  }
}

async function main() {
  for (const check of [checkCapture, checkGateway, checkDiscovery]) {
    try {
      await check();
    } catch (error) {
      failures.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const note of notes) console.log(`  ✓ ${note}`);
  if (failures.length > 0) {
    console.error(`\n✗ the live surfaces are not what is committed:\n`);
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    console.error(`Redeploy with \`pnpm deploy:hosted\`, then commit the regenerated trees.`);
    process.exit(1);
  }
  console.log(`\n✓ live == committed (${APP}, ${GATEWAY})`);
}

await main();
