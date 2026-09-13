import {
  assertBytes32,
  type Bytes32,
  bytesToHex,
  CryptoError,
  concat,
  hexToBytes,
  keccak256Hex,
  u32be,
  u64be,
  utf8,
} from "@firsthand/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { NONCE_LENGTH, TAG_LENGTH } from "../envelope/format.js";
import { SecretBytes, zeroize } from "../zeroize.js";

/**
 * Grant wrap (README §7.2 `wrap = Enc_pk_grantee(k_ns,e)`, ADR-0007): an X25519 sealed box.
 *
 *   (esk, epk) = ephemeral X25519
 *   ss         = X25519(esk, granteePk)
 *   key        = HKDF-SHA256(ikm = ss, salt = epk ‖ granteePk, info = "FIRSTHAND/wrap/v1" ‖ grantId, 32)
 *   wrap       = epk (32) ‖ nonce (24) ‖ XChaCha20-Poly1305(key, nonce, k_ns,e, aad = grantId ‖ u32be(ns) ‖ u64be(e))
 *
 * On-chain `GrantManager` stores only `keccak256(wrap)`; the bytes are served off-chain.
 * The wrap is bound to the grant id and the namespace-epoch, so it cannot be replayed under
 * another grant. Attenuation-only: a grantee learns exactly one `(ns, e)` vault key per wrap.
 */
export const WRAP_INFO: Uint8Array = utf8("FIRSTHAND/wrap/v1");
export const WRAP_LENGTH = 32 + NONCE_LENGTH + 32 + TAG_LENGTH;

export interface WrapContext {
  readonly grantId: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
}

export interface WrapOptions {
  /** Test-only: fixed ephemeral secret and nonce for deterministic vectors. */
  readonly ephemeralSecret?: Uint8Array;
  readonly nonce?: Uint8Array;
}

export interface GrantWrap {
  readonly bytes: Uint8Array;
  /** `keccak256(bytes)` — what GrantManager records as the wrap reference. */
  readonly ref: Bytes32;
}

function deriveWrapKey(
  shared: Uint8Array,
  epk: Uint8Array,
  granteePk: Uint8Array,
  grantId: Bytes32,
): Uint8Array {
  return hkdf(sha256, shared, concat(epk, granteePk), concat(WRAP_INFO, hexToBytes(grantId)), 32);
}

function wrapAad(ctx: WrapContext): Uint8Array {
  assertBytes32(ctx.grantId, "grantId");
  return concat(hexToBytes(ctx.grantId), u32be(ctx.ns), u64be(ctx.epoch));
}

export function wrapVaultKeyToGrantee(
  vaultKey: SecretBytes,
  granteePublicKey: Bytes32,
  ctx: WrapContext,
  options: WrapOptions = {},
): GrantWrap {
  assertBytes32(granteePublicKey, "granteePublicKey");
  const granteePk = hexToBytes(granteePublicKey);
  const esk = options.ephemeralSecret ? new Uint8Array(options.ephemeralSecret) : randomBytes(32);
  const nonce = options.nonce ? new Uint8Array(options.nonce) : randomBytes(NONCE_LENGTH);
  if (esk.length !== 32 || nonce.length !== NONCE_LENGTH) {
    throw new CryptoError("wrap: bad ephemeral secret or nonce length");
  }
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, granteePk);
  const key = deriveWrapKey(shared, epk, granteePk, ctx.grantId);
  try {
    const sealed = vaultKey.use((vk) => xchacha20poly1305(key, nonce, wrapAad(ctx)).encrypt(vk));
    const bytes = concat(epk, nonce, sealed);
    return { bytes, ref: keccak256Hex(bytes) };
  } finally {
    zeroize(esk, shared, key);
  }
}

export function unwrapVaultKey(
  granteeSecretKey: SecretBytes,
  wrap: Uint8Array,
  ctx: WrapContext,
): SecretBytes {
  if (wrap.length !== WRAP_LENGTH) {
    throw new CryptoError("wrap: unexpected length", {
      context: { length: wrap.length, expected: WRAP_LENGTH },
    });
  }
  const epk = wrap.subarray(0, 32);
  const nonce = wrap.subarray(32, 32 + NONCE_LENGTH);
  const sealed = wrap.subarray(32 + NONCE_LENGTH);
  const granteePk = granteeSecretKey.use((sk) => x25519.getPublicKey(sk));
  const shared = granteeSecretKey.use((sk) => x25519.getSharedSecret(sk, epk));
  const key = deriveWrapKey(shared, epk, granteePk, ctx.grantId);
  try {
    const vk = xchacha20poly1305(key, nonce, wrapAad(ctx)).decrypt(sealed);
    return new SecretBytes(vk, `k_ns[${ctx.ns},${ctx.epoch}]`);
  } catch (cause) {
    throw new CryptoError("wrap: authentication failed", { cause });
  } finally {
    zeroize(shared, key);
  }
}

/** Reference of a wrap without unwrapping it (what a verifier compares against chain state). */
export function wrapRef(wrap: Uint8Array): Bytes32 {
  return keccak256Hex(wrap);
}

export function wrapToHex(wrap: GrantWrap): `0x${string}` {
  return bytesToHex(wrap.bytes);
}
