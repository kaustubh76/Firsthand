import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressUrl, short, txUrl } from "./explorer.js";
import { loadJournal, updateJournal } from "./journal.js";
import { canonicalJson, metaHashOf } from "./media.js";

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

describe("explorer", () => {
  it("links Monad testnet and nothing else", () => {
    expect(txUrl(10143n, "0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(addressUrl(10143n, "0xabc")).toBe("https://testnet.monadexplorer.com/address/0xabc");
    expect(txUrl(31337n, "0xabc")).toBeNull();
    expect(short(`0x${"ab".repeat(32)}`, 4)).toBe("0xabab…abab");
  });
});
