#!/usr/bin/env node
/**
 * Every configuration key an app reads must be documented in its `.env.example`, and every key the
 * example documents must exist. Drift here is invisible — the app keeps working for whoever set
 * the variable and stays undiscoverable for everyone else — which is how the gateway shipped
 * thirteen undocumented keys, including one that spends relayer gas on every paid query.
 *
 * Two kinds of source of truth:
 *   - a zod schema (gateway, MCP): keys are the `  KEY:` lines of the schema object;
 *   - `import.meta.env` reads (the capture PWA): keys are the `VITE_*` identifiers in its source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");

/** Keys declared in a zod schema object — the `  KEY: z.…` lines, ignoring nested indentation. */
const schemaKeys = (source) =>
  new Set([...source.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));

/** Keys an example file mentions, commented out or not. */
const exampleKeys = (source) =>
  new Set([...source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

/** `VITE_*` identifiers a source tree reads. */
function viteKeys(dir) {
  const found = new Set();
  const walk = (d) => {
    for (const entry of readdirSync(join(root, d))) {
      const rel = join(d, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry)) {
        for (const m of read(rel).matchAll(/VITE_[A-Z0-9_]+/g)) found.add(m[0]);
      }
    }
  };
  walk(dir);
  return found;
}

const targets = [
  {
    name: "gateway",
    declared: () => schemaKeys(read("apps/gateway/src/config.ts")),
    example: "apps/gateway/.env.example",
  },
  {
    name: "mcp",
    declared: () => schemaKeys(read("apps/mcp/src/config.ts")),
    example: "apps/mcp/.env.example",
  },
  {
    name: "capture",
    declared: () => viteKeys("apps/capture/src"),
    example: "apps/capture/.env.example",
  },
];

let failed = false;
for (const target of targets) {
  const declared = target.declared();
  const documented = exampleKeys(read(target.example));
  const undocumented = [...declared].filter((k) => !documented.has(k)).sort();
  const unknown = [...documented].filter((k) => !declared.has(k)).sort();
  if (undocumented.length === 0 && unknown.length === 0) {
    console.log(`env-example: ${target.name} ✓ (${declared.size} keys)`);
    continue;
  }
  failed = true;
  if (undocumented.length > 0) {
    console.error(
      `env-example: ${target.name} reads keys that ${target.example} does not document:`,
    );
    for (const k of undocumented) console.error(`  ${k}`);
  }
  if (unknown.length > 0) {
    console.error(`env-example: ${target.name} documents keys nothing reads (${target.example}):`);
    for (const k of unknown) console.error(`  ${k}`);
  }
}
process.exit(failed ? 1 : 0);
