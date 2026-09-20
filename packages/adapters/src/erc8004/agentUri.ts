import type { Address, Bytes32 } from "@firsthand/core";

/**
 * An ERC-8004 registration file for a FIRSTHAND buyer, carried inline as a `data:` URI so no agent
 * needs hosting to be carded. Follows the reference schema (type, name, description, services,
 * supportedTrust) and adds `firsthand` — the card and the X25519 key vault keys are wrapped to.
 */
export interface AgentRegistrationInput {
  readonly name: string;
  readonly description: string;
  readonly owner: Address;
  readonly cardId: Bytes32;
  readonly encryptionPubKey: Bytes32;
  readonly gatewayUrl?: string;
}

export function buildRegistration(input: AgentRegistrationInput): Record<string, unknown> {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: input.name,
    description: input.description,
    services: input.gatewayUrl
      ? [{ name: "firsthand-buyer", endpoint: input.gatewayUrl, version: "0.1.0" }]
      : [],
    supportedTrust: ["reputation"],
    firsthand: {
      cardId: input.cardId,
      encryptionPubKey: input.encryptionPubKey,
      owner: input.owner,
      protocol: "firsthand/0.1",
    },
  };
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export function buildAgentURI(input: AgentRegistrationInput): string {
  return `data:application/json;base64,${toBase64(JSON.stringify(buildRegistration(input)))}`;
}

/** Decodes a `data:application/json` agentURI; null for anything else (hosted URIs are not fetched here). */
export function decodeAgentURI(uri: string): Record<string, unknown> | null {
  const m = /^data:application\/json(;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    const payload = m[3] ?? "";
    const text = m[2]
      ? new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
      : decodeURIComponent(payload);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
