import type { Bytes32 } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { LogsConsentLedger } from "./LogsConsentLedger.js";

const b32 = (n: number): Bytes32 => `0x${n.toString(16).padStart(64, "0")}` as Bytes32;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

interface FakeLog {
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
}

/**
 * A public client that answers `eth_getLogs` from a scripted table and records every window it was
 * asked for, with wall-clock timing so pacing and concurrency are observable.
 */
function fakeClient(
  head: bigint,
  logs: (args: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => FakeLog[],
  latencyMs = 0,
) {
  const windows: { name: string; from: bigint; to: bigint; startedAt: number }[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = {
    getBlockNumber: async () => head,
    getLogs: async (q: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      windows.push({ name: q.event.name, from: q.fromBlock, to: q.toBlock, startedAt: Date.now() });
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      inFlight--;
      return logs(q).filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: blockNumber * 10n,
    }),
  };
  return { client: client as never, windows, peak: () => peak };
}

function ledger(
  client: never,
  extra: Partial<ConstructorParameters<typeof LogsConsentLedger>[0]> = {},
) {
  return new LogsConsentLedger({
    publicClient: client,
    principalRegistry: addr(1),
    passportAnchors: addr(2),
    grantManager: addr(3),
    receiptLedger: addr(4),
    maxRange: 100n,
    minRequestIntervalMs: 0,
    ...extra,
  });
}

describe("LogsConsentLedger — a scan the RPC will accept and a function will finish", () => {
  it("walks the window newest-first in ≤ maxRange slices that cover exactly [fromBlock, head]", async () => {
    const { client, windows } = fakeClient(1_000n, () => []);
    const out = await ledger(client).anchorsFor(b32(1), 0, { fromBlock: 650n });
    expect(out).toEqual([]);
    const slices = windows.map((w) => [w.from, w.to]);
    expect(slices).toEqual([
      [901n, 1_000n],
      [801n, 900n],
      [701n, 800n],
      [650n, 700n],
    ]);
  });

  it("keeps at most maxInFlight requests running and spaces their starts by the minimum gap", async () => {
    const { client, windows, peak } = fakeClient(1_200n, () => [], 15);
    const began = Date.now();
    await ledger(client, { maxInFlight: 3, minRequestIntervalMs: 5 }).anchorsFor(b32(1), 0, {
      fromBlock: 1n,
    });
    expect(windows).toHaveLength(12);
    expect(peak()).toBeLessThanOrEqual(3);
    // Twelve starts at least 5 ms apart (plus the head read) cannot finish inside 60 ms. (No upper
    // bound: wall-clock ceilings flake under a loaded coverage run; the in-flight cap above is the
    // deterministic half of the property.)
    expect(Date.now() - began).toBeGreaterThanOrEqual(55);
  });

  it("stops issuing windows when the budget is spent and reports how far back it reached", async () => {
    let clock = 0;
    const { client, windows } = fakeClient(1_000n, () => []);
    const l = ledger(client, {
      // Each call to `now` advances the clock 10 ms: three windows fit in a 25 ms budget.
      now: () => {
        clock += 10;
        return clock;
      },
    });
    const { events, scan } = await l.timeline(b32(1), { fromBlock: 1n, budgetMs: 25 });
    expect(events).toEqual([]);
    expect(scan.partial).toBe(true);
    expect(scan.toBlock).toBe(1_000n);
    // Newest-first: whatever was covered is the most recent history, and fromBlock names its floor.
    expect(scan.fromBlock).toBeGreaterThan(1n);
    expect(windows.every((w) => w.from >= scan.fromBlock)).toBe(true);
  });

  it("merges enrolled · attested · granted · rescinded in block order with timestamps and a report", async () => {
    const { client } = fakeClient(500n, ({ event }) => {
      if (event.name === "PrincipalEnrolled")
        return [{ args: { principalId: b32(1) }, blockNumber: 410n, transactionHash: b32(11) }];
      if (event.name === "PrincipalAttested")
        return [
          { args: { principalId: b32(1), epoch: 1n }, blockNumber: 412n, transactionHash: b32(12) },
        ];
      if (event.name === "GrantCreated")
        return [
          {
            args: {
              grantId: b32(7),
              principalId: b32(1),
              granteeCard: b32(9),
              ns: 0,
              termsHash: b32(5),
            },
            blockNumber: 450n,
            transactionHash: b32(13),
          },
        ];
      if (event.name === "GrantRescinded")
        return [
          {
            // A commit-reveal rescission: consent ended at the commit (480), the reveal landed at 481.
            args: { grantId: b32(7), effectiveBlock: 480n, viaCommitReveal: true },
            blockNumber: 481n,
            transactionHash: b32(14),
          },
        ];
      return [];
    });
    const { events, scan } = await ledger(client).timeline(b32(1), { fromBlock: 400n });
    expect(events.map((e) => [e.kind, e.blockNumber, e.timestamp])).toEqual([
      ["enrolled", 410n, 4_100n],
      ["attested", 412n, 4_120n],
      ["granted", 450n, 4_500n],
      ["rescinded", 480n, 4_800n],
    ]);
    expect(events[2]).toMatchObject({ granteeCard: b32(9), ns: 0, termsHash: b32(5) });
    // The date that matters is the commit's; the reveal's own block is reported beside it, never
    // instead of it, so a viewer can see that consent ended before the transaction that recorded it.
    expect(events[3]).toMatchObject({
      blockNumber: 480n,
      recordedBlock: 481n,
      viaCommitReveal: true,
    });
    expect(scan).toEqual({ fromBlock: 400n, toBlock: 500n, partial: false });
    // The plain timeline is the same walk without the report.
    expect(await ledger(client).consentTimeline(b32(1), { fromBlock: 400n })).toHaveLength(4);
  });

  it("leaves a direct rescission with one block, because there is only one", async () => {
    // The rescission scan is keyed off the grants this principal created, so the grant has to exist.
    const { client } = fakeClient(500n, ({ event }) => {
      if (event.name === "GrantCreated")
        return [
          {
            args: {
              grantId: b32(7),
              principalId: b32(1),
              granteeCard: b32(9),
              ns: 0,
              termsHash: b32(5),
            },
            blockNumber: 450n,
            transactionHash: b32(13),
          },
        ];
      if (event.name === "GrantRescinded")
        return [
          {
            args: { grantId: b32(7), effectiveBlock: 470n, viaCommitReveal: false },
            blockNumber: 470n,
            transactionHash: b32(14),
          },
        ];
      return [];
    });
    const { events } = await ledger(client).timeline(b32(1), { fromBlock: 400n });
    const rescinded = events.find((e) => e.kind === "rescinded");
    expect(rescinded).toMatchObject({ blockNumber: 470n, viaCommitReveal: false });
    expect(rescinded).not.toHaveProperty("recordedBlock");
  });
});
