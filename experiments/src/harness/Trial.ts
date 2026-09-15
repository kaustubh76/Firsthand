import { z } from "zod";

/** One measured run of a scenario under one arm. Serialised into results/<scenario>-<arm>.json. */
export const TrialResultSchema = z.object({
  scenario: z.enum(["s1", "s2", "s3", "s4"]),
  arm: z.string(),
  hypothesis: z.enum(["H1", "H2", "H3", "refusal"]),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  /** Scenario-specific numeric metrics, each with a unit. */
  metrics: z.record(z.string(), z.object({ value: z.number(), unit: z.string() })),
  /** True when the run exercised a real chain rather than memory doubles. */
  onChain: z.boolean(),
  notes: z.array(z.string()),
  /** Raw per-trial samples behind a metric (README §15 asks for the Δ_race distribution); null = cut off. */
  samples: z.record(z.string(), z.array(z.number().nullable())).optional(),
});
export type TrialResult = z.infer<typeof TrialResultSchema>;

export const ResultsFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  trials: z.array(TrialResultSchema),
});
export type ResultsFile = z.infer<typeof ResultsFileSchema>;
