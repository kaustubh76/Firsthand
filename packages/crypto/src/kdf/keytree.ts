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
 * and can derive nothing else. Nothing in this class is serialisable — except through `delegate`,
 * which emits exactly the three secrets of one `(ns, e)` for a deposit-only delegation.
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

/**
 * What the SDK's locker asks of its keys. `KeyTree` (the passkey's whole tree) and
 * `DelegatedKeys` (one namespace-epoch, deposit-only) both implement it; the locker cannot tell
 * them apart except by what they refuse.
 */
export interface KeyProvider {
  authorityKey(): AuthorityKey;
  vaultKey(ns: number, epoch: bigint): SecretBytes;
  depositKey(ns: number, epoch: bigint): DepositKey;
  nonceKey(ns: number, epoch: bigint): SecretBytes;
  passportNonce(ns: number, epoch: bigint, contentHash: Bytes32): Bytes32;
  dispose(): void;
  /**
   * The epoch's sixteen deposit addresses when the provider knows them without deriving (a
   * delegation carries them as public data); null means "derive them" — only a full tree can.
   */
  depositAddresses?(epoch: bigint): readonly Address[] | null;
}

/** Public half of a secp256k1 scalar — the deposit key's `publicKey` and `Passport.origin`. */
export function secpPublicOf(scalar: Uint8Array): { publicKey: `0x${string}`; address: Address } {
  const publicKey = secp256k1.getPublicKey(scalar, false);
  return { publicKey: bytesToHex(publicKey), address: addressOfPublicKey(publicKey) };
}

/** `Passport.nonce = HMAC-SHA256(k_nonce, h)` — deterministic per content (ADR-0005). */
export function passportNonceWith(nonceKey: Uint8Array, contentHash: Bytes32): Bytes32 {
  return bytesToHex(hmac(sha256, nonceKey, hexToBytes(contentHash)));
}

/** What a delegation needs from the tree besides the three secrets: identity and public scope. */
export interface DelegateInput {
  readonly ns: number;
  readonly epoch: bigint;
  readonly chainId: bigint;
  /** Unix seconds; the epoch's end. */
  readonly expiresAt: bigint;
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

export class KeyTree implements KeyProvider {
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
    const { publicKey, address } = secpPublicOf(privateKey);
    return {
      ns,
      epoch,
      privateKey: new SecretBytes(privateKey, `k_dep[${ns},${epoch}]`),
      publicKey,
      address,
    };
  }

  /**
   * The one deliberate serialisation of derived secrets: a deposit delegation for `(ns, epoch)` —
   * `k_dep`, `k_nonce`, `k_ns,e` and the public scope (principal id, the epoch's sixteen deposit
   * addresses, chain, expiry). Never `k_id`; never another namespace or epoch. The caller hands it
   * to `encodeDelegation` and to the user's own agent — see `delegation/`.
   */
  delegate(input: DelegateInput): {
    principalId: Bytes32;
    ns: number;
    epoch: bigint;
    chainId: bigint;
    expiresAt: bigint;
    depositAddresses: Address[];
    depositKey: Bytes32;
    vaultKey: Bytes32;
    nonceKey: Bytes32;
  } {
    assertNamespace(input.ns);
    assertEpoch(input.epoch);
    const depositAddresses: Address[] = [];
    for (let ns = 0; ns < MAX_NAMESPACES; ns++) {
      const dk = this.depositKey(ns, input.epoch);
      depositAddresses.push(dk.address);
      dk.privateKey.dispose();
    }
    const dep = this.depositKey(input.ns, input.epoch);
    const vault = this.vaultKey(input.ns, input.epoch);
    const nonce = this.nonceKey(input.ns, input.epoch);
    try {
      return {
        principalId: this.authorityKey().commitment,
        ns: input.ns,
        epoch: input.epoch,
        chainId: input.chainId,
        expiresAt: input.expiresAt,
        depositAddresses,
        depositKey: dep.privateKey.use((k) => bytesToHex(k)),
        vaultKey: vault.use((k) => bytesToHex(k)),
        nonceKey: nonce.use((k) => bytesToHex(k)),
      };
    } finally {
      dep.privateKey.dispose();
      vault.dispose();
      nonce.dispose();
    }
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
      return key.use((k) => passportNonceWith(k, contentHash));
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
