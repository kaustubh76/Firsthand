import { GrantError } from "@firsthand/core";
import type { RateLimiter } from "@firsthand/runtime";
import type { MiddlewareHandler } from "hono";

/**
 * Gateway pre-filter (README §7.5). The chain-side counter in ReceiptLedger is the source of truth;
 * this only shields the serving path from bulk scraping between settlements.
 */
export function rateLimit(
  limiter: RateLimiter,
  keyOf: (headers: Headers, ip: string) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const decision = await limiter.consume(keyOf(c.req.raw.headers, ip));
    c.header("x-ratelimit-remaining", String(decision.remaining));
    if (!decision.allowed) {
      c.header(
        "retry-after",
        String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))),
      );
      throw new GrantError("FH_RATE_LIMITED", "rate limit exceeded", { retryable: true });
    }
    await next();
  };
}
