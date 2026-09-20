import type { AnchorWriter, BlobStore } from "@firsthand/adapters";
import {
  type Address,
  type Bytes32,
  type Eip712Domain,
  type EpochParams,
  epochAt,
  MAX_NAMESPACES,
  ValidationError,
} from "@firsthand/core";
import {
  type AuthorityKey,
  DelegatedKeys,
  type DepositKey,
  type KeyProvider,
  KeyTree,
  type PrfSource,
} from "@firsthand/crypto";
import { type Logger, noopLogger } from "@firsthand/runtime";

/**
 * User-side state: the key tree plus the namespaces this principal uses. Runs on the user's
 * machine (MCP server, capture PWA) — never inside the gateway. Nothing here serialises secrets:
 * `JSON.stringify(locker)` yields only public identifiers.
 */
export interface NamespaceInfo {
  readonly ns: number;
  /** Human label; off-chain only (ADR-0008). */
  readonly label: string;
}

export interface LockerOptions {
  /** The passkey's whole tree, or a deposit-only delegation for one namespace-epoch. */
  readonly keys: KeyProvider;
  /** Required when `keys` cannot derive the authority key (a delegation names its principal). */
  readonly principalId?: Bytes32;
  readonly domain: Eip712Domain;
  readonly epochs: EpochParams;
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly namespaces?: readonly NamespaceInfo[];
  readonly clock?: () => bigint;
  readonly logger?: Logger;
}

export class Locker {
  readonly keys: KeyProvider;
  readonly domain: Eip712Domain;
  readonly epochs: EpochParams;
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly principalId: Bytes32;
  readonly logger: Logger;
  readonly #namespaces = new Map<number, NamespaceInfo>();
  readonly #clock: () => bigint;
  readonly #depositKeys = new Map<string, DepositKey>();
  #authority: AuthorityKey | null = null;

  constructor(options: LockerOptions) {
    this.keys = options.keys;
    this.domain = options.domain;
    this.epochs = options.epochs;
    this.anchors = options.anchors;
    this.blobs = options.blobs;
    this.logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    for (const ns of options.namespaces ?? [{ ns: 0, label: "default" }]) this.addNamespace(ns);
    this.principalId = options.principalId ?? this.authorityKey().commitment;
  }

  /** True when this locker runs on a delegation: deposit-only, one namespace, one epoch. */
  get delegated(): DelegatedKeys | null {
    return this.keys instanceof DelegatedKeys ? this.keys : null;
  }

  /** The derived P-256 authority key, memoised for the session (scalar is a SecretBytes). */
  authorityKey(): AuthorityKey {
    if (this.#authority === null) this.#authority = this.keys.authorityKey();
    return this.#authority;
  }

  /**
   * EIP-712 domain a given contract verifies authority signatures under (ADR-0009): same chain as
   * passports, but `verifyingContract` is the contract being called, not PassportAnchors.
   */
  authorityDomain(verifyingContract: Address): Eip712Domain {
    return { chainId: this.domain.chainId, verifyingContract };
  }

  static async open(source: PrfSource, options: Omit<LockerOptions, "keys">): Promise<Locker> {
    return new Locker({ ...options, keys: await KeyTree.fromSource(source) });
  }

  /**
   * A locker over a deposit delegation (`fhd1.` code from the app): the same verbs, but only
   * `deposit`/`publish` into the delegated namespace and epoch can succeed — everything else is
   * refused by the keys themselves with `FH_DELEGATION_SCOPE`.
   */
  static openDelegated(
    code: string,
    options: Omit<LockerOptions, "keys" | "principalId">,
    decode: { now?: () => bigint } = {},
  ): Locker {
    const keys = DelegatedKeys.fromCode(code, decode);
    if (keys.chainId !== options.domain.chainId) {
      keys.dispose();
      throw new ValidationError(
        `delegation is for chain ${keys.chainId}, this deployment is chain ${options.domain.chainId}`,
      );
    }
    return new Locker({
      ...options,
      keys,
      principalId: keys.principalId,
      namespaces: [{ ns: keys.ns, label: `delegated ns ${keys.ns}` }],
    });
  }

  addNamespace(info: NamespaceInfo): void {
    if (!Number.isInteger(info.ns) || info.ns < 0 || info.ns >= MAX_NAMESPACES) {
      throw new ValidationError(`namespace index must be 0..${MAX_NAMESPACES - 1}`, {
        context: { ns: info.ns },
      });
    }
    this.#namespaces.set(info.ns, info);
  }

  namespaces(): readonly NamespaceInfo[] {
    return [...this.#namespaces.values()];
  }

  hasNamespace(ns: number): boolean {
    return this.#namespaces.has(ns);
  }

  currentEpoch(): bigint {
    return epochAt(this.#clock(), this.epochs);
  }

  /** Deposit key for `(ns, epoch)`, memoised for the session. */
  depositKey(ns: number, epoch: bigint = this.currentEpoch()): DepositKey {
    const key = `${ns}:${epoch}`;
    let dk = this.#depositKeys.get(key);
    if (dk === undefined) {
      dk = this.keys.depositKey(ns, epoch);
      this.#depositKeys.set(key, dk);
    }
    return dk;
  }

  /**
   * All 16 deposit addresses for an epoch — the preimage of the attested `depositKeysRoot`. A
   * delegation carries them as public data; a full tree derives them.
   */
  depositAddresses(epoch: bigint = this.currentEpoch()): Address[] {
    const known = this.keys.depositAddresses?.(epoch);
    if (known) return [...known];
    const out: Address[] = [];
    for (let ns = 0; ns < MAX_NAMESPACES; ns++) {
      const dk = this.keys.depositKey(ns, epoch);
      out.push(dk.address);
      dk.privateKey.dispose();
    }
    return out;
  }

  /** True when `origin` is a deposit address this locker can derive for `(ns, epoch)`. */
  isOwnOrigin(origin: Address, ns: number, epoch: bigint): boolean {
    // A delegation knows every address of its epoch without holding the keys: an origin outside its
    // namespace is still "own" by lineage, but a delegated locker can only *mint* in its own.
    const known = this.keys.depositAddresses?.(epoch);
    if (known) return known[ns] === origin;
    return this.depositKey(ns, epoch).address === origin;
  }

  dispose(): void {
    for (const dk of this.#depositKeys.values()) dk.privateKey.dispose();
    this.#depositKeys.clear();
    this.#authority?.scalar.dispose();
    this.#authority = null;
    this.keys.dispose();
  }

  toJSON(): {
    principalId: Bytes32;
    namespaces: readonly NamespaceInfo[];
    domain: { chainId: string; verifyingContract: Address };
  } {
    return {
      principalId: this.principalId,
      namespaces: this.namespaces(),
      domain: {
        chainId: this.domain.chainId.toString(),
        verifyingContract: this.domain.verifyingContract,
      },
    };
  }
}
