import { percentile, percentileOrNull } from "./stats.js";

/**
 * H2 metric: Δ_race = t_extraction_complete − t_rescind_broadcast (README §7.4).
 * Negative or zero means the rescission landed before the observer finished extracting.
 * `rescindEffectiveMs` is when consent ended (inclusion; the commit block for commit-reveal).
 */
export interface RaceSample {
  readonly rescindBroadcastMs: number;
  readonly rescindEffectiveMs: number;
  /**
   * When the bot's first extraction that was ordered *before* the effective point landed; null when
   * the bot was cut off. Non-null therefore means the extraction succeeded — on chain, ordering is
   * decided by (block, index), so a same-block success carries the block's time.
   */
  readonly extractionCompleteMs: number | null;
  /** Extractions that landed before consent ended (the burst size the signal bought the bot). */
  readonly extractions?: number;
  /** Queries the bot paid for during the trial, successful or not (the price of extracting blind). */
  readonly queriesPaid?: number;
  /** When the bot first saw the rescission in the mempool (public arms); null when it had no signal. */
  readonly detectionMs?: number | null;
  /** Settlements that landed after consent ended — post-consent receipts (commit-reveal accountability). */
  readonly settlementsAfterConsentEnd?: number;
}

export function deltaRace(sample: RaceSample): number | null {
  return sample.extractionCompleteMs === null
    ? null
    : sample.extractionCompleteMs - sample.rescindBroadcastMs;
}

export interface RaceSummary {
  readonly n: number;
  readonly successRate: number;
  readonly deltas: readonly (number | null)[];
  readonly p50: number | null;
  readonly p95: number | null;
  readonly min: number | null;
  readonly max: number | null;
  /** Alias of p50 (nearest-rank), kept for the original H2 wording. */
  readonly medianDelta: number | null;
  readonly detectionLatencyP50: number | null;
  readonly inclusionDelayP50: number;
  readonly settlementsAfterConsentEnd: number;
  readonly extractionsP50: number;
  readonly queriesPaidP50: number;
}

export function summarise(samples: readonly RaceSample[]): RaceSummary {
  const deltas = samples.map(deltaRace);
  const finite = deltas.filter((d): d is number => d !== null);
  const successes = samples.filter((s) => s.extractionCompleteMs !== null).length;
  const detections = samples
    .map((s) => (s.detectionMs == null ? null : s.detectionMs - s.rescindBroadcastMs))
    .filter((d): d is number => d !== null);
  const inclusion = samples.map((s) => s.rescindEffectiveMs - s.rescindBroadcastMs);
  const p50 = percentileOrNull(finite, 50);
  return {
    n: samples.length,
    successRate: samples.length === 0 ? 0 : successes / samples.length,
    deltas,
    p50,
    p95: finite.length === 0 ? null : percentile(finite, 95),
    min: finite.length === 0 ? null : Math.min(...finite),
    max: finite.length === 0 ? null : Math.max(...finite),
    medianDelta: p50,
    detectionLatencyP50: percentileOrNull(detections, 50),
    inclusionDelayP50: percentile(inclusion, 50),
    settlementsAfterConsentEnd: samples.reduce(
      (acc, s) => acc + (s.settlementsAfterConsentEnd ?? 0),
      0,
    ),
    extractionsP50: percentile(
      samples.map((s) => s.extractions ?? (s.extractionCompleteMs === null ? 0 : 1)),
      50,
    ),
    queriesPaidP50: percentile(
      samples.map((s) => s.queriesPaid ?? 0),
      50,
    ),
  };
}
