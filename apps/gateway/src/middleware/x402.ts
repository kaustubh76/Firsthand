import {
  decodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
  type X402Facilitator,
} from "@firsthand/adapters";
import { PaymentError } from "@firsthand/core";
import type { Context, MiddlewareHandler } from "hono";

/**
 * x402 gate (README §8 claim 4): without a valid `X-PAYMENT` header the route answers 402 with the
 * requirements; with one, the facilitator verifies it and the payload is exposed to the handler so
 * settlement can run *after* the response is prepared (settle-on-success).
 */
export interface X402Options {
  readonly facilitator: X402Facilitator;
  readonly requirementsFor: (c: Context) => PaymentRequirements | Promise<PaymentRequirements>;
}

export interface X402Vars {
  x402Payload: PaymentPayload;
  x402Requirements: PaymentRequirements;
}

export function x402(options: X402Options): MiddlewareHandler<{ Variables: X402Vars }> {
  return async (c, next) => {
    const requirements = await options.requirementsFor(c);
    const payload = decodePaymentHeader(c.req.header("x-payment"));
    if (payload === null) {
      return c.json({ x402Version: 1, error: "payment required", accepts: [requirements] }, 402);
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
    await next();
    return undefined;
  };
}
