#!/usr/bin/env node
// Redeploys the public surfaces: regenerates the committed deploy trees and ships them with the
// Vercel CLI (`npx vercel@59`, authenticated once with `vercel login`). Usage:
//   node scripts/deploy-hosted.mjs [gateway|capture|all]   (default: all)
// The gateway goes first so the capture tree is built against the gateway's production URL.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const what = process.argv[2] ?? "all";
const GATEWAY_URL = process.env["FH_HOSTED_GATEWAY_URL"] ?? "https://firsthand-gateway.vercel.app";

/**
 * The CLI is installed under relaxed engine checks, for this call only. Measured, from the repo
 * root on Node 26: `npx vercel@59` dies with `npm error notsup … Required: {"node":"^20.9.0 ||
 * ^22.11.0 || ^24"}` — one of the CLI's transitive dependencies declares a range that stops at
 * Node 24, and this repo's `.npmrc engine-strict=true` turns that warning into a hard failure. So
 * the documented redeploy path did not run on the Node the repo itself requires. Engine strictness
 * is there to keep *our* packages honest about what they run on; it has no business vetting a
 * vendored CLI, so it is switched off for this subprocess and nowhere else. (An npm env var
 * outranks .npmrc, and is scoped to the child.)
 */
const npmEnv = { ...process.env, npm_config_engine_strict: "false", npm_config_yes: "true" };

function run(cmd, args, cwd, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env });
  if (r.error) throw new Error(`${cmd} could not be started: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}
/** `--yes` before the spec answers npx's install prompt; after it, it answers Vercel's. */
const vercel = (args, dir) => run("npx", ["--yes", "vercel@59", ...args, "--yes"], dir, npmEnv);

function ship(dir, project) {
  if (!existsSync(join(dir, ".vercel", "project.json"))) {
    vercel(["link", "--project", project], dir);
  }
  vercel(["deploy", "--prod"], dir);
}

/** Reads the health of what was just shipped. A deploy that answers nothing is a failed deploy. */
async function health(url) {
  const res = await fetch(`${url}/healthz`);
  const body = await res.text();
  if (!res.ok) throw new Error(`${url}/healthz answered ${res.status}: ${body.slice(0, 300)}`);
  console.log(`gateway /healthz → ${body}`);
}

if (what === "gateway" || what === "all") {
  run("pnpm", ["--filter", "firsthand-gateway", "bundle:vercel"], root);
  ship(join(root, "deploy", "gateway"), "firsthand-gateway");
  await health(GATEWAY_URL);
}
if (what === "capture" || what === "all") {
  run("pnpm", ["--filter", "firsthand-capture", "bundle:vercel"], root); // reads FH_HOSTED_GATEWAY_URL
  ship(join(root, "deploy", "capture"), "firsthand-capture");
}
console.log("\nCommit the regenerated deploy/ trees so git matches what is live.");
