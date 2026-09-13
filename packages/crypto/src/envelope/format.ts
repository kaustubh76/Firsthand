import { CryptoError, concat, utf8 } from "@firsthand/core";

/**
 * Envelope v1 binary layout (ADR-0007):
 *
 *   "FH1E" (4) ‖ version (1) = 0x01 ‖ nonce (24) ‖ ciphertext ‖ tag (16)
 *
 * The same container carries sealed blobs and wrapped DEKs; what differs is the key and AAD.
 */
export const ENVELOPE_MAGIC: Uint8Array = utf8("FH1E");
export const ENVELOPE_VERSION = 0x01;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;
export const HEADER_LENGTH = ENVELOPE_MAGIC.length + 1 + NONCE_LENGTH;

export interface Envelope {
  readonly nonce: Uint8Array;
  /** ciphertext ‖ tag as produced by XChaCha20-Poly1305. */
  readonly sealed: Uint8Array;
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  if (envelope.nonce.length !== NONCE_LENGTH) {
    throw new CryptoError(`envelope: nonce must be ${NONCE_LENGTH} bytes`, {
      context: { length: envelope.nonce.length },
    });
  }
  return concat(
    ENVELOPE_MAGIC,
    new Uint8Array([ENVELOPE_VERSION]),
    envelope.nonce,
    envelope.sealed,
  );
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new CryptoError("envelope: too short", { context: { length: bytes.length } });
  }
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) throw new CryptoError("envelope: bad magic");
  }
  const version = bytes[ENVELOPE_MAGIC.length];
  if (version !== ENVELOPE_VERSION) {
    throw new CryptoError("envelope: unsupported version", { context: { version } });
  }
  const nonce = bytes.subarray(ENVELOPE_MAGIC.length + 1, HEADER_LENGTH);
  const sealed = bytes.subarray(HEADER_LENGTH);
  return { nonce, sealed };
}
