/**
 * Outbound request pacing for a per-second rate cap.
 *
 * Monad's public RPC answers roughly 15 requests per second from one egress and refuses the rest —
 * sometimes as HTTP 429, sometimes as a JSON-RPC error inside a 200, which viem does not retry
 * because it sees a success at the HTTP layer. A pacer belongs *in front of* that retry: a throttled
 * call costs up to five attempts and ~4.5 s of backoff, so a burst that trips the cap inflates its
 * own request count about fivefold. Preventing the breach is much cheaper than recovering from it.
 *
 * Two properties are load-bearing, and both are easy to get wrong:
 *
 *  - It paces request **starts**, not completions. That holds the issue rate at the cap whatever
 *    the RPC's latency — 480 windows at 70 ms is 34 s, not 480 round trips.
 *  - It is **two-dimensional**: a gap between starts *and* a ceiling on concurrency. The gap is what
 *    respects a per-second window; `maxInFlight` alone would let a hundred calls start at once.
 *
 * One pacer is meant to be shared by everything that talks to the same endpoint — pacing each
 * caller separately still blows a global cap. Lifted from `LogsConsentLedger`, which has used this
 * scheduler against Monad since 2026-09-16.
 */
export interface Pacer {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PacerOptions {
  /**
   * Minimum gap between call starts, in ms. The default of 80 ms is 12.5 requests/second: a
   * sliding second catches at most 13 starts, which stays under Monad's ~15 with headroom for
   * whatever else shares the egress. (70 ms would allow 15 — at the cap, not under it. The
   * ledger's historical 50 ms is 20/s, i.e. over.)
   */
  readonly minRequestIntervalMs?: number;
  /** Calls allowed in flight at once. */
  readonly maxInFlight?: number;
}

export const DEFAULT_PACE_MS = 80;
export const DEFAULT_MAX_IN_FLIGHT = 3;

export function createPacer(options: PacerOptions = {}): Pacer {
  const gap = Math.max(0, options.minRequestIntervalMs ?? DEFAULT_PACE_MS);
  const maxInFlight = Math.max(1, options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  let inFlight = 0;
  let nextStart = 0;
  const waiters: (() => void)[] = [];

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      while (inFlight >= maxInFlight) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      inFlight++;
      try {
        const now = Date.now();
        const start = Math.max(now, nextStart);
        nextStart = start + gap;
        if (start > now) await new Promise((r) => setTimeout(r, start - now));
        return await fn();
      } finally {
        inFlight--;
        waiters.shift()?.();
      }
    },
  };
}

/** A pacer that runs everything immediately — the default wherever pacing would be wrong. */
export const immediatePacer: Pacer = { run: (fn) => fn() };

/**
 * `items.map(fn)` under a pacer: the same results in the same order, without the unbounded burst
 * `Promise.all(items.map(...))` would produce. Rejections propagate as `Promise.all`'s would.
 */
export function pacedMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  pacer: Pacer,
): Promise<R[]> {
  return Promise.all(items.map((item, index) => pacer.run(() => fn(item, index))));
}
