import { describe, expect, it } from "vitest";
import { honestFinalityDepth } from "./manifest.js";

const ROOT = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const anchors = (blocks: Record<string, bigint | null>) => ({
  anchorBlock: async (root: string) => blocks[root] ?? null,
});

describe("honestFinalityDepth", () => {
  it("claims the depth the shallowest anchor has reached", () => {
    // Two roots, 5 and 1 blocks deep: the file can only claim what the shallower one backs.
    return expect(
      honestFinalityDepth(anchors({ [ROOT(1)]: 95n, [ROOT(2)]: 99n }), [ROOT(1), ROOT(2)], 100n),
    ).resolves.toBe(1);
  });

  it("never claims more than the SDK's default, however old the anchor", async () => {
    expect(await honestFinalityDepth(anchors({ [ROOT(1)]: 1n }), [ROOT(1)], 10_000n)).toBe(2);
  });

  it("claims nothing when it has nothing to go on", async () => {
    // No chain to read a head from, and an anchor the writer cannot find.
    expect(await honestFinalityDepth(anchors({ [ROOT(1)]: 1n }), [ROOT(1)], 0n)).toBe(0);
    expect(await honestFinalityDepth(anchors({}), [ROOT(1)], 100n)).toBe(0);
  });

  it("claims nothing for an anchor in the head block itself", async () => {
    expect(await honestFinalityDepth(anchors({ [ROOT(1)]: 100n }), [ROOT(1)], 100n)).toBe(0);
  });

  it("reads each distinct root once", async () => {
    let calls = 0;
    const counting = {
      anchorBlock: async () => {
        calls += 1;
        return 90n;
      },
    };
    await honestFinalityDepth(counting, [ROOT(1), ROOT(1), ROOT(1)], 100n);
    expect(calls).toBe(1);
  });
});
