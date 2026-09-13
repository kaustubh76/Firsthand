import { ConfigError } from "@firsthand/core";
import type { z } from "zod";

/**
 * Validates configuration against a zod schema and aggregates every problem into one `ConfigError`,
 * so a misconfigured service fails at boot with a complete list rather than one field at a time.
 */
export function loadEnv<T>(
  schema: z.ZodType<T>,
  source: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ConfigError(`invalid configuration:\n  - ${problems.join("\n  - ")}`, {
    context: { problems },
  });
}
