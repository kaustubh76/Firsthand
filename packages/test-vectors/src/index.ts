import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  SUITES,
  type Suite,
  type VectorCase,
  type VectorFile,
  VectorFileSchema,
} from "./schema.js";

export type { Suite, VectorCase, VectorFile } from "./schema.js";
export { SUITES, VectorCaseSchema, VectorFileSchema } from "./schema.js";

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "recordings");

/** Absolute path of a suite's JSON file. Exposed so generators write to exactly one place. */
export function vectorPath(suite: Suite, version = 1): string {
  return join(VECTORS_DIR, `${suite}.v${version}.json`);
}

/**
 * Typed case: `input` and `expected` are narrowed by the caller-supplied zod schemas so that
 * tests fail loudly on malformed vectors rather than on confusing assertion diffs.
 */
export interface TypedCase<I, E> {
  readonly name: string;
  readonly hand: boolean;
  readonly input: I;
  readonly expected: E;
}

export interface TypedVectorFile<I, E, X = Record<string, unknown>> {
  readonly suite: Suite;
  readonly version: number;
  readonly generator: string;
  readonly cases: readonly TypedCase<I, E>[];
  readonly extra: X;
}

export interface LoadOptions<I, E, X> {
  readonly input: z.ZodType<I>;
  readonly expected: z.ZodType<E>;
  readonly extra?: z.ZodType<X>;
  readonly version?: number;
}

/** Reads, envelope-validates and case-validates a suite. Throws with a precise path on failure. */
export function loadVectors<I, E, X = Record<string, unknown>>(
  suite: Suite,
  options: LoadOptions<I, E, X>,
): TypedVectorFile<I, E, X> {
  const raw = readRaw(suite, options.version);
  const cases = raw.cases.map((c: VectorCase, i: number): TypedCase<I, E> => {
    const input = options.input.safeParse(c.input);
    if (!input.success) {
      throw new Error(`${suite}#${i} (${c.name}) input invalid: ${input.error.message}`);
    }
    const expected = options.expected.safeParse(c.expected);
    if (!expected.success) {
      throw new Error(`${suite}#${i} (${c.name}) expected invalid: ${expected.error.message}`);
    }
    return { name: c.name, hand: c.hand ?? false, input: input.data, expected: expected.data };
  });
  const extra = options.extra
    ? options.extra.parse(raw.extra ?? {})
    : ((raw.extra ?? {}) as unknown as X);
  return { suite, version: raw.version, generator: raw.generator, cases, extra };
}

/** Envelope-only read, used by the self-test and by generators' `--check` mode. */
export function readRaw(suite: Suite, version = 1): VectorFile {
  const text = readFileSync(vectorPath(suite, version), "utf8");
  return VectorFileSchema.parse(JSON.parse(text));
}

/** Deterministic serialisation used by every generator: sorted keys, 2-space indent, trailing newline. */
export function serialiseVectorFile(file: VectorFile): string {
  return `${JSON.stringify(sortKeysDeep(file), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Suites that must exist on disk — used by the self-test so a missing file is caught early. */
export function allSuites(): readonly Suite[] {
  return SUITES;
}

/**
 * Bytes that came from somewhere real — a handset, a published endpoint — committed verbatim.
 *
 * Kept apart from the generated suites because `vectors:check` regenerates those and fails on any
 * difference; a recording cannot be regenerated, which is the entire point of it. Every recording
 * carries its provenance inline and is asserted by a test rather than trusted. See
 * `recordings/README.md`.
 */
export function recordingPath(name: string, version = 1): string {
  return join(RECORDINGS_DIR, `${name}.v${version}.json`);
}

/** Reads a recording and narrows it with the caller's schema. Throws with the file path on failure. */
export function loadRecording<T>(name: string, schema: z.ZodType<T>, version = 1): T {
  const path = recordingPath(name, version);
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new Error(`${path} is not the recording it claims: ${parsed.error.message}`);
  return parsed.data;
}
