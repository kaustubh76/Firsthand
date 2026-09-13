/**
 * H2 metric: Δ_race = t_extraction_complete − t_rescind_broadcast (README §7.4).
 * Negative or zero means the rescission landed before the observer finished extracting.
 */
export interface RaceSample {
  readonly rescindBroadcastMs: number;
  readonly rescindEffectiveMs: number;
  readonly extractionCompleteMs: number | null; // null when the bot was cut off
}

export function deltaRace(sample: RaceSample): number | null {
  return sample.extractionCompleteMs === null
    ? null
    : sample.extractionCompleteMs - sample.rescindBroadcastMs;
}

export function summarise(samples: readonly RaceSample[]): {
  successRate: number;
  medianDelta: number | null;
  n: number;
} {
  const deltas = samples
    .map(deltaRace)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const successes = samples.filter(
    (s) => s.extractionCompleteMs !== null && s.extractionCompleteMs < s.rescindEffectiveMs,
  ).length;
  const median =
    deltas.length === 0 ? null : (deltas[Math.floor((deltas.length - 1) / 2)] as number);
  return {
    successRate: samples.length === 0 ? 0 : successes / samples.length,
    medianDelta: median,
    n: samples.length,
  };
}
