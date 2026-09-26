import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl, short, txUrl } from "./explorer.js";
import { loadJournal, updateJournal } from "./journal.js";
import { mergeLedger } from "./ledgerMerge.js";
import { canonicalJson, mediaCap, metaHashOf } from "./media.js";
import { lockerLink, parseGrantRequest, parsePrincipalLink, requestLink } from "./requests.js";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

describe("journal", () => {
  beforeEach(() => store.clear());

  it("is per principal, survives a reload and tolerates garbage", () => {
    const p = `0x${"11".repeat(32)}` as const;
    expect(loadJournal(p)).toEqual({ deposits: [], grants: [], receipts: [] });
    updateJournal(p, (j) => {
      j.enrolBlock = "42";
      j.deposits.unshift({
        passportId: `0x${"aa".repeat(32)}`,
        label: "note",
        kind: "text",
        ns: 0,
        blobId: `0x${"bb".repeat(32)}`,
        at: 1,
      });
    });
    expect(loadJournal(p).enrolBlock).toBe("42");
    expect(loadJournal(`0x${"22".repeat(32)}`).deposits).toHaveLength(0);
    store.set(`firsthand.journal.${p}`, "{not json");
    expect(loadJournal(p).deposits).toEqual([]);
  });
});

describe("media metaHash", () => {
  it("commits mime, size and name in a key-sorted canonical form", () => {
    expect(canonicalJson({ size: 3, mime: "image/png", name: "a.png" })).toBe(
      '{"mime":"image/png","name":"a.png","size":3}',
    );
    const a = metaHashOf({ mime: "image/png", size: 3, name: "a.png" });
    const b = metaHashOf({ name: "a.png", size: 3, mime: "image/png" });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(metaHashOf({ mime: "image/png", size: 4, name: "a.png" })).not.toBe(a);
  });
});

describe("media cap", () => {
  it("follows the gateway's published limit, minus sealing overhead, with a floor", () => {
    expect(mediaCap(null)).toBe(6 * 1024 * 1024);
    expect(mediaCap(4 * 1024 * 1024)).toBe(4 * 1024 * 1024 - 4 * 1024);
    expect(mediaCap(1000)).toBe(64 * 1024);
  });
});

describe("explorer", () => {
  it("links Monad testnet and nothing else", () => {
    expect(txUrl(10143n, "0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(addressUrl(10143n, "0xabc")).toBe("https://testnet.monadexplorer.com/address/0xabc");
    expect(txUrl(31337n, "0xabc")).toBeNull();
    expect(short(`0x${"ab".repeat(32)}`, 4)).toBe("0xabab…abab");
  });
});

describe("grant requests", () => {
  it("parses only well-formed links and builds them back", () => {
    const card = `0x${"ca".repeat(32)}` as const;
    const pub = `0x${"9b".repeat(32)}` as const;
    const link = requestLink("https://app.example/", { card, pub, ns: 1, label: "Qwen buyer" });
    expect(link).toContain("?grant=0xca");
    const parsed = parseGrantRequest(new URL(link).search);
    expect(parsed).toMatchObject({ card, pub, ns: 1, label: "Qwen buyer" });
    expect(parseGrantRequest("?grant=0x12&pub=0x34")).toBeNull();
    expect(parseGrantRequest(`?grant=${card}&pub=${pub}&ns=99`)).toBeNull();
    expect(parseGrantRequest("")).toBeNull();
    const carded = requestLink("https://app.example", {
      card,
      pub,
      ns: 0,
      label: "x",
      agentId: "42",
    });
    expect(parseGrantRequest(new URL(carded).search)?.agentId).toBe("42");
    expect(parseGrantRequest(`?grant=${card}&pub=${pub}&agent=abc`)?.agentId).toBeUndefined();
    const principal = `0x${"77".repeat(32)}` as const;
    expect(parsePrincipalLink(new URL(lockerLink("https://app.example", principal)).search)).toBe(
      principal,
    );
    expect(parsePrincipalLink("?principal=0x12")).toBeNull();
  });
});

describe("ledger merge", () => {
  it("prefers chain rows, fills the rest from the journal, never lists a tx twice", () => {
    const p = `0x${"11".repeat(32)}` as const;
    const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
    const journal = {
      enrolTx: tx(1),
      attestTx: tx(2),
      deposits: [],
      receipts: [],
      grants: [
        {
          grantId: tx(0x99),
          granteeCard: tx(0xca),
          ns: 0,
          termsHash: tx(0x7e),
          txHash: tx(3),
          at: 0,
          rescindTx: tx(4),
        },
      ],
    };
    const chain = [
      {
        kind: "enrolled" as const,
        principalId: p,
        grantId: null,
        blockNumber: 10n,
        timestamp: 0n,
        txHash: tx(1),
      },
      {
        kind: "granted" as const,
        principalId: p,
        grantId: tx(0x99),
        blockNumber: 12n,
        timestamp: 0n,
        txHash: tx(3),
      },
      {
        kind: "granted" as const,
        principalId: tx(0x55),
        grantId: tx(0x98),
        blockNumber: 13n,
        timestamp: 0n,
        txHash: tx(9),
      },
    ];
    const rows = mergeLedger(p, chain, journal);
    expect(rows.map((r) => [r.kind, r.source, r.blockNumber])).toEqual([
      ["enrolled", "chain", 10n],
      ["granted", "chain", 12n],
      ["attested", "local", null],
      ["rescinded", "local", null],
    ]);
    expect(rows.filter((r) => r.txHash === tx(1))).toHaveLength(1);
  });
});

describe("agent binding", () => {
  it("holds only when the agent names the card and owns it", async () => {
    const { bindingHolds } = await import("./agents.js");
    const card = `0x${"ca".repeat(32)}` as const;
    const info = {
      agentId: "7",
      owner: "0xabc",
      cardId: card,
      name: "Outside agent",
      reputation: { paidQueriesHere: "0", firsthandFeedbackAll: "0" },
      registries: null,
    };
    expect(bindingHolds(info, card, "0xABC")).toBe(true);
    expect(bindingHolds(info, card, "0xdef")).toBe(false);
    expect(bindingHolds({ ...info, cardId: `0x${"cb".repeat(32)}` }, card, "0xabc")).toBe(false);
    expect(bindingHolds(null, card, "0xabc")).toBe(false);
  });
});
