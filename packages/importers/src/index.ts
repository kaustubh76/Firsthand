export { ChatGptExportSchema, normaliseChatGpt, parseChatGpt } from "./chatgpt/parse.js";
export { ClaudeExportSchema, normaliseClaude, parseClaude } from "./claude/parse.js";
export { parseJsonl } from "./common/jsonl.js";
export { normaliseText, toUnixSeconds } from "./common/normalise.js";
export type { DatumInput, NormalisedConversation, NormalisedMessage } from "./types.js";
export { ImportSource, SOURCE_TAGS, toDatumInput } from "./types.js";

import { parseChatGpt } from "./chatgpt/parse.js";
import { parseClaude } from "./claude/parse.js";
import type { DatumInput } from "./types.js";

/** Picks the parser by source name. */
export function parseExport(source: "chatgpt" | "claude", text: string): Generator<DatumInput> {
  return source === "chatgpt" ? parseChatGpt(text) : parseClaude(text);
}
