import { FirsthandError } from "../errors.js";

/**
 * A strict DER reader — the substrate for hardware capture attestation (README §13, ADR-0015).
 *
 * Deliberately *not* a general ASN.1 library. It reads one tag-length-value at a time and lets
 * callers walk a structure positionally, because that is the only sound way to locate a field
 * inside a certificate: an Android attestation leaf carries `attestationChallenge`, up to 128
 * bytes of **caller-supplied data that Google signs without inspecting**. Locating a field by
 * scanning for a byte pattern — or by trusting a caller-supplied offset and checking a prefix
 * there — lets an attacker embed a lookalike inside that challenge and have it read as the real
 * field. Every accessor here therefore descends the structure rather than searching it.
 *
 * Strict in the DER sense, not the BER sense: indefinite lengths, non-minimal lengths and
 * non-minimal high-tag-number forms are all rejected, so a given structure has exactly one
 * encoding and two readers cannot disagree about it. The Solidity twin
 * (`contracts/src/libraries/Der.sol`) implements the same rules over the same vectors, minus the
 * high-tag-number form it never needs.
 */

/** Universal tag numbers this codebase reads. */
export const Tag = {
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  OBJECT_IDENTIFIER: 6,
  ENUMERATED: 10,
  SEQUENCE: 16,
  SET: 17,
} as const;

/** Tag classes, as encoded in the top two bits of the identifier octet. */
export const TagClass = {
  UNIVERSAL: 0,
  APPLICATION: 1,
  CONTEXT: 2,
  PRIVATE: 3,
} as const;

/** The largest length this reader will accept — far above any certificate, well below overflow. */
const MAX_LENGTH = 1 << 24;
/** The largest tag number this reader will accept; Android's `rootOfTrust` is 704. */
const MAX_TAG_NUMBER = 1 << 24;

const HIGH_TAG_FORM = 0x1f;
const CONTINUATION = 0x80;

export interface Tlv {
  /** `TagClass.*` — universal, application, context or private. */
  readonly tagClass: number;
  /** True when the content is itself a sequence of TLVs. */
  readonly constructed: boolean;
  /** The tag number, decoded from either the short or the high-tag-number form. */
  readonly tagNumber: number;
  /** Offset of the identifier octet. */
  readonly start: number;
  /** Offset of the first content byte. */
  readonly contentStart: number;
  readonly contentLength: number;
  /** Offset one past the last content byte — where the next sibling begins. */
  readonly end: number;
}

export class DerError extends FirsthandError {
  constructor(message: string, offset: number) {
    super("FH_ATTESTATION_INVALID", `malformed DER at offset ${offset}: ${message}`, {
      context: { offset },
    });
  }
}

/** Reads one TLV starting at `offset`. Throws on anything that is not minimal, definite DER. */
export function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new DerError("offset out of bounds", offset);
  }

  const identifier = bytes[offset] as number;
  const tagClass = identifier >> 6;
  const constructed = (identifier & 0x20) !== 0;
  let cursor = offset + 1;
  let tagNumber = identifier & HIGH_TAG_FORM;

  if (tagNumber === HIGH_TAG_FORM) {
    // High-tag-number form: base-128, most significant group first, continuation bit set on all
    // but the last octet. Android's AuthorizationList entries live up here (tag 704 and friends).
    tagNumber = 0;
    let first = true;
    for (;;) {
      if (cursor >= bytes.length) throw new DerError("truncated tag", offset);
      const part = bytes[cursor++] as number;
      // A leading 0x80 would be a non-minimal encoding of the same number.
      if (first && part === CONTINUATION) throw new DerError("non-minimal tag number", offset);
      tagNumber = tagNumber * 128 + (part & 0x7f);
      if (tagNumber > MAX_TAG_NUMBER) throw new DerError("tag number too large", offset);
      first = false;
      if ((part & CONTINUATION) === 0) break;
    }
    if (tagNumber < HIGH_TAG_FORM) throw new DerError("non-minimal tag number", offset);
  }

  if (cursor >= bytes.length) throw new DerError("truncated length", offset);
  const lengthByte = bytes[cursor++] as number;
  let contentLength: number;

  if (lengthByte < CONTINUATION) {
    contentLength = lengthByte;
  } else if (lengthByte === CONTINUATION) {
    throw new DerError("indefinite length is not valid DER", offset);
  } else {
    const count = lengthByte & 0x7f;
    // 0xff is reserved; more than four octets cannot describe a length we would accept anyway.
    if (count === 0x7f || count > 4) throw new DerError("length too large", offset);
    if (cursor + count > bytes.length) throw new DerError("truncated length", offset);
    if (bytes[cursor] === 0) throw new DerError("non-minimal length", offset);
    contentLength = 0;
    for (let i = 0; i < count; i++)
      contentLength = contentLength * 256 + (bytes[cursor++] as number);
    // DER requires the shortest form: anything under 128 must use the short form.
    if (contentLength < CONTINUATION) throw new DerError("non-minimal length", offset);
    if (contentLength > MAX_LENGTH) throw new DerError("length too large", offset);
  }

  const end = cursor + contentLength;
  if (end > bytes.length) throw new DerError("content runs past the end of the buffer", offset);

  return {
    tagClass,
    constructed,
    tagNumber,
    start: offset,
    contentStart: cursor,
    contentLength,
    end,
  };
}

/** Reads one TLV and requires it to be a universal primitive or constructed tag. */
export function readUniversal(bytes: Uint8Array, offset: number, tagNumber: number): Tlv {
  const tlv = readTlv(bytes, offset);
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== tagNumber) {
    throw new DerError(`expected universal tag ${tagNumber}, found ${tlv.tagNumber}`, offset);
  }
  return tlv;
}

/**
 * The direct children of a constructed TLV, in order. Throws if `parent` is primitive or if its
 * children do not exactly tile its content — a gap or an overrun means the encoding is malformed,
 * and silently tolerating either is how parsers get confused into reading the wrong field.
 */
export function children(bytes: Uint8Array, parent: Tlv): readonly Tlv[] {
  if (!parent.constructed) throw new DerError("cannot descend into a primitive", parent.start);
  const out: Tlv[] = [];
  let cursor = parent.contentStart;
  while (cursor < parent.end) {
    const child = readTlv(bytes, cursor);
    if (child.end > parent.end) throw new DerError("child overruns its parent", child.start);
    out.push(child);
    cursor = child.end;
  }
  return out;
}

/** The content bytes of a TLV, as a view into the original buffer. */
export function content(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  return bytes.subarray(tlv.contentStart, tlv.end);
}

/** The complete TLV including its header — what a signature is computed over. */
export function element(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  return bytes.subarray(tlv.start, tlv.end);
}

/**
 * The payload of a BIT STRING, which is prefixed by a count of unused trailing bits. Every bit
 * string this codebase reads is byte-aligned, so a non-zero count is a malformed input.
 */
export function bitString(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.BIT_STRING) {
    throw new DerError("expected a BIT STRING", tlv.start);
  }
  if (tlv.contentLength < 1) throw new DerError("empty BIT STRING", tlv.start);
  if (bytes[tlv.contentStart] !== 0)
    throw new DerError("BIT STRING is not byte-aligned", tlv.start);
  return bytes.subarray(tlv.contentStart + 1, tlv.end);
}

/** An unsigned INTEGER or ENUMERATED small enough to be a JS number; rejects negatives. */
export function smallInteger(bytes: Uint8Array, tlv: Tlv): number {
  const isInt = tlv.tagNumber === Tag.INTEGER || tlv.tagNumber === Tag.ENUMERATED;
  if (tlv.tagClass !== TagClass.UNIVERSAL || !isInt) {
    throw new DerError("expected an INTEGER or ENUMERATED", tlv.start);
  }
  if (tlv.contentLength < 1 || tlv.contentLength > 4) {
    throw new DerError("integer out of the supported range", tlv.start);
  }
  if ((bytes[tlv.contentStart] as number) & 0x80) throw new DerError("negative integer", tlv.start);
  let value = 0;
  for (let i = tlv.contentStart; i < tlv.end; i++) value = value * 256 + (bytes[i] as number);
  return value;
}

/** An unsigned INTEGER of any length, as a bigint; rejects negatives. */
export function unsignedInteger(bytes: Uint8Array, tlv: Tlv): bigint {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.INTEGER) {
    throw new DerError("expected an INTEGER", tlv.start);
  }
  if (tlv.contentLength < 1) throw new DerError("empty INTEGER", tlv.start);
  if ((bytes[tlv.contentStart] as number) & 0x80) throw new DerError("negative integer", tlv.start);
  let value = 0n;
  for (let i = tlv.contentStart; i < tlv.end; i++)
    value = (value << 8n) | BigInt(bytes[i] as number);
  return value;
}

/** True when a TLV is an OBJECT IDENTIFIER whose content equals `encoded`. */
export function isOid(bytes: Uint8Array, tlv: Tlv, encoded: Uint8Array): boolean {
  if (tlv.tagClass !== TagClass.UNIVERSAL || tlv.tagNumber !== Tag.OBJECT_IDENTIFIER) return false;
  if (tlv.contentLength !== encoded.length) return false;
  for (let i = 0; i < encoded.length; i++) {
    if (bytes[tlv.contentStart + i] !== encoded[i]) return false;
  }
  return true;
}

/** Asserts a child count, so a positional read cannot silently target the wrong element. */
export function expectChildren(kids: readonly Tlv[], min: number, label: string, at: number): void {
  if (kids.length < min) {
    throw new DerError(`${label} has ${kids.length} elements, expected at least ${min}`, at);
  }
}
