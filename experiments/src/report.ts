import type { Runner } from "./harness/Runner.js";
import type { TrialResult } from "./harness/Trial.js";

/** Renders results/*.json as the markdown tables README §15 promises. */
export function renderReport(runner: Runner): string {
  const lines: string[] = [
    "# Experiment results",
    "",
    "Generated from `experiments/results/*.json`. Memory-arm runs are marked *sim*.",
    "",
  ];
  for (const scenario of ["s1", "s2", "s3", "s4"] as const) {
    const file = runner.load(scenario);
    lines.push(`## ${scenario.toUpperCase()}`, "");
    if (file.trials.length === 0) {
      lines.push("_no trials recorded_", "");
      continue;
    }
    const metricNames = [...new Set(file.trials.flatMap((t) => Object.keys(t.metrics)))];
    lines.push(
      `| arm | chain | ${metricNames.join(" | ")} |`,
      `|---|---|${metricNames.map(() => "---").join("|")}|`,
    );
    for (const t of file.trials) lines.push(row(t, metricNames));
    lines.push("");
  }
  return lines.join("\n");
}

function row(t: TrialResult, names: readonly string[]): string {
  const cells = names.map((n) => {
    const m = t.metrics[n];
    return m ? `${Number.isInteger(m.value) ? m.value : m.value.toFixed(3)} ${m.unit}` : "—";
  });
  return `| ${t.arm} | ${t.onChain ? "on-chain" : "sim"} | ${cells.join(" | ")} |`;
}
