#!/usr/bin/env node
// Redeploys the public surfaces: regenerates the committed deploy trees and ships them with the
// Vercel CLI (`npx vercel@59`, authenticated once with `vercel login`). Usage:
//   node scripts/deploy-hosted.mjs [gateway|capture|all]   (default: all)
// The gateway goes first so the capture tree is built against the gateway's production URL.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const what = process.argv[2] ?? "all";
const GATEWAY_URL = process.env["FH_HOSTED_GATEWAY_URL"] ?? "https://firsthand-gateway.vercel.app";
const vercel = ["vercel@59", "--yes"];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}
function ship(dir, project) {
  if (!existsSync(join(dir, ".vercel", "project.json"))) {
    run("npx", [...vercel, "link", "--yes", "--project", project], dir);
  }
  run("npx", [...vercel, "deploy", "--prod", "--yes"], dir);
}

if (what === "gateway" || what === "all") {
  run("pnpm", ["--filter", "firsthand-gateway", "bundle:vercel"], root);
  ship(join(root, "deploy", "gateway"), "firsthand-gateway");
  const health = execFileSync("curl", ["-s", `${GATEWAY_URL}/healthz`]).toString();
  console.log(`gateway /healthz → ${health}`);
}
if (what === "capture" || what === "all") {
  run("pnpm", ["--filter", "firsthand-capture", "bundle:vercel"], root); // reads FH_HOSTED_GATEWAY_URL
  ship(join(root, "deploy", "capture"), "firsthand-capture");
}
console.log("\nCommit the regenerated deploy/ trees so git matches what is live.");
