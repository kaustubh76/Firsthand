import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttestationClass, contentHash, tag, ValidationError } from "@firsthand/core";
import { describe, expect, it } from "vitest";
import { normaliseChatGpt, parseChatGpt } from "./chatgpt/parse.js";
import { normaliseClaude, parseClaude } from "./claude/parse.js";
import { parseJsonl } from "./common/jsonl.js";
import { normaliseText, toUnixSeconds } from "./common/normalise.js";
import { ImportSource, parseExport, SOURCE_TAGS } from "./index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("ChatGPT export", () => {
  it("follows the current branch, drops empty/system-blank messages and abandoned branches", () => {
    const items = [...parseChatGpt(read("chatgpt-two.json"))];
    expect(items).toHaveLength(1); // c2 has no non-empty messages
    const c = items[0]?.conversation;
    expect(c).toMatchObject({
      source: ImportSource.CHATGPT,
      id: "c1",
      title: "Trip planning",
      createdAt: 1700000000,
    });
    expect(c?.messages).toEqual([
      { role: "user", text: "Plan a trip to Lisbon\nfor 3 days", at: 1700000001 },
      { role: "assistant", text: "Day 1: Alfama", at: 1700000002 },
    ]);
    expect(items[0]?.attestation).toMatchObject({
      class: AttestationClass.IMPORT,
      capturedAt: 1700000000n,
      sourceTag: tag("chatgpt-export-v1"),
    });
    expect(contentHash(items[0]?.datum as never)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("terminates on cyclic mappings and rejects malformed exports", () => {
    const [loop] = normaliseChatGpt(JSON.parse(read("chatgpt-cycle.json")));
    expect(loop?.messages.map((m) => m.text)).toEqual(["B", "A"]);
    expect(() => normaliseChatGpt({ nope: true })).toThrow(ValidationError);
    expect(normaliseChatGpt([{ mapping: {} }])[0]?.id).toBe("conversation-0");
  });
});

describe("Claude export", () => {
  it("maps senders, joins content blocks, ignores unknown senders and empty conversations", () => {
    const items = [...parseClaude(read("claude-two.json"))];
    expect(items).toHaveLength(1);
    const c = items[0]?.conversation;
    expect(c).toMatchObject({
      source: ImportSource.CLAUDE,
      id: "u1",
      title: "Rust borrow checker",
      createdAt: 1704164645,
    });
    expect(c?.messages).toEqual([
      { role: "user", text: "Why does this not compile?", at: 1704164645 },
      { role: "assistant", text: "Because `s` is moved.", at: 1704164649 },
    ]);
    expect(items[0]?.attestation.sourceTag).toBe(SOURCE_TAGS[ImportSource.CLAUDE]);
    expect([...parseClaude(read("claude-empty.json"))]).toHaveLength(0);
    expect(normaliseClaude(JSON.parse(read("claude-two.json")))[1]).toMatchObject({
      title: "",
      createdAt: null,
      messages: [],
    });
    expect(() => normaliseClaude([{ uuid: 1 }])).toThrow(ValidationError);
  });
});

describe("helpers", () => {
  it("parseExport routes by source; jsonl and normalisation behave", () => {
    expect([...parseExport("claude", read("claude-two.json"))]).toHaveLength(1);
    expect([...parseExport("chatgpt", read("chatgpt-two.json"))]).toHaveLength(1);
    expect([...parseJsonl('{"a":1}\n\n{"b":2}\n')]).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => [...parseJsonl("{\nnot json")]).toThrow(/line 1/);
    expect(normaliseText("a \t\r\nb  \n")).toBe("a\nb");
    expect(toUnixSeconds(12.9)).toBe(12);
    expect(toUnixSeconds("1970-01-01T00:00:10Z")).toBe(10);
    expect(toUnixSeconds("nope")).toBeNull();
    expect(toUnixSeconds(null)).toBeNull();
  });
});
