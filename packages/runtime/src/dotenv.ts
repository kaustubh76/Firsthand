/**
 * Loads a `.env` into `process.env` before config parsing. Node 26 ships `process.loadEnvFile`, so
 * this needs no dependency — and without it every `.env.example` in the repo is decorative: the
 * process silently runs on defaults instead of the values someone just typed.
 *
 * Walks up from `cwd` to the repo root so `pnpm --filter <app> dev` finds the root `.env` too.
 * Values already present in the environment win, matching dotenv convention.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface LoadedEnv {
  readonly path: string | null;
  readonly reason?: string;
}

export function loadDotenv(
  options: { cwd?: string; file?: string; depth?: number } = {},
): LoadedEnv {
  const explicit = options.file ?? process.env["ENV_FILE"];
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) return { path: null, reason: `${path} does not exist` };
    return apply(path);
  }
  let dir = resolve(options.cwd ?? process.cwd());
  for (let i = 0; i <= (options.depth ?? 4); i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return apply(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: null, reason: "no .env found" };
}

function apply(path: string): LoadedEnv {
  try {
    // Node >= 20.12; declared on the global process type from Node 26's lib.
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(path);
    return { path };
  } catch (cause) {
    return { path: null, reason: `${path}: ${(cause as Error).message}` };
  }
}
