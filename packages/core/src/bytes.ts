/**
 * Byte and hex primitives shared by every FIRSTHAND package.
 *
 * Deliberately dependency-free and allocation-light: this module is on the hot path of
 * Merkle construction and typed hashing, and it must behave identically in browsers and Node.
 */

/** `0x`-prefixed lowercase hex string. */
export type Hex = `0x${string}`;
/** A `Hex` known to encode exactly 32 bytes. */
export type Bytes32 = Hex;
/** A `Hex` known to encode exactly 20 bytes (EVM address), lowercase. */
export type Address = Hex;

const HEX_RE = /^0x(?:[0-9a-f]{2})*$/;
const ZERO_BYTES32: Bytes32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS: Address = `0x${"00".repeat(20)}`;

export const ZERO_HASH: Bytes32 = ZERO_BYTES32;
export const ZERO_ADDR: Address = ZERO_ADDRESS;

const HEX_CHARS = "0123456789abcdef";
const encoder = new TextEncoder();

/** True for a well-formed, lowercase, even-length `0x` hex string of any length (including `0x`). */
export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value);
}

/** True when `value` is hex encoding exactly `length` bytes. */
export function isHexOfLength(value: unknown, length: number): value is Hex {
  return isHex(value) && value.length === 2 + length * 2;
}

export function assertHex(value: unknown, label = "value"): asserts value is Hex {
  if (!isHex(value)) {
    throw new TypeError(`${label} must be lowercase 0x-prefixed hex, got ${describe(value)}`);
  }
}

export function assertBytes32(value: unknown, label = "value"): asserts value is Bytes32 {
  if (!isHexOfLength(value, 32)) {
    throw new TypeError(`${label} must be 32-byte hex, got ${describe(value)}`);
  }
}

export function assertAddress(value: unknown, label = "value"): asserts value is Address {
  if (!isHexOfLength(value, 20)) {
    throw new TypeError(`${label} must be a 20-byte lowercase hex address, got ${describe(value)}`);
  }
}

export function assertLength(bytes: Uint8Array, length: number, label = "bytes"): void {
  if (bytes.length !== length) {
    throw new TypeError(`${label} must be ${length} bytes, got ${bytes.length}`);
  }
}

export function hexToBytes(hex: Hex): Uint8Array {
  assertHex(hex, "hex");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    const offset = 2 + i * 2;
    out[i] = Number.parseInt(hex.slice(offset, offset + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_CHARS[b >> 4];
    out += HEX_CHARS[b & 0x0f];
  }
  return out as Hex;
}

/** Concatenates byte arrays into a single new array. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function u8(value: number): Uint8Array {
  assertUintRange(BigInt(value), 8n, "u8");
  return Uint8Array.of(value);
}

/** Big-endian unsigned 32-bit integer. */
export function u32be(value: number): Uint8Array {
  assertUintRange(BigInt(value), 32n, "u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** Big-endian unsigned 64-bit integer. */
export function u64be(value: bigint): Uint8Array {
  assertUintRange(value, 64n, "u64");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

/** Big-endian unsigned 256-bit integer, left-padded to 32 bytes (the ABI word encoding). */
export function u256be(value: bigint): Uint8Array {
  assertUintRange(value, 256n, "u256");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) {
    v = (v << 8n) | BigInt(bytes[i] as number);
  }
  return v;
}

/** Left-pads `bytes` with zeros to 32 bytes; rejects inputs longer than 32 bytes. */
export function pad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32)
    throw new TypeError(`cannot pad ${bytes.length} bytes into a 32-byte word`);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** Constant-time-ish equality for equal-length byte arrays (length mismatch returns false fast). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function assertUintRange(value: bigint, bits: bigint, label: string): void {
  if (value < 0n || value >= 1n << bits) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 24 ? `${value.slice(0, 24)}…` : value}"`;
  return typeof value;
}
