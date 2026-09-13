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
    expect(summarise([])).toEqual({ successRate: 0, medianDelta: null, n: 0 });
    expect(
      summarise([
        { rescindBroadcastMs: 0, rescindEffectiveMs: 10, extractionCompleteMs: 5 },
        { rescindBroadcastMs: 0, rescindEffectiveMs: 10, extractionCompleteMs: null },
      ]),
    ).toEqual({ successRate: 0.5, medianDelta: 5, n: 2 });
  });
});
