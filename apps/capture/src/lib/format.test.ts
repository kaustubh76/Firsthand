import { describe, expect, it } from "vitest";
import { blockTime, formatBytes, formatMon, pluralise, relativeTime } from "./format.js";

describe("format", () => {
  it("relativeTime picks the coarsest honest unit", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 2_000, now)).toBe("just now");
    expect(relativeTime(now - 30_000, now)).toBe("30 s ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 d ago");
    expect(relativeTime(now - 40 * 86_400_000, now)).toMatch(/\d/);
  });
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(200 * 1024)).toBe("200 KiB");
    expect(formatBytes(4 * 1_048_576)).toBe("4.0 MiB");
  });
  it("formatMon keeps small floats visible", () => {
    expect(formatMon(0)).toBe("0 MON");
    expect(formatMon(0.0042)).toBe("0.0042 MON");
    expect(formatMon(4.07)).toBe("4.07 MON");
  });
  it("pluralise", () => {
    expect(pluralise(1, "receipt")).toBe("1 receipt");
    expect(pluralise(2, "receipt")).toBe("2 receipts");
    expect(pluralise(2, "query", "queries")).toBe("2 queries");
  });
  it("blockTime is empty for a missing timestamp", () => {
    expect(blockTime(0n)).toBe("");
    expect(blockTime("1789972942")).not.toBe("");
  });
});
