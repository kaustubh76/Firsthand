import { describe, expect, it } from "vitest";
import { createPacer, immediatePacer, pacedMap } from "./pacer.js";

/** Runs `n` paced calls that each take `durationMs`, recording concurrency and start times. */
async function drive(
  pacer: ReturnType<typeof createPacer>,
  n: number,
  durationMs = 5,
): Promise<{ peak: number; starts: number[] }> {
  let inFlight = 0;
  let peak = 0;
  const starts: number[] = [];
  await Promise.all(
    Array.from({ length: n }, () =>
      pacer.run(async () => {
        starts.push(Date.now());
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, durationMs));
        inFlight--;
      }),
    ),
  );
  return { peak, starts };
}

/**
 * Slack on every wall-clock *lower* bound below.
 *
 * `setTimeout(n)` promises "at least n" against libuv's cached loop clock, not against
 * `Date.now()`, and on a loaded runner the two disagree: a 60 ms sleep measured 59 ms and
 * reddened CI. These assertions are about pacing being present at roughly the right scale, not
 * about the timer being a stopwatch, so each carries a couple of milliseconds of tolerance. The
 * upper bounds already avoid wall-clock ceilings for the same reason.
 */
const TIMER_SKEW_MS = 5;

describe("createPacer", () => {
  it("never runs more than maxInFlight at once", async () => {
    const { peak } = await drive(createPacer({ maxInFlight: 3, minRequestIntervalMs: 1 }), 20);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("spaces starts by at least the minimum gap", async () => {
    // Ten starts 5 ms apart cannot finish inside 45 ms. No upper bound asserted: wall-clock
    // ceilings flake under a loaded coverage run, and the in-flight cap is the deterministic half.
    const began = Date.now();
    await drive(createPacer({ maxInFlight: 4, minRequestIntervalMs: 5 }), 10, 0);
    expect(Date.now() - began).toBeGreaterThanOrEqual(45 - TIMER_SKEW_MS);
  });

  it("paces starts rather than completions, so a slow call does not stall the queue", async () => {
    // One 60 ms call must not delay the nine behind it by 60 ms each: starts are what is spaced.
    const pacer = createPacer({ maxInFlight: 4, minRequestIntervalMs: 2 });
    const began = Date.now();
    await Promise.all([
      pacer.run(() => new Promise((r) => setTimeout(r, 60))),
      ...Array.from({ length: 9 }, () => pacer.run(async () => {})),
    ]);
    const elapsed = Date.now() - began;
    expect(elapsed).toBeGreaterThanOrEqual(60 - TIMER_SKEW_MS);
    expect(elapsed).toBeLessThan(300);
  });

  it("releases its slot when a call rejects, so one failure cannot wedge the pacer", async () => {
    const pacer = createPacer({ maxInFlight: 1, minRequestIntervalMs: 0 });
    await expect(pacer.run(() => Promise.reject(new Error("rpc")))).rejects.toThrow("rpc");
    await expect(pacer.run(async () => "after")).resolves.toBe("after");
  });

  it("defaults to a rate inside Monad's ~15 requests/second window", async () => {
    // Five starts at the 80 ms default is 320 ms of spacing — 12.5/s, under the cap with headroom.
    const began = Date.now();
    await drive(createPacer(), 5, 0);
    expect(Date.now() - began).toBeGreaterThanOrEqual(300 - TIMER_SKEW_MS);
  });
});

describe("pacedMap", () => {
  it("keeps input order and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pacedMap(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return n * 2;
      },
      createPacer({ maxInFlight: 2, minRequestIntervalMs: 1 }),
    );
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates a rejection like Promise.all", async () => {
    await expect(
      pacedMap(
        [1, 2],
        async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        },
        createPacer({ minRequestIntervalMs: 0 }),
      ),
    ).rejects.toThrow("boom");
  });
});

describe("immediatePacer", () => {
  it("runs without spacing, for the paths where pacing would be wrong", async () => {
    const began = Date.now();
    await pacedMap([1, 2, 3, 4, 5], async (n) => n, immediatePacer);
    expect(Date.now() - began).toBeLessThan(50);
  });
});
