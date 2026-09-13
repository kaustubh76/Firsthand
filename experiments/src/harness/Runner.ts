import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, noopLogger } from "@firsthand/runtime";
import type { Clock } from "./Clock.js";
import { systemClock } from "./Clock.js";
import { type ResultsFile, ResultsFileSchema, type TrialResult } from "./Trial.js";

export interface Scenario {
  readonly id: TrialResult["scenario"];
  readonly hypothesis: TrialResult["hypothesis"];
  readonly arms: readonly string[];
  run(
    arm: string,
    ctx: RunContext,
  ): Promise<Omit<TrialResult, "scenario" | "arm" | "hypothesis" | "startedAt" | "durationMs">>;
}

export interface RunContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dryRun: boolean;
  /** Scale knob (e.g. passports for S1, trials for S3). */
  readonly n: number;
}

export interface RunnerOptions {
  readonly resultsDir: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/** Runs scenarios across arms and appends trials to results/<scenario>.json. */
export class Runner {
  readonly #dir: string;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(options: RunnerOptions) {
    this.#dir = options.resultsDir;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    mkdirSync(this.#dir, { recursive: true });
  }

  async run(
    scenario: Scenario,
    ctx: Omit<RunContext, "clock" | "logger">,
    arms: readonly string[] = scenario.arms,
  ): Promise<TrialResult[]> {
    const out: TrialResult[] = [];
    for (const arm of arms) {
      const startedAt = new Date().toISOString();
      const t0 = this.#clock.nowMs();
      this.#logger.info("trial start", {
        scenario: scenario.id,
        arm,
        n: ctx.n,
        dryRun: ctx.dryRun,
      });
      const partial = await scenario.run(arm, { ...ctx, clock: this.#clock, logger: this.#logger });
      const trial: TrialResult = {
        scenario: scenario.id,
        arm,
        hypothesis: scenario.hypothesis,
        startedAt,
        durationMs: this.#clock.nowMs() - t0,
        ...partial,
      };
      this.#logger.info("trial done", { scenario: scenario.id, arm, metrics: trial.metrics });
      out.push(trial);
      if (!ctx.dryRun) this.append(trial);
    }
    return out;
  }

  load(scenario: TrialResult["scenario"]): ResultsFile {
    const path = join(this.#dir, `${scenario}.json`);
    try {
      return ResultsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return { version: 1, generatedAt: new Date().toISOString(), trials: [] };
    }
  }

  private append(trial: TrialResult): void {
    const file = this.load(trial.scenario);
    file.trials.push(trial);
    file.generatedAt = new Date().toISOString();
    writeFileSync(join(this.#dir, `${trial.scenario}.json`), `${JSON.stringify(file, null, 2)}\n`);
  }
}
