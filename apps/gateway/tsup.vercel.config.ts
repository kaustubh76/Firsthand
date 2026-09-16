import { defineConfig } from "tsup";

/**
 * The hosted-gateway bundle: every dependency inlined so the deploy tree needs no install — and so
 * the Vercel builder never has to run Foundry (the contracts package builds its ABIs with forge).
 */
export default defineConfig({
  entry: { "api/index": "src/vercel.ts" },
  outDir: "dist-vercel",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  treeshake: true,
  clean: true,
  dts: false,
  // CommonJS dependencies (jose, via @vercel/blob) `require` node built-ins; give the ESM bundle one.
  banner: {
    js: 'import { createRequire as __fhCreateRequire } from "node:module"; const require = __fhCreateRequire(import.meta.url);',
  },
});
