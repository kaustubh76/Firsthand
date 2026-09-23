import {
  decodePaymentHeader,
  LEGACY_PAYMENT_HEADER,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  type PaymentPayload,
  type PaymentRequirements,
  toRequirementsV2,
  type VerifiedBy,
  type X402Facilitator,
} from "@firsthand/adapters";
import { PaymentError } from "@firsthand/core";
import type { Context, MiddlewareHandler } from "hono";

/**
 * x402 gate (README §8 claim 4): without a payment header the route answers 402 with the
 * requirements; with one, the facilitator verifies it and the payload is exposed to the handler so
 * settlement can run *after* the response is prepared (settle-on-success).
 *
 * Both protocol versions are served. The 402 body carries the price twice — once in v1's spelling
 * (`maxAmountRequired`, `monad-testnet`) and once in v2's (`amount`, `eip155:10143`) — plus the v2
 * `PAYMENT-REQUIRED` header, and the payment itself is read from either header name. That is what
 * lets an off-the-shelf x402 v2 agent pay FIRSTHAND while every buyer built against v1 keeps
 * working (ADR-0014).
 */
export interface X402Options {
  readonly facilitator: X402Facilitator;
  /** May throw (e.g. NotFoundError) — errors propagate to the problem+json handler. */
  readonly requirementsFor: (c: Context) => PaymentRequirements | Promise<PaymentRequirements>;
}

export interface X402Vars {
  x402Payload: PaymentPayload;
  x402Requirements: PaymentRequirements;
  /** Which verifier answered — logged, and reported by `/healthz`. */
  x402VerifiedBy: VerifiedBy | undefined;
}

export function x402(options: X402Options): MiddlewareHandler<{ Variables: X402Vars }> {
  return async (c, next) => {
    const requirements = await options.requirementsFor(c);
    const payload = decodePaymentHeader(
      c.req.header(PAYMENT_HEADER) ?? c.req.header(LEGACY_PAYMENT_HEADER),
    );
    if (payload === null) {
      const accepts = [requirements, toRequirementsV2(requirements)];
      c.header(PAYMENT_REQUIRED_HEADER, encodeRequired({ x402Version: 2, accepts }));
      return c.json({ x402Version: 2, error: "payment required", accepts }, 402);
    }
    const verdict = await options.facilitator.verify(payload, requirements);
    if (!verdict.isValid) {
      throw new PaymentError(
        "FH_PAYMENT_INVALID",
        `payment rejected: ${verdict.invalidReason ?? "unknown"}`,
        {
          context: { reason: verdict.invalidReason },
        },
      );
    }
    c.set("x402Payload", payload);
    c.set("x402Requirements", requirements);
    c.set("x402VerifiedBy", verdict.verifiedBy);
    await next();
    return undefined;
  };
}

/** base64 JSON, the way x402 carries requirements in a header (no `Buffer`: this also runs on the edge). */
function encodeRequired(body: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
