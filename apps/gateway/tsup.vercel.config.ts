import { defineConfig } from "tsup";

/**
 * The hosted-gateway bundle: every workspace package inlined, so the deploy tree is a plain npm
 * project with four registry dependencies — the Vercel builder never sees the monorepo, never runs
 * Foundry (the contracts package builds its ABIs with forge) and never meets the Node-26 engine gate.
 */
export default defineConfig({
  entry: { "api/index": "src/vercel.ts" },
  outDir: "../../deploy/gateway",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@firsthand\//],
  external: ["hono", "viem", "zod", "@vercel/blob"],
  splitting: false,
  sourcemap: false,
  // Whitespace and syntax only: identifiers stay readable in runtime stack traces.
  esbuildOptions(options) {
    options.minifyWhitespace = true;
    options.minifySyntax = true;
  },
  treeshake: true,
  clean: true,
  dts: false,
});
