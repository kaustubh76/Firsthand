#!/usr/bin/env node
// Assembles the deploy tree for the hosted gateway (docs/DEPLOY.md). Output: apps/gateway/dist-vercel
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-vercel");

execFileSync("pnpm", ["exec", "tsup", "--config", "tsup.vercel.config.ts"], {
  cwd: root,
  stdio: "inherit",
});
const bundle = join(out, "api", "index.js");
if (!existsSync(bundle)) throw new Error(`bundle missing: ${bundle}`);

// No dependencies: the bundle is self-contained. `type: module` because the bundle is ESM.
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "firsthand-gateway-hosted",
      private: true,
      type: "module",
      engines: { node: "22.x" },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, "vercel.json"),
  `${JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      // One function serves every path; Hono routes inside it.
      rewrites: [{ source: "/(.*)", destination: "/api/index" }],
      functions: { "api/index.js": { maxDuration: 60, memory: 1024 } },
    },
    null,
    2,
  )}\n`,
);
// Vercel wants a static output directory even when everything is a function.
mkdirSync(join(out, "public"), { recursive: true });
writeFileSync(join(out, "public", "robots.txt"), "User-agent: *\nDisallow: /v1/\n");

const kb = Math.round(statSync(bundle).size / 1024);
console.log(`hosted gateway bundle: ${bundle} (${kb} KiB)`);
