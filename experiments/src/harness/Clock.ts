/** Monotonic clock abstraction so trials are reproducible under test. */
export interface Clock {
  nowMs(): number;
  /** Unix seconds — feeds the locker's epoch. */
  nowSec(): bigint;
}

export const systemClock: Clock = {
  nowMs: () => performance.now(),
  nowSec: () => BigInt(Math.floor(Date.now() / 1000)),
};

export function fixedClock(
  startMs = 0,
  sec = 1_800_000_000n,
): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    nowMs: () => t,
    nowSec: () => sec,
    advance: (ms) => {
      t += ms;
    },
  };
}
