import { describe, expect, it } from "vitest";
import type { Journal } from "./journal.js";
import { deriveJourney, journeyProgress } from "./journey.js";

const empty = (): Journal => ({ deposits: [], grants: [], receipts: [] });
const statuses = (steps: ReturnType<typeof deriveJourney>) =>
  Object.fromEntries(steps.map((s) => [s.id, s.status]));

describe("deriveJourney", () => {
  it("before the passkey, enrol is current and everything else is locked", () => {
    const s = statuses(
      deriveJourney({ unlocked: false, live: true, liveness: { kind: "unknown" }, journal: null }),
    );
    expect(s).toEqual({
      enrol: "current",
      activate: "blocked",
      deposit: "blocked",
      refusal: "blocked",
      recall: "blocked",
      ledger: "blocked",
      evidence: "blocked",
    });
  });
  it("unlocked and not on chain: activate is next", () => {
    const s = statuses(
      deriveJourney({
        unlocked: true,
        live: true,
        liveness: { kind: "not-enrolled" },
        journal: empty(),
      }),
    );
    expect(s["enrol"]).toBe("done");
    expect(s["activate"]).toBe("current");
    expect(s["deposit"]).toBe("todo");
  });
  it("offline blocks the chain beats but leaves the evidence reachable", () => {
    const s = statuses(
      deriveJourney({
        unlocked: true,
        live: false,
        liveness: { kind: "unknown" },
        journal: empty(),
      }),
    );
    expect(s["activate"]).toBe("blocked");
    expect(s["deposit"]).toBe("blocked");
    expect(s["evidence"]).toBe("current");
  });
  it("marks come from records, and the current beat is the first not done", () => {
    const j = empty();
    j.deposits.push({
      passportId: "0x01",
      label: "note",
      kind: "text",
      ns: 0,
      blobId: "0x02",
      at: 1,
      published: true,
    });
    j.refusalAt = 1;
    j.grants.push({
      grantId: "0x03",
      granteeCard: "0x04",
      ns: 0,
      termsHash: "0x05",
      txHash: "0x06",
      at: 1,
      rescindTx: "0x07",
    });
    j.receipts.push({
      receiptId: "0x08",
      grantId: "0x03",
      passportId: "0x01",
      txHash: null,
      paidUnits: "1000",
      at: 1,
    });
    const steps = deriveJourney({
      unlocked: true,
      live: true,
      liveness: { kind: "live", epoch: 0n, lastAttested: 0n, attestedThisEpoch: true },
      journal: j,
    });
    const s = statuses(steps);
    expect(s["deposit"]).toBe("done");
    expect(s["refusal"]).toBe("done");
    expect(s["recall"]).toBe("done");
    expect(s["ledger"]).toBe("current");
    expect(s["evidence"]).toBe("todo");
    expect(journeyProgress(steps)).toEqual({ done: 5, total: 7 });
  });
  it("a published deposit is required — a local-only one does not count", () => {
    const j = empty();
    j.deposits.push({ passportId: "0x01", label: "n", kind: "text", ns: 0, blobId: "0x02", at: 1 });
    const s = statuses(
      deriveJourney({
        unlocked: true,
        live: true,
        liveness: { kind: "live", epoch: 0n, lastAttested: 0n, attestedThisEpoch: true },
        journal: j,
      }),
    );
    expect(s["deposit"]).toBe("current");
  });
});
