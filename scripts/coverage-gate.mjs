#!/usr/bin/env node
/**
 * Gates Foundry line + branch coverage for a path prefix (default: contracts/src/libraries/).
 *
 * Usage: node scripts/coverage-gate.mjs --lcov contracts/lcov.info --min 95 --include src/libraries/
 *        node scripts/coverage-gate.mjs --lcov contracts/lcov.info --min 100 --min-branches 95 --include src/
 *
 * Parses LCOV records (SF/DA/BRDA) and fails when the aggregate line or branch coverage over the
 * included files is below its minimum. Branch coverage is skipped when no BRDA records exist
 * (older forge versions emit none).
 *
 * `--min-branches` exists because the two are different claims and the repo makes a different one
 * about each: every line of `contracts/src` is executed (100 %), while branches stand at 97.75 %.
 * Gating both at one number would either let the line claim rot or assert a branch figure that is
 * not true. Defaults to `--min`, so existing invocations are unchanged.
 */
import { readFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const lcovPath = arg("lcov", "contracts/lcov.info");
const min = Number(arg("min", "95"));
const minBranches = Number(arg("min-branches", String(min)));
const include = arg("include", "src/libraries/");

const text = readFileSync(lcovPath, "utf8");
const records = text.split(/end_of_record\s*/);
const lines = { hit: 0, found: 0 };
const branches = { hit: 0, found: 0 };
const perFile = [];

for (const record of records) {
  const sf = /^SF:(.*)$/m.exec(record);
  if (!sf?.[1]?.includes(include)) continue;
  let lf = 0;
  let lh = 0;
  let bf = 0;
  let bh = 0;
  for (const line of record.split("\n")) {
    if (line.startsWith("DA:")) {
      lf++;
      if (Number(line.split(",")[1]) > 0) lh++;
    } else if (line.startsWith("BRDA:")) {
      bf++;
      const taken = line.split(",")[3];
      if (taken !== "-" && Number(taken) > 0) bh++;
    }
  }
  lines.found += lf;
  lines.hit += lh;
  branches.found += bf;
  branches.hit += bh;
  perFile.push({ file: sf[1], lines: pct(lh, lf), branches: bf ? pct(bh, bf) : null });
}

function pct(hit, found) {
  return found === 0 ? 100 : (hit / found) * 100;
}

if (perFile.length === 0) {
  console.error(`✗ no LCOV records matched "${include}" in ${lcovPath}`);
  process.exit(1);
}

for (const f of perFile) {
  console.log(
    `  ${f.file.padEnd(40)} lines ${f.lines.toFixed(1).padStart(5)}%` +
      (f.branches === null ? "" : `  branches ${f.branches.toFixed(1).padStart(5)}%`),
  );
}
const lineCov = pct(lines.hit, lines.found);
const branchCov = branches.found ? pct(branches.hit, branches.found) : null;
console.log(
  `\n${include}: lines ${lineCov.toFixed(2)}%` +
    (branchCov === null ? " (no branch data)" : `, branches ${branchCov.toFixed(2)}%`) +
    ` — minimum ${min}% lines` +
    (branchCov === null ? "" : `, ${minBranches}% branches`),
);
const failed = lineCov < min || (branchCov !== null && branchCov < minBranches);
if (failed) {
  console.error("✗ coverage gate failed");
  process.exit(1);
}
console.log("✓ coverage gate passed");
