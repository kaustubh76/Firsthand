/** Nearest-rank percentile over a sample (p in 0..100); 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

/** `percentile` that reports null instead of 0 for an empty sample. */
export function percentileOrNull(values: readonly number[], p: number): number | null {
  return values.length === 0 ? null : percentile(values, p);
}
