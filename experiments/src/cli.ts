import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@firsthand/runtime";
import { Runner } from "./harness/Runner.js";
import { renderReport } from "./report.js";
import { s1 } from "./scenarios/s1-deposit-scale.js";
import { s2 } from "./scenarios/s2-buyer-loop.js";
import { s3 } from "./scenarios/s3-rescission-race.js";
import { s4 } from "./scenarios/s4-refusal.js";

/**
 * firsthand experiments: `pnpm --filter @firsthand/experiments run <s1|s2|s3|s4|report> [--dry-run] [--n N] [--arm A]`
 */
const args = process.argv.slice(2);
const command = args[0] ?? "report";
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = args.includes("--dry-run");
const logger = createLogger({
  level:
    (process.env["LOG_LEVEL"] as "debug" | "info" | "warn" | undefined) ??
    (dryRun ? "warn" : "info"),
});
const runner = new Runner({
  resultsDir: join(dirname(fileURLToPath(import.meta.url)), "..", "results"),
  logger,
});
const scenarios = { s1, s2, s3, s4 } as const;

if (command === "report") {
  console.log(renderReport(runner));
} else if (command in scenarios) {
  const scenario = scenarios[command as keyof typeof scenarios];
  const defaults = { s1: 10_000, s2: 100, s3: 50, s4: 1_000 } as const;
  const n = Number(flag("n") ?? defaults[command as keyof typeof defaults]);
  const arm = flag("arm");
  const trials = await runner.run(scenario, { dryRun, n }, arm ? [arm] : scenario.arms);
  for (const t of trials) console.log(JSON.stringify(t, null, 2));
} else {
  console.error("usage: run <s1|s2|s3|s4|report> [--dry-run] [--n N] [--arm A]");
  process.exit(2);
}
