import { normalizeNetwork } from "@firsthand/core";
import { z } from "zod";
import {
  type PaymentPayload,
  type PaymentRequirements,
  PaymentRequirementsSchema,
} from "../ports/X402Facilitator.js";

/**
 * x402 v2 on the wire.
 *
 * v2 (Dec 2025) renamed `maxAmountRequired` → `amount`, moved `network` to CAIP-2 and lifted
 * `resource`/`description`/`mimeType` into their own object. Monad's facilitator speaks only v2
 * ("Monad Facilitator only supports x402 version 2 and above"), so this module projects
 * FIRSTHAND's canonical requirements onto that shape and back. Nothing else in the repo has to
 * learn two vocabularies.
 */
export const PaymentRequirementsV2Schema = z.object({
  scheme: z.literal("exact"),
  /** CAIP-2, e.g. `eip155:10143`. */
  network: z.string().min(1),
  /** Atomic token units as a decimal string (v1 called this `maxAmountRequired`). */
  amount: z.string().regex(/^\d+$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().int().positive(),
  resource: z.object({
    url: z.string().url(),
    description: z.string(),
    mimeType: z.string(),
  }),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2Schema>;

/** The same requirements a v2 facilitator (or client) expects to see. */
export function toRequirementsV2(r: PaymentRequirements): PaymentRequirementsV2 {
  return {
    scheme: r.scheme,
    network: normalizeNetwork(r.network).caip2,
    amount: r.maxAmountRequired,
    asset: r.asset,
    payTo: r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    resource: { url: r.resource, description: r.description, mimeType: r.mimeType },
    ...(r.extra === undefined ? {} : { extra: r.extra }),
  };
}

/** Back to the canonical shape, keeping the legacy network spelling the rest of the repo matches on. */
export function fromRequirementsV2(v2: PaymentRequirementsV2): PaymentRequirements {
  return {
    scheme: v2.scheme,
    network: normalizeNetwork(v2.network).legacy,
    maxAmountRequired: v2.amount,
    resource: v2.resource.url,
    description: v2.resource.description,
    mimeType: v2.resource.mimeType,
    payTo: v2.payTo,
    maxTimeoutSeconds: v2.maxTimeoutSeconds,
    asset: v2.asset,
    ...(v2.extra === undefined ? {} : { extra: v2.extra }),
  };
}

/**
 * The two published v2 request envelopes disagree: the x402 specification keeps v1's
 * `{paymentPayload, paymentRequirements}` field names, while Monad's own guide shows
 * `{payload, resource, accepted}`. Which one their facilitator accepts is a measurement, not a
 * reading — `packages/adapters/test/testnet/x402-facilitator.interop.test.ts` asks it and pins the
 * answer. Until then the client tries the spec envelope first and the Monad-doc envelope second.
 */
export type FacilitatorEnvelope = "spec" | "monad-doc";
export const FACILITATOR_ENVELOPES: readonly FacilitatorEnvelope[] = ["spec", "monad-doc"];

export function facilitatorBody(
  envelope: FacilitatorEnvelope,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Record<string, unknown> {
  const v2 = toRequirementsV2(requirements);
  const body = { ...payload, x402Version: 2 as const };
  if (envelope === "spec") {
    return { x402Version: 2, paymentPayload: body, paymentRequirements: v2 };
  }
  const { resource, ...accepted } = v2;
  return { x402Version: 2, payload: body.payload, resource, accepted };
}

/** A facilitator's `/verify` answer, in either version's spelling. */
export const FacilitatorVerifySchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().nullish(),
  payer: z.string().nullish(),
});

export const FacilitatorSettleSchema = z.object({
  success: z.boolean(),
  transaction: z.string().nullish(),
  network: z.string().nullish(),
  errorReason: z.string().nullish(),
  payer: z.string().nullish(),
});

export const FacilitatorSupportedSchema = z.object({
  kinds: z
    .array(
      z.object({
        scheme: z.string(),
        network: z.string(),
        x402Version: z.number().int().optional(),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  signers: z.record(z.string(), z.array(z.string())).optional(),
  extensions: z.array(z.unknown()).optional(),
});

/**
 * Picks the entry a buyer can pay from a 402's `accepts` array. A gateway may offer the same price
 * twice — once in each version's spelling — so prefer v2 and fall back to v1 rather than trusting
 * the order.
 */
export function selectRequirements(
  accepts: readonly unknown[] | undefined,
): PaymentRequirements | null {
  for (const entry of accepts ?? []) {
    const v2 = PaymentRequirementsV2Schema.safeParse(entry);
    if (v2.success) return fromRequirementsV2(v2.data);
  }
  for (const entry of accepts ?? []) {
    const v1 = PaymentRequirementsSchema.safeParse(entry);
    if (v1.success) return v1.data;
  }
  return null;
}
