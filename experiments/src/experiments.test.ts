import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "./harness/Clock.js";
import { Runner } from "./harness/Runner.js";
import { summarise } from "./metrics/raceWindow.js";
import { renderReport } from "./report.js";
import { s1 } from "./scenarios/s1-deposit-scale.js";
import { s2 } from "./scenarios/s2-buyer-loop.js";
import { s3 } from "./scenarios/s3-rescission-race.js";
import { s4 } from "./scenarios/s4-refusal.js";

const dir = mkdtempSync(join(tmpdir(), "fh-results-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("experiments harness", () => {
  it("S4 refuses every unprovable deposit and no genuine one (precision = recall = 1)", async () => {
    const runner = new Runner({ resultsDir: dir });
    const [trial] = await runner.run(s4, { dryRun: false, n: 60 });
    expect(trial?.metrics["precision"]?.value).toBe(1);
    expect(trial?.metrics["recall"]?.value).toBe(1);
    expect(trial?.metrics["wronglyAccepted"]?.value).toBe(0);
    expect(runner.load("s4").trials).toHaveLength(1);
  }, 60_000);

  it("S1 anchors in 256-leaf batches and the manifest verifies with 8 hashes per asset", async () => {
    const runner = new Runner({ resultsDir: dir });
    const [trial] = await runner.run(s1, { dryRun: false, n: 600 });
    expect(trial?.metrics["batches"]?.value).toBe(3);
    expect(trial?.metrics["hashesPerAsset"]?.value).toBe(8);
    expect(trial?.metrics["proofBytesPerAsset"]?.value).toBe(257);
    expect(trial?.onChain).toBe(false);
    expect(trial?.metrics["verifyFullMs"]?.value).toBeGreaterThanOrEqual(
      trial?.metrics["verifyMerkleMs"]?.value ?? 0,
    );
  }, 60_000);

  it("S2/S3 dry-run and report render; race summary math", async () => {
    const clock = fixedClock();
    const runner = new Runner({ resultsDir: dir, clock });
    await runner.run(s2, { dryRun: true, n: 1 });
    const s3Trials = await runner.run(s3, { dryRun: true, n: 3 });
    const byArm = Object.fromEntries(
      s3Trials.map((t) => [t.arm, t.metrics["extractionSuccessRate"]?.value]),
    );
    expect(byArm["B2-public-mempool"]).toBe(1); // bot wins with mempool visibility (simulated)
    expect(byArm["btx"]).toBe(0);
    expect(byArm["commit-reveal"]).toBe(0);
    const report = renderReport(runner);
    expect(report).toContain("## S4");
    expect(report).toContain("| memory | sim |");
    expect(report).toContain("_no trials recorded_"); // s2/s3 were dry runs
    expect(summarise([])).toMatchObject({
      successRate: 0,
      medianDelta: null,
      p50: null,
      p95: null,
      n: 0,
      deltas: [],
      settlementsAfterConsentEnd: 0,
    });
    expect(
      summarise([
        { rescindBroadcastMs: 0, rescindEffectiveMs: 10, extractionCompleteMs: 5, detectionMs: 2 },
        {
          rescindBroadcastMs: 0,
          rescindEffectiveMs: 10,
          extractionCompleteMs: null,
          settlementsAfterConsentEnd: 3,
        },
      ]),
    ).toMatchObject({
      successRate: 0.5,
      medianDelta: 5,
      p50: 5,
      p95: 5,
      min: 5,
      max: 5,
      n: 2,
      deltas: [5, null],
      detectionLatencyP50: 2,
      inclusionDelayP50: 10,
      settlementsAfterConsentEnd: 3,
    });
  });

  it("persists raw samples next to the metrics and renders their distribution", async () => {
    const runner = new Runner({ resultsDir: dir, clock: fixedClock() });
    const trial = {
      scenario: "s3" as const,
      arm: "B2-public-mempool",
      hypothesis: "H2" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      metrics: { trials: { value: 3, unit: "count" } },
      onChain: true,
      notes: [],
      samples: { deltaRaceMs: [12, null, 40] },
    };
    (runner as unknown as { append(t: typeof trial): void }).append(trial);
    expect(runner.load("s3").trials[0]?.samples).toEqual({ deltaRaceMs: [12, null, 40] });
    const report = renderReport(runner);
    expect(report).toContain(
      "B2-public-mempool · deltaRaceMs: n=3 (cut off 1) min=12 p50=40 p95=40 max=40",
    );
  });
});
