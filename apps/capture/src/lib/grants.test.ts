import type { ConsentEvent } from "@firsthand/adapters/client";
import { GrantStatus } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { fetchGrantStatuses, grantStatusLabel, grantView } from "./grants.js";
import type { GrantEntry } from "./journal.js";

const grant: GrantEntry = {
  grantId: "0x01",
  granteeCard: "0x02",
  ns: 0,
  termsHash: "0x03",
  txHash: "0x04",
  at: 1,
};

describe("grants", () => {
  it("maps the contract's enum to words", () => {
    expect(grantStatusLabel(GrantStatus.ACTIVE)).toBe("live");
    expect(grantStatusLabel(GrantStatus.RESCINDED)).toBe("withdrawn");
    expect(grantStatusLabel(GrantStatus.EXPIRED)).toBe("expired");
    expect(grantStatusLabel(GrantStatus.FROZEN)).toBe("frozen");
    expect(grantStatusLabel(GrantStatus.NONE)).toBe("unknown");
  });
  it("the journal's own rescission wins immediately", () => {
    expect(grantView({ ...grant, rescindTx: "0x05" }, [], "live").status).toBe("withdrawn");
  });
  it("a rescinded event from the gateway counts too", () => {
    const ev: ConsentEvent = {
      kind: "rescinded",
      principalId: "0x09",
      grantId: "0x01",
      blockNumber: 5n,
      timestamp: 1n,
      txHash: "0x06",
    };
    expect(grantView(grant, [ev], null).status).toBe("withdrawn");
  });
  it("the chain refines live grants; an unknown read stays live", () => {
    expect(grantView(grant, [], null).status).toBe("live");
    expect(grantView(grant, [], "unknown").status).toBe("live");
    expect(grantView(grant, [], "expired")).toEqual({ status: "expired", tone: "warn" });
  });
  it("fetchGrantStatuses never throws", async () => {
    const statusOf = async (id: string) => {
      if (id === "0xbad") throw new Error("rpc");
      return GrantStatus.RESCINDED;
    };
    const m = await fetchGrantStatuses(statusOf, ["0x01", "0xbad"]);
    expect(m.get("0x01")).toBe("withdrawn");
    expect(m.get("0xbad")).toBe("unknown");
  });
});
