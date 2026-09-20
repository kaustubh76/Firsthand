import { classifySendError } from "@firsthand/adapters";
import { isFirsthandError, type ProblemDetails, toProblemDetails } from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Maps any thrown error to an RFC 9457 body; FirsthandErrors keep their code, others are opaque —
 * except a chain RPC saying "too many requests", which is the RPC's state, not a bug: it becomes a
 * 503 with `retry-after`, so a reader retries instead of reporting a 500.
 */
export function problemDetailsHandler(logger: Logger) {
  return (error: Error, c: Context) => {
    if (!isFirsthandError(error) && classifySendError(error).kind === "rpc") {
      logger.warn("chain rpc unavailable", {
        path: c.req.path,
        detail: classifySendError(error).detail,
      });
      const problem: ProblemDetails = {
        type: "urn:firsthand:error:fh_chain",
        title: "ChainError",
        status: 503,
        detail: "the chain RPC is rate-limiting this gateway — retry in a moment",
        code: "FH_CHAIN",
        retryable: true,
      };
      return c.json(problem, 503, {
        "content-type": "application/problem+json",
        "retry-after": "2",
      });
    }
    const problem = toProblemDetails(error);
    if (isFirsthandError(error)) {
      logger.warn("request failed", { code: error.code, path: c.req.path, context: error.context });
    } else {
      logger.error("unhandled error", { path: c.req.path, error });
    }
    return c.json(problem, problem.status as ContentfulStatusCode, {
      "content-type": "application/problem+json",
    });
  };
}
