#!/usr/bin/env node
// The Solidity half of `check:all`: `forge test` when Foundry is installed, a printed reason when
// it is not (CI installs it; a contributor without it still gets every TypeScript gate). Foundry is
// looked up on PATH and in its default install location.
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
const r = spawnSync(forge, ["test"], { cwd: join(root, "contracts"), stdio: "inherit" });
process.exit(r.status ?? 1);
