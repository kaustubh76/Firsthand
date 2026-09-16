#!/usr/bin/env node
// Builds the capture PWA into deploy/capture at the repo root — a static tree that is COMMITTED, so
// Vercel serves it from git with no build step (the monorepo build needs Foundry, which the builder
// lacks). Pass the hosted gateway as FH_HOSTED_GATEWAY_URL; `?gateway=` overrides it at runtime.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "..", "..", "deploy", "capture");
const gateway = process.env["FH_HOSTED_GATEWAY_URL"] ?? "https://firsthand-gateway.vercel.app";

execFileSync("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_GATEWAY_URL: gateway, FH_SOURCEMAP: "false" },
});
if (!existsSync(join(out, "index.html"))) throw new Error("vite produced no index.html");

writeFileSync(
  join(out, "vercel.json"),
  `${JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      // The service worker and manifest must never be served stale, or an update cannot land.
      headers: [
        { source: "/sw.js", headers: [{ key: "cache-control", value: "no-cache" }] },
        { source: "/manifest.webmanifest", headers: [{ key: "cache-control", value: "no-cache" }] },
        {
          source: "/assets/(.*)",
          headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, "README.md"),
  `# Capture PWA (generated)

Static deploy tree for the public FIRSTHAND capture app on Vercel. **Do not edit by hand** —
regenerate with \`pnpm --filter firsthand-capture bundle:vercel\` after changing \`apps/capture\` or a
package it depends on, then commit. Built against gateway \`${gateway}\`; append
\`?gateway=https://…\` to the app URL to point one build at another gateway.
`,
);
console.log(`capture deploy tree: ${out} (${readdirSync(join(out, "assets")).length} assets)`);
