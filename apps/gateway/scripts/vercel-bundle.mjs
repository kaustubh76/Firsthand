#!/usr/bin/env node
// Assembles the deploy tree for the hosted gateway into deploy/gateway at the repo root. That tree
// is COMMITTED: Vercel builds it from git as a plain four-dependency npm project, so every push
// redeploys without the builder ever touching the monorepo, Foundry or the Node-26 engine gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "..", "..", "deploy", "gateway");

// The tree is emptied on every build, but its Vercel project link (`.vercel/`, git-ignored) must
// survive — without it the next `vercel deploy` would create a project named after the directory.
function preserveLink(out, build) {
  const link = join(out, ".vercel");
  const stash = `${out}.vercel-link`;
  const had = existsSync(link);
  if (had) cpSync(link, stash, { recursive: true });
  try {
    build();
  } finally {
    if (had) {
      rmSync(link, { recursive: true, force: true });
      cpSync(stash, link, { recursive: true });
      rmSync(stash, { recursive: true, force: true });
    }
  }
}

preserveLink(out, () =>
  execFileSync("pnpm", ["exec", "tsup", "--config", "tsup.vercel.config.ts"], {
    cwd: root,
    stdio: "inherit",
  }),
);
const bundle = join(out, "api", "index.js");
if (!existsSync(bundle)) throw new Error(`bundle missing: ${bundle}`);

// Registry dependencies pinned to the workspace catalog, so the hosted build runs what the tests ran.
const workspace = readFileSync(join(root, "..", "..", "pnpm-workspace.yaml"), "utf8");
const pinned = (name) => {
  for (const line of workspace.split("\n")) {
    const m = /^\s*["']?([^"':]+)["']?:\s*(\S+)\s*$/.exec(line);
    if (m && m[1] === name) return m[2];
  }
  throw new Error(`${name} is not in the pnpm catalog`);
};
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "firsthand-gateway-hosted",
      private: true,
      type: "module",
      engines: { node: "22.x" },
      dependencies: Object.fromEntries(
        ["hono", "viem", "zod", "@vercel/blob", "@vercel/functions"].map((name) => [
          name,
          pinned(name),
        ]),
      ),
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
/**
 * The deployed build's identity, so `scripts/live-gate.mjs` can tell whether what is live is what is
 * committed. It goes in `public/` — served statically at the root, verified — rather than into the
 * function, because a digest cannot live inside the file it digests. Nothing in the gateway's own
 * code changes for it. The capture side needs no equivalent: the asset filenames in its `index.html`
 * are already content hashes.
 */
writeFileSync(
  join(out, "public", "build.txt"),
  `${createHash("sha256").update(readFileSync(bundle)).digest("hex")}\n`,
);

writeFileSync(
  join(out, "README.md"),
  `# Hosted gateway (generated)

Deploy tree for the public FIRSTHAND gateway on Vercel. **Do not edit by hand** — regenerate with
\`pnpm --filter firsthand-gateway bundle:vercel\` after changing \`apps/gateway\` or any workspace
package it depends on, then commit. \`api/index.js\` bundles every \`@firsthand/*\` package; the four
registry dependencies are pinned to the pnpm catalog. Entry: \`apps/gateway/src/vercel.ts\`.
`,
);

const kb = Math.round(statSync(bundle).size / 1024);
console.log(`hosted gateway bundle: ${bundle} (${kb} KiB)`);
