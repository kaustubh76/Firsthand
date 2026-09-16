import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotenv } from "./dotenv.js";

/**
 * These guard a silent failure mode: before this existed, every `.env.example` in the repo was
 * decorative — the process read `process.env` only, so a service booted on defaults while the
 * operator believed it had read their file.
 */
describe("loadDotenv", () => {
  const dirs: string[] = [];
  const keys: string[] = [];
  const make = () => {
    const d = mkdtempSync(join(tmpdir(), "fh-env-"));
    dirs.push(d);
    return d;
  };
  const key = (name: string) => {
    keys.push(name);
    return name;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of keys.splice(0)) delete process.env[k];
  });

  it("loads an explicit file and reports the path it used", () => {
    const dir = make();
    const file = join(dir, "custom.env");
    const name = key("FH_TEST_EXPLICIT");
    writeFileSync(file, `${name}=from-file\n`);
    const loaded = loadDotenv({ file });
    expect(loaded.path).toBe(file);
    expect(process.env[name]).toBe("from-file");
  });

  it("walks up from cwd, so running one app still finds the repo root's .env", () => {
    const root = make();
    const nested = join(root, "apps", "thing");
    mkdirSync(nested, { recursive: true });
    const name = key("FH_TEST_WALKUP");
    writeFileSync(join(root, ".env"), `${name}=found\n`);
    const loaded = loadDotenv({ cwd: nested });
    expect(loaded.path).toBe(join(root, ".env"));
    expect(process.env[name]).toBe("found");
  });

  it("does not override a value already in the environment", () => {
    const dir = make();
    const name = key("FH_TEST_PRECEDENCE");
    process.env[name] = "from-shell";
    writeFileSync(join(dir, ".env"), `${name}=from-file\n`);
    loadDotenv({ cwd: dir });
    expect(process.env[name]).toBe("from-shell");
  });

  it("reports why nothing was loaded instead of throwing out of config loading", () => {
    const dir = make();
    expect(loadDotenv({ cwd: dir, depth: 0 })).toEqual({ path: null, reason: "no .env found" });
    expect(loadDotenv({ file: join(dir, "nope.env") }).reason).toContain("does not exist");
  });

  it("honours ENV_FILE", () => {
    const dir = make();
    const file = join(dir, "pointed.env");
    const name = key("FH_TEST_ENV_FILE");
    writeFileSync(file, `${name}=pointed\n`);
    process.env["ENV_FILE"] = file;
    keys.push("ENV_FILE");
    expect(loadDotenv().path).toBe(file);
    expect(process.env[name]).toBe("pointed");
  });

  it("never throws on a file it cannot parse", () => {
    const dir = make();
    writeFileSync(join(dir, ".env"), "=== not a env file ===");
    const loaded = loadDotenv({ cwd: dir });
    expect(loaded.path === null || typeof loaded.path === "string").toBe(true);
  });
});
