import {
  assertBytes32,
  type Bytes32,
  CryptoError,
  concat,
  hexToBytes,
  u32be,
  u64be,
} from "@firsthand/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { SecretBytes, zeroize } from "../zeroize.js";
import { decodeEnvelope, encodeEnvelope, NONCE_LENGTH } from "./format.js";

/**
 * Envelope encryption (README §4 "no protocol-held plaintext", ADR-0007).
 *
 *   DEK        = random 32 bytes per blob
 *   blob       = XChaCha20-Poly1305(DEK, nonce, plaintext, aad = passportId)
 *   wrappedDek = XChaCha20-Poly1305(k_ns,e, nonce', DEK, aad = passportId ‖ u32be(ns) ‖ u64be(e))
 *
 * One AEAD everywhere; AADs bind ciphertexts to the passport and namespace-epoch they belong to
 * so a blob cannot be re-attached to a different passport.
 */
export const DEK_LENGTH = 32;

export interface SealOptions {
  /** Test-only nonce injection for deterministic vectors. Never pass in production. */
  readonly nonce?: Uint8Array;
}

export function generateDek(): SecretBytes {
  return new SecretBytes(randomBytes(DEK_LENGTH), "dek");
}

function nonceFrom(options: SealOptions): Uint8Array {
  if (options.nonce !== undefined) {
    if (options.nonce.length !== NONCE_LENGTH) {
      throw new CryptoError(`nonce must be ${NONCE_LENGTH} bytes`, {
        context: { length: options.nonce.length },
      });
    }
    return new Uint8Array(options.nonce);
  }
  return randomBytes(NONCE_LENGTH);
}

function seal(
  key: SecretBytes,
  plaintext: Uint8Array,
  aad: Uint8Array,
  options: SealOptions,
): Uint8Array {
  const nonce = nonceFrom(options);
  const sealed = key.use((k) => xchacha20poly1305(k, nonce, aad).encrypt(plaintext));
  return encodeEnvelope({ nonce, sealed });
}

function open(key: SecretBytes, envelope: Uint8Array, aad: Uint8Array, what: string): Uint8Array {
  const { nonce, sealed } = decodeEnvelope(envelope);
  try {
    return key.use((k) => xchacha20poly1305(k, nonce, aad).decrypt(sealed));
  } catch (cause) {
    throw new CryptoError(`${what}: authentication failed`, { cause, context: { what } });
  }
}

/** AAD for blob sealing: the passport id. */
export function blobAad(passportId: Bytes32): Uint8Array {
  assertBytes32(passportId, "passportId");
  return hexToBytes(passportId);
}

/** AAD for DEK wrapping: passport id ‖ namespace ‖ epoch. */
export function dekAad(passportId: Bytes32, ns: number, epoch: bigint): Uint8Array {
  return concat(blobAad(passportId), u32be(ns), u64be(epoch));
}

export function sealBlob(
  dek: SecretBytes,
  plaintext: Uint8Array,
  passportId: Bytes32,
  options: SealOptions = {},
): Uint8Array {
  return seal(dek, plaintext, blobAad(passportId), options);
}

export function openBlob(dek: SecretBytes, envelope: Uint8Array, passportId: Bytes32): Uint8Array {
  return open(dek, envelope, blobAad(passportId), "blob");
}

export function wrapDek(
  vaultKey: SecretBytes,
  dek: SecretBytes,
  passportId: Bytes32,
  ns: number,
  epoch: bigint,
  options: SealOptions = {},
): Uint8Array {
  return dek.use((d) => seal(vaultKey, d, dekAad(passportId, ns, epoch), options));
}

export function unwrapDek(
  vaultKey: SecretBytes,
  wrapped: Uint8Array,
  passportId: Bytes32,
  ns: number,
  epoch: bigint,
): SecretBytes {
  const bytes = open(vaultKey, wrapped, dekAad(passportId, ns, epoch), "dek");
  if (bytes.length !== DEK_LENGTH) {
    zeroize(bytes);
    throw new CryptoError("dek: unexpected length", { context: { length: bytes.length } });
  }
  return new SecretBytes(bytes, "dek");
}
