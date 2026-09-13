import { Arms } from "../arms/index.js";
import { ObserverBot } from "../bots/ObserverBot.js";
import type { Scenario } from "../harness/Runner.js";
import { summarise } from "../metrics/raceWindow.js";

/**
 * S3 — adversarial rescission (README §15 H2). An observer bot with mempool visibility races a bulk
 * extraction against the rescind broadcast; 50 trials per arm. On-chain arms land with Phase 4;
 * the memory arm exercises the bot/timing plumbing with a simulated mempool.
 */
export const s3: Scenario = {
  id: "s3",
  hypothesis: "H2",
  arms: [Arms.B2_PUBLIC_MEMPOOL, Arms.BTX, Arms.COMMIT_REVEAL],
  async run(arm, ctx) {
    const trials = ctx.dryRun ? Math.min(ctx.n, 5) : ctx.n;
    const bot = new ObserverBot({ seesMempool: arm === Arms.B2_PUBLIC_MEMPOOL, extractionMs: 400 });
    const samples = [];
    for (let i = 0; i < trials; i++) {
      samples.push(
        await bot.race({
          rescindBroadcastMs: ctx.clock.nowMs(),
          inclusionDelayMs: 500,
          clock: ctx.clock,
        }),
      );
    }
    const s = summarise(samples);
    return {
      metrics: {
        trials: { value: s.n, unit: "count" },
        extractionSuccessRate: { value: s.successRate, unit: "ratio" },
        ...(s.medianDelta === null
          ? {}
          : { medianDeltaRaceMs: { value: s.medianDelta, unit: "ms" } }),
      },
      onChain: false,
      notes: [
        "SIMULATED mempool — reports plumbing only. H2 evidence requires the Phase 4 on-chain arms.",
      ],
    };
  },
};
