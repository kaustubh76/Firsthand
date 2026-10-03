import type { Runner } from "./harness/Runner.js";
import type { TrialResult } from "./harness/Trial.js";
import { percentile } from "./metrics/stats.js";

/** Renders results/*.json as the markdown tables README §15 promises. */
export function renderReport(runner: Runner): string {
  const lines: string[] = [
    "# Experiment results",
    "",
    "Generated from `experiments/results/*.json`. Memory-arm runs are marked *sim*.",
    "",
  ];
  for (const scenario of ["s1", "s2", "s3", "s4", "s5"] as const) {
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
    for (const t of file.trials) {
      for (const [name, values] of Object.entries(t.samples ?? {})) {
        lines.push(`- ${t.arm} · ${name}: ${distribution(values)}`);
      }
    }
    if (file.trials.some((t) => t.samples)) lines.push("");
  }
  return lines.join("\n");
}

function distribution(values: readonly (number | null)[]): string {
  const finite = values.filter((v): v is number => v !== null);
  const cutOff = values.length - finite.length;
  if (finite.length === 0) return `n=${values.length}, all cut off`;
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return `n=${values.length} (cut off ${cutOff}) min=${f(Math.min(...finite))} p50=${f(percentile(finite, 50))} p95=${f(percentile(finite, 95))} max=${f(Math.max(...finite))}`;
}

function row(t: TrialResult, names: readonly string[]): string {
  const cells = names.map((n) => {
    const m = t.metrics[n];
    return m ? `${Number.isInteger(m.value) ? m.value : m.value.toFixed(3)} ${m.unit}` : "—";
  });
  return `| ${t.arm} | ${t.onChain ? "on-chain" : "sim"} | ${cells.join(" | ")} |`;
}
