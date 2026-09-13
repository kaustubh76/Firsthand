import { type Bytes32, utf8 } from "../bytes.js";
import { ValidationError } from "../errors.js";
import { keccak256Hex } from "../hash.js";
import type { Datum, JsonValue } from "./types.js";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Object keys sorted by UTF-16 code units (JavaScript's default string ordering).
 * - Strings serialised exactly as ECMAScript `JSON.stringify` (RFC 8785 §3.2.2.2 defers to it).
 * - Numbers serialised per ECMAScript `Number::toString`; non-finite numbers are rejected.
 * - No whitespace.
 *
 * Only used to derive `Passport.h` for structured data; contracts never see plaintext.
 */
export function jcs(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError("jcs: non-finite numbers are not representable");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => jcs(assertJsonValue(v))).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const v = value[key];
        if (v === undefined) {
          throw new ValidationError(
            `jcs: undefined is not a JSON value (key ${JSON.stringify(key)})`,
          );
        }
        parts.push(`${JSON.stringify(key)}:${jcs(assertJsonValue(v))}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new ValidationError(`jcs: unsupported value type ${typeof value}`);
  }
}

function assertJsonValue(value: unknown): JsonValue {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new ValidationError(`jcs: ${typeof value} is not a JSON value`);
  }
  return value as JsonValue;
}

/** `Passport.h`: keccak256 of raw bytes, or of the UTF-8 JCS form for structured data. */
export function contentHash(datum: Datum): Bytes32 {
  switch (datum.kind) {
    case "bytes":
      return keccak256Hex(datum.bytes);
    case "json":
      return keccak256Hex(utf8(jcs(datum.value)));
    default: {
      const never: never = datum;
      throw new ValidationError(`contentHash: unknown datum kind ${JSON.stringify(never)}`);
    }
  }
}
