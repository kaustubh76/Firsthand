#!/usr/bin/env node
// The Solidity half of `check:all`: `forge fmt --check` and `forge test` when Foundry is installed,
// a printed reason when it is not (CI installs it; a contributor without it still gets every
// TypeScript gate). Foundry is looked up on PATH and in its default install location.
//
// Formatting is checked here rather than in `turbo run lint` because nothing invokes that task —
// the root `lint` script is `biome ci .` directly — so for a while `forge fmt --check` ran only in
// CI (.github/workflows/ci.yml) and a contributor could pass `check:all` and still fail the build.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
for (const args of [["fmt", "--check"], ["test"]]) {
  const r = spawnSync(forge, args, { cwd: contracts, stdio: "inherit" });
  if (r.status !== 0) {
    if (args[0] === "fmt")
      console.error("forge-gate: run `forge fmt` in contracts/ to fix the formatting above");
    process.exit(r.status ?? 1);
  }
}
