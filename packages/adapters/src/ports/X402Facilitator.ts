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

/** Decodes the `X-PAYMENT` header (base64 JSON) into a validated payload; `null` when malformed. */
export function decodePaymentHeader(header: string | null | undefined): PaymentPayload | null {
  if (!header) return null;
  try {
    const parsed = PaymentPayloadSchema.safeParse(
      JSON.parse(Buffer.from(header, "base64").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export type { Hex as X402Hex };
