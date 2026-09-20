import {
  type Address,
  assertBytes32,
  type Bytes32,
  CryptoError,
  hexToBytes,
  MAX_NAMESPACES,
  ValidationError,
} from "@firsthand/core";
import {
  type AuthorityKey,
  type DepositKey,
  type KeyProvider,
  type KeyTree,
  passportNonceWith,
  secpPublicOf,
} from "../kdf/keytree.js";
import { SecretBytes } from "../zeroize.js";

/**
 * A deposit delegation — the MCP↔PWA handoff (README §10 `firsthand-mcp`, §12 key hygiene).
 *
 * Depositing into `(ns, e)` needs exactly three secrets from the tree — `k_dep(ns,e)` (passports
 * and anchors), `k_nonce(ns,e)` (deterministic nonces) and `k_ns,e` (DEK wrapping) — plus public
 * data: the principal id and the sixteen deposit addresses of the epoch (the attested preimage).
 * Enrol, attest, grant and rescind need `k_id`, which a delegation never carries. So a delegation
 * is a capability attenuated the way a grant wrap is: one namespace, one epoch, deposit-only,
 * expiring at the epoch boundary. "Scope is enforced by which key exists."
 *
 * The user issues it from the app (keys derived from the passkey on device) and pastes it into
 * their own agent. It is a bearer secret for that scope: anyone holding it can deposit into that
 * namespace under this principal until the epoch ends — as trusted as an importer, no more.
 */
export interface Delegation {
  readonly v: 1;
  readonly chainId: string;
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly epoch: string;
  /** Unix seconds: the end of the epoch — nothing in a delegation outlives its keys' epoch. */
  readonly expiresAt: string;
  readonly depositAddresses: readonly Address[];
  /** secp256k1 scalar, 32 bytes hex. */
  readonly depositKey: Bytes32;
  readonly vaultKey: Bytes32;
  readonly nonceKey: Bytes32;
}

export const DELEGATION_PREFIX = "fhd1.";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (text: string): Uint8Array => {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/** `fhd1.<base64url(JSON)>` — one pasteable line. */
export function encodeDelegation(d: Delegation): string {
  return `${DELEGATION_PREFIX}${b64url(new TextEncoder().encode(JSON.stringify(d)))}`;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX20 = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^\d+$/;

export interface DecodeOptions {
  /** Unix seconds; the code is refused once `expiresAt` has passed. */
  readonly now?: () => bigint;
}

export function decodeDelegation(code: string, options: DecodeOptions = {}): Delegation {
  const trimmed = code.trim();
  if (!trimmed.startsWith(DELEGATION_PREFIX)) {
    throw new ValidationError("not a FIRSTHAND deposit delegation (expected an fhd1. code)");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromB64url(trimmed.slice(DELEGATION_PREFIX.length))));
  } catch {
    throw new ValidationError("delegation code is not valid base64url JSON");
  }
  const d = raw as Partial<Delegation>;
  const bad = (what: string): never => {
    throw new ValidationError(`delegation code: ${what}`);
  };
  if (d.v !== 1) bad("unsupported version");
  if (typeof d.chainId !== "string" || !DECIMAL.test(d.chainId)) bad("chainId");
  if (typeof d.principalId !== "string" || !HEX32.test(d.principalId)) bad("principalId");
  if (!Number.isInteger(d.ns) || (d.ns as number) < 0 || (d.ns as number) >= MAX_NAMESPACES)
    bad("ns");
  if (typeof d.epoch !== "string" || !DECIMAL.test(d.epoch)) bad("epoch");
  if (typeof d.expiresAt !== "string" || !DECIMAL.test(d.expiresAt)) bad("expiresAt");
  if (
    !Array.isArray(d.depositAddresses) ||
    d.depositAddresses.length !== MAX_NAMESPACES ||
    !d.depositAddresses.every((a) => typeof a === "string" && HEX20.test(a))
  ) {
    bad("depositAddresses must be the epoch's 16 deposit addresses");
  }
  for (const key of ["depositKey", "vaultKey", "nonceKey"] as const) {
    if (typeof d[key] !== "string" || !HEX32.test(d[key] as string))
      bad(`${key} must be 32 bytes hex`);
  }
  const now = (options.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
  if (now >= BigInt(d.expiresAt as string)) {
    throw new CryptoError(
      `delegation expired with epoch ${d.epoch} — issue a new one from the app for the current epoch`,
      { code: "FH_DELEGATION_SCOPE", context: { epoch: d.epoch, expiresAt: d.expiresAt } },
    );
  }
  return d as Delegation;
}

/**
 * The key provider a delegation yields: the three secrets for its `(ns, epoch)`, nothing else.
 * Every other request — another namespace, another epoch, the authority key — is refused with
 * `FH_DELEGATION_SCOPE`, which is the property that makes handing a delegation to an agent safe.
 */
export class DelegatedKeys implements KeyProvider {
  readonly principalId: Bytes32;
  readonly ns: number;
  readonly epoch: bigint;
  readonly expiresAt: bigint;
  readonly chainId: bigint;
  readonly #depositAddresses: readonly Address[];
  readonly #depositKey: SecretBytes;
  readonly #vaultKey: SecretBytes;
  readonly #nonceKey: SecretBytes;

  constructor(d: Delegation) {
    this.principalId = d.principalId;
    this.ns = d.ns;
    this.epoch = BigInt(d.epoch);
    this.expiresAt = BigInt(d.expiresAt);
    this.chainId = BigInt(d.chainId);
    this.#depositAddresses = d.depositAddresses.map((a) => a.toLowerCase() as Address);
    this.#depositKey = new SecretBytes(hexToBytes(d.depositKey), `k_dep[${d.ns},${d.epoch}]`);
    this.#vaultKey = new SecretBytes(hexToBytes(d.vaultKey), `k_ns[${d.ns},${d.epoch}]`);
    this.#nonceKey = new SecretBytes(hexToBytes(d.nonceKey), `k_nonce[${d.ns},${d.epoch}]`);
    // The delegated deposit key must be the one the attested set names for its namespace.
    const expected = this.#depositAddresses[d.ns];
    const actual = this.#depositKey.use((k) => secpPublicOf(k).address);
    if (expected !== actual) {
      this.dispose();
      throw new CryptoError(
        "delegation: the deposit key does not match the namespace's attested address",
        {
          code: "FH_DELEGATION_SCOPE",
          context: { ns: d.ns, epoch: d.epoch },
        },
      );
    }
  }

  static fromCode(code: string, options: DecodeOptions = {}): DelegatedKeys {
    return new DelegatedKeys(decodeDelegation(code, options));
  }

  /** What this provider can do, in one line — for a status screen. */
  describe(): string {
    return `deposit-only delegation: namespace ${this.ns}, epoch ${this.epoch}, until ${new Date(
      Number(this.expiresAt) * 1000,
    ).toISOString()}`;
  }

  #scoped(ns: number, epoch: bigint, what: string): void {
    if (ns !== this.ns || epoch !== this.epoch) {
      throw new CryptoError(
        `this session holds a deposit delegation for namespace ${this.ns}, epoch ${this.epoch} — ${what} for namespace ${ns}, epoch ${epoch} is outside it`,
        { code: "FH_DELEGATION_SCOPE", context: { ns, epoch: epoch.toString(), what } },
      );
    }
  }

  authorityKey(): AuthorityKey {
    throw new CryptoError(
      `this session holds a deposit delegation (namespace ${this.ns}, epoch ${this.epoch}) — enrol, attest, grant and rescind need the passkey: open the app for those`,
      { code: "FH_DELEGATION_SCOPE", context: { what: "authorityKey" } },
    );
  }

  vaultKey(ns: number, epoch: bigint): SecretBytes {
    this.#scoped(ns, epoch, "the vault key");
    return this.#vaultKey.clone();
  }

  depositKey(ns: number, epoch: bigint): DepositKey {
    this.#scoped(ns, epoch, "the deposit key");
    const privateKey = this.#depositKey.clone();
    const { publicKey, address } = privateKey.use((k) => secpPublicOf(k));
    return { ns, epoch, privateKey, publicKey, address };
  }

  nonceKey(ns: number, epoch: bigint): SecretBytes {
    this.#scoped(ns, epoch, "the nonce key");
    return this.#nonceKey.clone();
  }

  passportNonce(ns: number, epoch: bigint, contentHash: Bytes32): Bytes32 {
    assertBytes32(contentHash, "contentHash");
    this.#scoped(ns, epoch, "a passport nonce");
    return this.#nonceKey.use((k) => passportNonceWith(k, contentHash));
  }

  depositAddresses(epoch: bigint): readonly Address[] | null {
    return epoch === this.epoch ? this.#depositAddresses : null;
  }

  dispose(): void {
    this.#depositKey.dispose();
    this.#vaultKey.dispose();
    this.#nonceKey.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  toJSON(): string {
    return "[DelegatedKeys]";
  }
}

/** Issues a delegation from an unlocked tree — the app's side of the handoff. */
export function issueDelegation(
  tree: KeyTree,
  input: { ns: number; epoch: bigint; chainId: bigint; expiresAt: bigint },
): Delegation {
  const d = tree.delegate(input);
  return {
    v: 1,
    chainId: d.chainId.toString(),
    principalId: d.principalId,
    ns: d.ns,
    epoch: d.epoch.toString(),
    expiresAt: d.expiresAt.toString(),
    depositAddresses: d.depositAddresses,
    depositKey: d.depositKey,
    vaultKey: d.vaultKey,
    nonceKey: d.nonceKey,
  };
}
