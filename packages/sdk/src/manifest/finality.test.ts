import { describe, expect, it } from "vitest";
import { DEFAULT_MANIFEST_FINALITY, honestFinalityDepth } from "./finality.js";

/**
 * A manifest's `finalityDepth` is a claim its own verifier enforces, so the number has to be one the
 * anchors back. Every caller in the repo used to pass a flat `0` — no claim — under surfaces telling
 * a reader that finality had been checked; passing the default instead would make a freshly-exported
 * file fail its own check. These are the boundaries between those two mistakes.
 */
describe("honestFinalityDepth", () => {
  it("claims the depth the shallowest anchor has reached", () => {
    // Two roots, 5 and 1 blocks deep: only what the shallower one backs can be claimed.
    expect(honestFinalityDepth([95n, 99n], 100n)).toBe(1);
  });

  it("never claims more than the default, however old the anchor", () => {
    expect(honestFinalityDepth([1n], 10_000n)).toBe(DEFAULT_MANIFEST_FINALITY);
  });

  it("claims nothing for an anchor in the head block itself", () => {
    expect(honestFinalityDepth([100n], 100n)).toBe(0);
  });

  it("claims nothing without a head to measure against", () => {
    expect(honestFinalityDepth([50n], 0n)).toBe(0);
  });

  it("claims the default when there are no anchors to look at", () => {
    // An empty manifest makes no per-asset claim, so the cap is the only answer left.
    expect(honestFinalityDepth([], 100n)).toBe(DEFAULT_MANIFEST_FINALITY);
  });

  it("respects a caller's own cap", () => {
    expect(honestFinalityDepth([1n], 10_000n, 12)).toBe(12);
    expect(honestFinalityDepth([9_995n], 10_000n, 12)).toBe(5);
  });
});
