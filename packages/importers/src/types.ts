import {
  type Attestation,
  AttestationClass,
  type Bytes32,
  type Datum,
  type JsonValue,
  tag,
} from "@firsthand/core";

/** Known import sources; the tag is committed into every passport's attestation (README §13). */
export const ImportSource = {
  CHATGPT: "chatgpt-export-v1",
  CLAUDE: "claude-export-v1",
} as const;
export type ImportSource = (typeof ImportSource)[keyof typeof ImportSource];

export const SOURCE_TAGS: Readonly<Record<ImportSource, Bytes32>> = {
  [ImportSource.CHATGPT]: tag(ImportSource.CHATGPT),
  [ImportSource.CLAUDE]: tag(ImportSource.CLAUDE),
};

/** Provider-neutral conversation shape — what gets canonicalised into `Passport.h`. */
export interface NormalisedMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly text: string;
  /** Unix seconds; null when the export omits it. */
  readonly at: number | null;
}

export interface NormalisedConversation {
  readonly source: ImportSource;
  readonly id: string;
  readonly title: string;
  readonly createdAt: number | null;
  readonly messages: readonly NormalisedMessage[];
}

/** One deposit-ready unit: datum + attestation. Terms are chosen by the user at deposit time. */
export interface DatumInput {
  readonly conversation: NormalisedConversation;
  readonly datum: Datum;
  readonly attestation: Attestation;
}

export function toDatumInput(conversation: NormalisedConversation): DatumInput {
  const value = conversation as unknown as JsonValue;
  return {
    conversation,
    datum: { kind: "json", value },
    attestation: {
      class: AttestationClass.IMPORT,
      capturedAt: BigInt(conversation.createdAt ?? 0),
      sourceTag: SOURCE_TAGS[conversation.source],
      deviceClass: `0x${"00".repeat(32)}`,
      metaHash: `0x${"00".repeat(32)}`,
    },
  };
}
