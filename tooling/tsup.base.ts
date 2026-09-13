import { defineConfig, type Options } from "tsup";

export interface TsupEntry {
  /** Entry files relative to the package root, e.g. `["src/index.ts", "src/split/index.ts"]`. */
  readonly entry: readonly string[];
  /** Extra options merged over the defaults. */
  readonly overrides?: Options;
}

/**
 * Shared tsup configuration for every publishable package in the workspace.
 * Dual CJS + ESM output with type declarations, source maps and tree-shaking.
 */
export function makeTsupConfig({ entry, overrides }: TsupEntry) {
  return defineConfig({
    entry: [...entry],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    target: "es2022",
    platform: "neutral",
    outDir: "dist",
    ...overrides,
  });
}
