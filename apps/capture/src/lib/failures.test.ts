import { describe, expect, it } from "vitest";
import { explainFailure, failureOf, onFailure, reportFailure } from "./failures.js";
import { describeFloat, describeRollover, rolloverIn } from "./health.js";

describe("failures — the sentence a judge reads", () => {
  it("turns a decoded revert into the action to take, keeping the raw detail", () => {
    const e = Object.assign(
      new Error("relay: transaction would revert: EpochNotAttested(0x22…, 7)"),
      { code: "FH_CHAIN", context: { reason: "EpochNotAttested" } },
    );
    expect(failureOf(e)).toMatchObject({ code: "FH_CHAIN", reason: "EpochNotAttested" });
    expect(explainFailure(e)).toMatch(
      /^this epoch is not attested yet — use \*Attest this epoch\* first\. \(relay:/,
    );
    // Without context, the name is read from the message itself.
    expect(failureOf(new Error("anchor refused: DuplicateRoot")).reason).toBe("DuplicateRoot");
    expect(explainFailure(new Error("anchor refused: DuplicateRoot"))).toMatch(/already anchored/);
  });

  it("names an empty float and a rate limit, and leaves the rest alone", () => {
    const gas = Object.assign(new Error("relay: this gateway's relayer 0xr is out of gas"), {
      code: "FH_INSUFFICIENT_FUNDS",
    });
    expect(explainFailure(gas)).toMatch(/^The venue's relayer is out of gas/);
    const limited = Object.assign(
      new Error("the gateway is rate-limiting this network — retry in 9 s"),
      {
        code: "FH_RATE_LIMITED",
      },
    );
    expect(explainFailure(limited)).toBe(
      "the gateway is rate-limiting this network — retry in 9 s.",
    );
    expect(explainFailure(new Error("something else"))).toBe("something else");
    expect(explainFailure("a string")).toBe("a string");
  });

  it("fans a reported failure out to the shell", () => {
    const seen: string[] = [];
    const off = onFailure((f) => seen.push(`${f.code}:${f.reason}`));
    const text = reportFailure(Object.assign(new Error("x"), { code: "FH_INSUFFICIENT_FUNDS" }));
    expect(text).toMatch(/out of gas/);
    expect(seen).toEqual(["FH_INSUFFICIENT_FUNDS:null"]);
    off();
    reportFailure(new Error("y"));
    expect(seen).toHaveLength(1);
  });
});

describe("health — the float and the epoch clock in the strip", () => {
  it("words the float only once it matters", () => {
    expect(describeFloat(null)).toBeNull();
    expect(describeFloat({ ok: true, relayer: null })).toBeNull();
    expect(
      describeFloat({ ok: true, relayer: { address: "0xr", balanceMon: 3.2, low: false } }),
    ).toBeNull();
    expect(
      describeFloat({ ok: true, relayer: { address: "0xr", balanceMon: 0.31, low: true } }),
    ).toBe("relayer low (0.31 MON)");
    expect(describeFloat({ ok: true, relayer: { address: "0xr", balanceMon: 0, low: true } })).toBe(
      "relayer out of gas (0.000 MON)",
    );
  });

  it("announces a rollover only inside the last six hours of an epoch", () => {
    const epochs = { genesis: 1_000n, length: 604_800n };
    expect(rolloverIn(epochs, 1_000n)).toBeNull(); // a whole week left
    expect(rolloverIn(epochs, 1_000n + 604_800n - 3_600n * 5n)).toBe(3_600n * 5n);
    expect(rolloverIn(epochs, 1_000n + 604_800n - 90n)).toBe(90n);
    expect(rolloverIn(epochs, 500n)).toBeNull(); // before genesis
    expect(describeRollover(3_600n * 5n + 120n)).toBe("epoch rolls over in 5 h 2 min");
    expect(describeRollover(90n)).toBe("epoch rolls over in 1 min");
  });
});
