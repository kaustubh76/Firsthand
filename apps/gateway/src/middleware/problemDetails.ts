import { isFirsthandError, toProblemDetails } from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Maps any thrown error to an RFC 9457 body; FirsthandErrors keep their code, others are opaque. */
export function problemDetailsHandler(logger: Logger) {
  return (error: Error, c: Context) => {
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
