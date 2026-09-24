#!/usr/bin/env node
// The Solidity half of `check:all`: `forge fmt --check` and `forge test` when Foundry is installed,
// a printed reason when it is not (CI installs it; a contributor without it still gets every
// TypeScript gate). Foundry is looked up on PATH and in its default install location.
//
// Formatting is checked here rather than in `turbo run lint` because nothing invokes that task —
// the root `lint` script is `biome ci .` directly — so for a while `forge fmt --check` ran only in
// CI (.github/workflows/ci.yml) and a contributor could pass `check:all` and still fail the build.
//
// But `forge fmt` is not stable across Foundry versions — 1.7 wraps long expressions differently
// from the 1.1.0 CI pins — so a local formatter that disagrees with CI's would fail this gate on
// code CI is perfectly happy with, and "fixing" it would break CI instead. The pinned version is
// read out of the workflow rather than copied here (one source of truth, nothing to drift), and
// when the local Foundry is a different one the formatting result is reported instead of enforced.
// A gate may only fail you for something it can actually vouch for.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const candidates = [
  "forge",
  join(homedir(), ".foundry", "bin", "forge"),
  join(homedir(), ".cargo", "bin", "forge"),
];
const forge = candidates.find((c) =>
  c === "forge"
    ? spawnSync("forge", ["--version"], { stdio: "ignore" }).status === 0
    : existsSync(c),
);
if (!forge) {
  console.log(
    "forge-gate: Foundry not installed — skipping `forge test` (CI runs it; see docs/DEVELOPMENT.md)",
  );
  process.exit(0);
}
const contracts = join(root, "contracts");

/** The Foundry version CI installs, read from the workflow that installs it — one source of truth. */
function pinnedVersion() {
  try {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    return ci.match(/foundry-toolchain@v1[\s\S]{0,160}?version:\s*v?([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
const version = spawnSync(forge, ["--version"], { encoding: "utf8" });
const local = version.stdout?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
const pinned = pinnedVersion();
const sameFormatter = local !== null && pinned !== null && local === pinned;

const fmt = spawnSync(forge, ["fmt", "--check"], { cwd: contracts, stdio: "inherit" });
if (fmt.status !== 0) {
  if (sameFormatter) {
    console.error("\nforge-gate: run `forge fmt` in contracts/ to fix the formatting above");
    process.exit(fmt.status ?? 1);
  }
  console.error(
    `\nforge-gate: the formatting above differs, but your Foundry is ${local ?? "unknown"} and CI pins ${pinned ?? "unknown"}.` +
      " `forge fmt` is not stable across versions, so this is reported, not enforced — reformatting now" +
      " would only move the failure into CI.\n" +
      `  To make it enforceable here: foundryup --install v${pinned ?? "<pinned>"}\n`,
  );
}

const test = spawnSync(forge, ["test"], { cwd: contracts, stdio: "inherit" });
process.exit(test.status ?? 1);
