import type { Address, Bytes32, Hex } from "@firsthand/core";
import { z } from "zod";

/**
 * x402 facilitator client (README §8 claim 4). Shapes follow the x402 v1 "exact" scheme over
 * EIP-3009 `transferWithAuthorization`; Monad runs a native facilitator.
 */
export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string().min(1),
  /** USDC base units as a decimal string. */
  maxAmountRequired: z.string().regex(/^\d+$/),
  resource: z.string().url(),
  description: z.string(),
  mimeType: z.string(),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().int().positive(),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.string().min(1),
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    authorization: z.object({
      from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      value: z.string().regex(/^\d+$/),
      validAfter: z.string().regex(/^\d+$/),
      validBefore: z.string().regex(/^\d+$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
  }),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: Address;
}

export interface SettleResponse {
  readonly success: boolean;
  readonly transaction?: Bytes32;
  readonly network: string;
  readonly errorReason?: string;
  readonly payer?: Address;
}

export interface SupportedKind {
  readonly scheme: string;
  readonly network: string;
}

export interface X402Facilitator {
  supported(): Promise<readonly SupportedKind[]>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

// Base64 without `Buffer`: this codec runs in the buyer's browser as well as in the gateway, and
// `Buffer` does not exist there (the browser tier found it as "Buffer is not defined" mid-query).
const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
const fromBase64 = (b64: string): string => {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Decodes the `X-PAYMENT` header (base64 JSON) into a validated payload; `null` when malformed. */
export function decodePaymentHeader(header: string | null | undefined): PaymentPayload | null {
  if (!header) return null;
  try {
    const parsed = PaymentPayloadSchema.safeParse(JSON.parse(fromBase64(header)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return toBase64(JSON.stringify(payload));
}

export type { Hex as X402Hex };
