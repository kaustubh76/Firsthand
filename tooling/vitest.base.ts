import { defineConfig, type ViteUserConfig } from "vitest/config";

export interface VitestOptions {
  /** Package name, used as the project name in the root workspace runner. */
  readonly name: string;
  /**
   * Minimum coverage percentage applied to lines, branches, functions and statements.
   * Omit for packages without a numeric gate (apps, adapters shells).
   */
  readonly threshold?: number;
  /**
   * Extra coverage exclusions for files that cannot run in vitest (browser-only ceremonies,
   * RPC-backed readers). Each exclusion must be justified in the package README.
   */
  readonly coverageExclude?: readonly string[];
  /** Additional Vite config (aliases, plugins). */
  readonly overrides?: ViteUserConfig;
}

/**
 * Shared Vitest configuration. Unit tests live next to sources as `*.test.ts`;
 * testnet tests live under `test/testnet` and are run by `test:testnet` only.
 */
export function makeVitestConfig({
  name,
  threshold,
  coverageExclude = [],
  overrides,
}: VitestOptions) {
  const thresholds =
    threshold === undefined
      ? undefined
      : { lines: threshold, branches: threshold, functions: threshold, statements: threshold };

  return defineConfig({
    ...overrides,
    test: {
      name,
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["**/node_modules/**", "**/dist/**", "test/testnet/**"],
      passWithNoTests: true,
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts", "src/**/*.tsx"],
        exclude: [
          "src/**/*.test.ts",
          "src/**/*.test.tsx",
          "src/**/index.ts",
          "src/**/*.d.ts",
          ...coverageExclude,
        ],
        reporter: ["text", "lcov"],
        ...(thresholds ? { thresholds } : {}),
      },
      ...overrides?.test,
    },
  });
}
