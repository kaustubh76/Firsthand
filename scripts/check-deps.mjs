#!/usr/bin/env node
/**
 * Enforces the workspace dependency graph documented in docs/adr/0001-monorepo-and-package-boundaries.md.
 *
 * For every workspace package this script reads `dependencies` (runtime only — devDependencies are
 * unrestricted apart from the hard-forbidden edges) and fails if any dependency is not on that
 * package's allow-list. The allow-list is data, kept here so that the graph is reviewable in one
 * place and cannot drift silently.
 *
 * Usage: node scripts/check-deps.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace globs, mirrored from pnpm-workspace.yaml. */
const WORKSPACE_DIRS = ["packages", "apps"];
const WORKSPACE_SINGLES = ["contracts", "experiments"];

/**
 * Allowed *runtime* dependencies per package. Internal packages are listed by name;
 * external packages are listed explicitly so that scope creep is visible in review.
 */
const GRAPH = {
  "@firsthand/core": {
    internal: [],
    external: ["@noble/hashes", "@noble/curves", "zod"],
  },
  "@firsthand/crypto": {
    internal: ["@firsthand/core"],
    external: ["@noble/hashes", "@noble/curves", "@noble/ciphers"],
  },
  "@firsthand/test-vectors": {
    internal: [],
    external: ["zod"],
  },
  "@firsthand/runtime": {
    internal: ["@firsthand/core"],
    external: ["zod"],
  },
  "@firsthand/contracts": {
    internal: [],
    external: ["abitype"],
  },
  "@firsthand/adapters": {
    internal: ["@firsthand/core", "@firsthand/runtime", "@firsthand/contracts"],
    external: ["viem", "zod"],
  },
  "@firsthand/sdk": {
    internal: [
      "@firsthand/core",
      "@firsthand/crypto",
      "@firsthand/adapters",
      "@firsthand/runtime",
      "@firsthand/contracts",
    ],
    external: ["viem", "zod"],
  },
  "@firsthand/importers": {
    internal: ["@firsthand/core"],
    external: ["zod"],
  },
  "@firsthand/indexer": {
    internal: [],
    external: ["envio"],
  },
  "firsthand-gateway": {
    internal: [
      "@firsthand/core",
      "@firsthand/runtime",
      "@firsthand/adapters",
      "@firsthand/sdk",
      "@firsthand/contracts",
    ],
    external: ["hono", "@hono/node-server", "@vercel/blob", "viem", "zod"],
    // Hard rule: the serving path never holds key material (ADR-0001, README §4/§12).
    forbidden: ["@firsthand/crypto"],
  },
  "firsthand-demo": {
    internal: [
      "@firsthand/core",
      "@firsthand/crypto",
      "@firsthand/adapters",
      "@firsthand/sdk",
      "@firsthand/runtime",
      "@firsthand/contracts",
    ],
    external: ["viem"],
  },
  "firsthand-mcp": {
    internal: [
      "@firsthand/importers",
      "@firsthand/sdk",
      "@firsthand/crypto",
      "@firsthand/importers",
      "@firsthand/runtime",
      "@firsthand/core",
    ],
    external: ["@modelcontextprotocol/sdk", "zod", "viem"],
  },
  "firsthand-capture": {
    // Adapters is a runtime dependency: the PWA needs the relay transport and the on-chain reader.
    // It imports `@firsthand/adapters/client`, never the root entry, which pulls node built-ins.
    internal: ["@firsthand/sdk", "@firsthand/crypto", "@firsthand/core", "@firsthand/adapters"],
    external: ["react", "react-dom"],
  },
  "@firsthand/experiments": {
    // Runs on a developer machine with throw-away keys; the S4 on-chain arm forges deposit signatures.
    internal: [
      "@firsthand/sdk",
      "@firsthand/adapters",
      "@firsthand/contracts",
      "@firsthand/runtime",
      "@firsthand/core",
      "@firsthand/crypto",
    ],
    external: ["viem", "zod"],
  },
};

/** Packages nothing may depend on at runtime. */
const LEAF_ONLY = new Set(["firsthand-gateway", "firsthand-mcp", "firsthand-capture"]);

function readPkg(dir) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  return { dir, pkg: JSON.parse(readFileSync(file, "utf8")) };
}

function listWorkspacePackages() {
  const found = [];
  for (const parent of WORKSPACE_DIRS) {
    const base = join(ROOT, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = readPkg(join(base, entry.name));
      if (p) found.push(p);
    }
  }
  for (const single of WORKSPACE_SINGLES) {
    const p = readPkg(join(ROOT, single));
    if (p) found.push(p);
  }
  return found;
}

function main() {
  const packages = listWorkspacePackages();
  const names = new Set(packages.map(({ pkg }) => pkg.name));
  const errors = [];

  for (const { dir, pkg } of packages) {
    const rules = GRAPH[pkg.name];
    if (!rules) {
      errors.push(`${pkg.name} (${dir}) is not declared in scripts/check-deps.mjs GRAPH`);
      continue;
    }
    const allowed = new Set([...rules.internal, ...rules.external]);
    const forbidden = new Set(rules.forbidden ?? []);

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (forbidden.has(dep)) {
        errors.push(`${pkg.name} → ${dep} is FORBIDDEN (privacy boundary)`);
        continue;
      }
      if (names.has(dep) && LEAF_ONLY.has(dep)) {
        errors.push(`${pkg.name} → ${dep}: nothing may depend on an app`);
        continue;
      }
      if (!allowed.has(dep)) {
        errors.push(`${pkg.name} → ${dep} is not on the allow-list`);
      }
    }
    // Forbidden edges apply to devDependencies as well: a test double is still an import.
    for (const dep of Object.keys(pkg.devDependencies ?? {})) {
      if (forbidden.has(dep)) {
        errors.push(`${pkg.name} → ${dep} is FORBIDDEN even as a devDependency`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("Dependency graph violations:\n");
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `\n${errors.length} violation(s). See docs/adr/0001-monorepo-and-package-boundaries.md`,
    );
    process.exit(1);
  }
  console.log(`✓ dependency graph OK (${packages.length} workspace packages checked)`);
}

main();
