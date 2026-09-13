import { Arms } from "../arms/index.js";
import type { Scenario } from "../harness/Runner.js";

/** S2 — buyer loop (grant → 100 paid queries → manifest export). Needs Phase 3 (x402 + verify gate). */
export const s2: Scenario = {
  id: "s2",
  hypothesis: "H1",
  arms: [Arms.MEMORY],
  run(_arm, ctx) {
    return Promise.resolve({
      metrics: { queries: { value: 0, unit: "count" } },
      onChain: false,
      notes: [
        ctx.dryRun ? "dry run" : "not runnable yet",
        "S2 lands with Phase 3: GrantManager + RoyaltyRouter + gateway serve().",
      ],
    });
  },
};
