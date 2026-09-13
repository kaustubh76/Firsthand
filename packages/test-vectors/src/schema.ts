import { z } from "zod";

/**
 * Every vector file has the same envelope so that a single loader (TypeScript) and a single
 * `stdJson` access pattern (Solidity) can consume all suites.
 *
 * Conventions inside `input` / `expected`:
 * - integers are decimal strings (JSON numbers cannot hold uint256),
 * - byte strings are `0x`-prefixed lowercase hex,
 * - arrays are plain JSON arrays,
 * - keys are sorted alphabetically (Foundry's JSON parser is order-sensitive for structs).
 */
export const VectorCaseSchema = z.object({
  /** Stable, human-readable identifier, e.g. "hand/half-half-even". */
  name: z.string().min(1),
  /** True when `expected` was derived by hand or by an independent route (not the implementation). */
  hand: z.boolean().optional(),
  input: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
});

export const VectorFileSchema = z
  .object({
    suite: z.string().min(1),
    version: z.number().int().positive(),
    /** Repo-relative path of the generator that produced the file. */
    generator: z.string().min(1),
    count: z.number().int().nonnegative(),
    cases: z.array(VectorCaseSchema),
    /** Suite-specific extras (e.g. Merkle zero hashes). */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((f) => f.count === f.cases.length, {
    message: "count must equal cases.length",
    path: ["count"],
  })
  .refine((f) => new Set(f.cases.map((c) => c.name)).size === f.cases.length, {
    message: "case names must be unique",
    path: ["cases"],
  });

export type VectorCase = z.infer<typeof VectorCaseSchema>;
export type VectorFile = z.infer<typeof VectorFileSchema>;

/** Known suites. Adding a suite means adding it here, its file, and its generator. */
export const SUITES = [
  "split-math",
  "merkle",
  "passport",
  "keys",
  "envelope",
  "p256-signatures",
] as const;
export type Suite = (typeof SUITES)[number];
