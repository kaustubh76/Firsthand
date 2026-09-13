import {
  type Address,
  addressOfPublicKey,
  assertBytes32,
  type Bytes32,
  bytesToHex,
  CryptoError,
  hexToBytes,
  MAX_NAMESPACES,
  type P256PublicKey,
  p256Commitment,
  p256PublicKeyFromUncompressed,
  u256be,
} from "@firsthand/core";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PRF_EVAL_SALT, PRF_OUTPUT_LENGTH, type PrfSource } from "../prf/PrfSource.js";
import { SecretBytes, zeroize } from "../zeroize.js";
import { infoDep, infoId, infoNonce, infoNs, KDF_LENGTH, KDF_SALT } from "./info.js";
import { scalarFromOkm } from "./scalar.js";

/**
 * The identity math (README §7.3, ADR-0005). One passkey; every key derives from its PRF:
 *
 *   PRK          = HKDF-Extract(salt = "FIRSTHAND/kdf/v1", IKM = prf)
 *   k_id         = HKDF-Expand(PRK, info_id, 48)         → P-256 authority scalar
 *   k_ns,e       = HKDF-Expand(PRK, info_ns(ns,e), 32)   → namespace-epoch vault key (KEK)
 *   k_dep(ns,e)  = HKDF-Expand(PRK, info_dep(ns,e), 48)  → secp256k1 deposit scalar
 *   k_nonce(ns,e)= HKDF-Expand(PRK, info_nonce(ns,e), 32)→ HMAC key for deterministic nonces
 *
 * Scope is enforced by *which key exists*: a grantee receives `k_ns,e` for specific `(ns, e)`
 * and can derive nothing else. Nothing in this class is serialisable.
 */

const P256_N = p256.Point.CURVE().n;
const SECP_N = secp256k1.Point.CURVE().n;

/** P-256 authority key handle. The scalar is a `SecretBytes`; the public parts are plain. */
export interface AuthorityKey {
  readonly scalar: SecretBytes;
  readonly publicKey: P256PublicKey;
  /** `keccak256(abi.encode(x, y))` — also the principal id. */
  readonly commitment: Bytes32;
}

/** secp256k1 deposit key handle for one `(ns, epoch)`. */
export interface DepositKey {
  readonly ns: number;
  readonly epoch: bigint;
  readonly privateKey: SecretBytes;
  /** 65-byte uncompressed public key, hex. */
  readonly publicKey: `0x${string}`;
  /** `Passport.origin`. */
  readonly address: Address;
}

function assertNamespace(ns: number): void {
  if (!Number.isInteger(ns) || ns < 0 || ns >= MAX_NAMESPACES) {
    throw new CryptoError(`namespace index out of range (0..${MAX_NAMESPACES - 1})`, {
      context: { ns },
    });
  }
}

function assertEpoch(epoch: bigint): void {
  if (typeof epoch !== "bigint" || epoch < 0n || epoch >= 1n << 64n) {
    throw new CryptoError("epoch must be a uint64 bigint");
  }
}

export class KeyTree {
  readonly #prk: SecretBytes;

  private constructor(prk: Uint8Array) {
    this.#prk = new SecretBytes(prk, "prk");
  }

  /**
   * Builds the tree from raw PRF output. The input buffer is zeroized on return — callers must
   * not reuse it. Prefer `fromSource` in application code.
   */
  static fromPrf(prf: Uint8Array): KeyTree {
    if (prf.length !== PRF_OUTPUT_LENGTH) {
      throw new CryptoError(`KeyTree.fromPrf: expected ${PRF_OUTPUT_LENGTH} bytes`, {
        context: { length: prf.length },
      });
    }
    try {
      return new KeyTree(extract(sha256, prf, KDF_SALT));
    } finally {
      zeroize(prf);
    }
  }

  static async fromSource(source: PrfSource): Promise<KeyTree> {
    const prf = await source.evaluate(PRF_EVAL_SALT);
    return KeyTree.fromPrf(prf);
  }

  /** Exposed for the golden vectors only; treat as secret. */
  prk(): SecretBytes {
    return this.#prk.clone("prk");
  }

  authorityKey(): AuthorityKey {
    const okm = this.expand(infoId(), KDF_LENGTH.SCALAR);
    const scalar = u256be(scalarFromOkm(okm, P256_N));
    zeroize(okm);
    const publicKey = p256PublicKeyFromUncompressed(p256.getPublicKey(scalar, false));
    return {
      scalar: new SecretBytes(scalar, "k_id"),
      publicKey,
      commitment: p256Commitment(publicKey),
    };
  }

  vaultKey(ns: number, epoch: bigint): SecretBytes {
    assertNamespace(ns);
    assertEpoch(epoch);
    return new SecretBytes(
      this.expand(infoNs(ns, epoch), KDF_LENGTH.SYMMETRIC),
      `k_ns[${ns},${epoch}]`,
    );
  }

  depositKey(ns: number, epoch: bigint): DepositKey {
    assertNamespace(ns);
    assertEpoch(epoch);
    const okm = this.expand(infoDep(ns, epoch), KDF_LENGTH.SCALAR);
    const privateKey = u256be(scalarFromOkm(okm, SECP_N));
    zeroize(okm);
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    return {
      ns,
      epoch,
      privateKey: new SecretBytes(privateKey, `k_dep[${ns},${epoch}]`),
      publicKey: bytesToHex(publicKey),
      address: addressOfPublicKey(publicKey),
    };
  }

  nonceKey(ns: number, epoch: bigint): SecretBytes {
    assertNamespace(ns);
    assertEpoch(epoch);
    return new SecretBytes(
      this.expand(infoNonce(ns, epoch), KDF_LENGTH.SYMMETRIC),
      `k_nonce[${ns},${epoch}]`,
    );
  }

  /** `Passport.nonce = HMAC-SHA256(k_nonce(ns,e), h)` — deterministic per content (ADR-0005). */
  passportNonce(ns: number, epoch: bigint, contentHash: Bytes32): Bytes32 {
    assertBytes32(contentHash, "contentHash");
    const key = this.nonceKey(ns, epoch);
    try {
      return bytesToHex(key.use((k) => hmac(sha256, k, hexToBytes(contentHash))));
    } finally {
      key.dispose();
    }
  }

  dispose(): void {
    this.#prk.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  toJSON(): string {
    return "[KeyTree]";
  }

  private expand(info: Uint8Array, length: number): Uint8Array {
    return this.#prk.use((prk) => expand(sha256, prk, info, length));
  }
}
