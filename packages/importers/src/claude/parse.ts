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

/** Claude data export (`conversations.json`): flat `chat_messages` per conversation. */
const MessageSchema = z.object({
  uuid: z.string().optional(),
  text: z.string().optional(),
  sender: z.string(),
  created_at: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});

const ConversationSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  chat_messages: z.array(MessageSchema),
});

export const ClaudeExportSchema = z.array(ConversationSchema);

const ROLE: Record<string, NormalisedMessage["role"]> = { human: "user", assistant: "assistant" };

export function normaliseClaude(raw: unknown): NormalisedConversation[] {
  const parsed = ClaudeExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("claude export: unexpected shape", {
      context: { issues: parsed.error.issues.slice(0, 3) },
    });
  }
  return parsed.data.map((c) => ({
    source: ImportSource.CLAUDE,
    id: c.uuid,
    title: c.name ?? "",
    createdAt: toUnixSeconds(c.created_at),
    messages: c.chat_messages.flatMap((m): NormalisedMessage[] => {
      const role = ROLE[m.sender];
      if (!role) return [];
      // Newer exports leave `text` empty and carry the message in `content` blocks.
      const raw =
        m.text !== undefined && m.text !== ""
          ? m.text
          : (m.content ?? []).map((b) => b.text ?? "").join("\n");
      const text = normaliseText(raw);
      return text === "" ? [] : [{ role, text, at: toUnixSeconds(m.created_at) }];
    }),
  }));
}

export function* parseClaude(text: string): Generator<DatumInput> {
  for (const conversation of normaliseClaude(JSON.parse(text))) {
    if (conversation.messages.length > 0) yield toDatumInput(conversation);
  }
}
