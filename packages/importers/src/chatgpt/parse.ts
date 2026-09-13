import { ValidationError } from "@firsthand/core";
import { z } from "zod";
import { normaliseText, toUnixSeconds } from "../common/normalise.js";
import {
  type DatumInput,
  ImportSource,
  type NormalisedConversation,
  type NormalisedMessage,
  toDatumInput,
} from "../types.js";

/**
 * ChatGPT data export (`conversations.json`): an array of conversations whose messages form a tree
 * under `mapping`. We follow the `current_node` chain back to the root to get the displayed branch.
 */
const NodeSchema = z.object({
  id: z.string(),
  parent: z.string().nullable().optional(),
  message: z
    .object({
      author: z.object({ role: z.string() }),
      create_time: z.number().nullable().optional(),
      content: z
        .object({ content_type: z.string().optional(), parts: z.array(z.unknown()).optional() })
        .optional(),
    })
    .nullable()
    .optional(),
});

const ConversationSchema = z.object({
  id: z.string().optional(),
  conversation_id: z.string().optional(),
  title: z.string().nullable().optional(),
  create_time: z.number().nullable().optional(),
  current_node: z.string().nullable().optional(),
  mapping: z.record(z.string(), NodeSchema),
});

export const ChatGptExportSchema = z.array(ConversationSchema);

const ROLE: Record<string, NormalisedMessage["role"]> = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

function partsToText(parts: readonly unknown[] | undefined): string {
  if (!parts) return "";
  return parts.map((p) => (typeof p === "string" ? p : "")).join("\n");
}

export function normaliseChatGpt(raw: unknown): NormalisedConversation[] {
  const parsed = ChatGptExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("chatgpt export: unexpected shape", {
      context: { issues: parsed.error.issues.slice(0, 3) },
    });
  }
  return parsed.data.map((c, index) => {
    const id = c.conversation_id ?? c.id ?? `conversation-${index}`;
    const messages: NormalisedMessage[] = [];
    let cursor = c.current_node ?? null;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = c.mapping[cursor];
      if (!node) break;
      const m = node.message;
      if (m && ROLE[m.author.role] && m.content?.content_type !== "model_editable_context") {
        const text = normaliseText(partsToText(m.content?.parts));
        if (text !== "") {
          messages.push({
            role: ROLE[m.author.role] as NormalisedMessage["role"],
            text,
            at: toUnixSeconds(m.create_time),
          });
        }
      }
      cursor = node.parent ?? null;
    }
    messages.reverse();
    return {
      source: ImportSource.CHATGPT,
      id,
      title: c.title ?? "",
      createdAt: toUnixSeconds(c.create_time),
      messages,
    };
  });
}

export function* parseChatGpt(text: string): Generator<DatumInput> {
  for (const conversation of normaliseChatGpt(JSON.parse(text))) {
    if (conversation.messages.length > 0) yield toDatumInput(conversation);
  }
}
