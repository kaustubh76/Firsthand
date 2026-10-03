import type { ConsentEvent } from "@firsthand/adapters/client";
import { GrantStatus } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { fetchGrantExpiries, fetchGrantStatuses, grantStatusLabel, grantView } from "./grants.js";
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
    const { statuses, rateLimited } = await fetchGrantStatuses(statusOf, [
      grant,
      { ...grant, grantId: "0xbad" },
    ]);
    expect(statuses.get("0x01")).toBe("withdrawn");
    expect(statuses.get("0xbad")).toBe("unknown");
    expect(rateLimited).toBe(false);
  });

  it("never asks the chain about a grant this browser already withdrew", async () => {
    const asked: string[] = [];
    const { statuses } = await fetchGrantStatuses(
      async (id) => {
        asked.push(id);
        return GrantStatus.ACTIVE;
      },
      [
        { ...grant, rescindTx: "0x09" },
        { ...grant, grantId: "0x02" },
      ],
    );
    // A withdrawal is settled; the chain cannot contradict it, so it is not worth a read.
    expect(asked).toEqual(["0x02"]);
    expect(statuses.get("0x01")).toBe("withdrawn");
  });

  it("reports a rate limit as a rate limit, not as a status", async () => {
    // Monad answers over its window with a JSON-RPC error inside a 200. Recording that as
    // "unknown" would render a refused read as though the chain had answered.
    const { statuses, rateLimited } = await fetchGrantStatuses(async () => {
      throw new Error("request failed: requests limited to 15/sec");
    }, [grant]);
    expect(rateLimited).toBe(true);
    expect(statuses.has("0x01")).toBe(false);
  });
});

describe("fetchGrantExpiries", () => {
  it("derives the lapse epoch from epochStart + term", async () => {
    const m = await fetchGrantExpiries(
      async (id) => (id === "0x01" ? { epochStart: 5n, term: 4n } : null),
      [grant, { ...grant, grantId: "0x02" }],
    );
    expect(m.get("0x01")).toBe(9n);
    // A grant the chain does not know is simply absent, never a zero the row would print.
    expect(m.has("0x02")).toBe(false);
  });

  it("uses the window this browser recorded instead of reading the chain", async () => {
    let reads = 0;
    const m = await fetchGrantExpiries(async () => {
      reads++;
      return { epochStart: 99n, term: 99n };
    }, [{ ...grant, epochStart: "5", term: "4" }]);
    // The app chose the window when it granted; asking for it again cost four eth_calls a grant.
    expect(m.get("0x01")).toBe(9n);
    expect(reads).toBe(0);
  });

  it("never throws on a failed read", async () => {
    const m = await fetchGrantExpiries(async () => {
      throw new Error("rpc");
    }, [grant]);
    expect(m.size).toBe(0);
  });
});
