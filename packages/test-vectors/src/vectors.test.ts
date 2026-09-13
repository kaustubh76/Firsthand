import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allSuites, readRaw, vectorPath } from "./index.js";

describe("test-vectors", () => {
  for (const suite of allSuites()) {
    describe(suite, () => {
      it("exists on disk", () => {
        expect(existsSync(vectorPath(suite))).toBe(true);
      });

      it("validates against the envelope schema", () => {
        const file = readRaw(suite);
        expect(file.suite).toBe(suite);
        expect(file.count).toBe(file.cases.length);
      });

      it("carries at least three hand-derived cases once populated", () => {
        const file = readRaw(suite);
        if (file.cases.length === 0) return; // not yet generated
        const hand = file.cases.filter((c) => c.hand === true);
        expect(hand.length).toBeGreaterThanOrEqual(3);
      });
    });
  }
});
