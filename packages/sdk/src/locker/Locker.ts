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
import { type DepositKey, KeyTree, type PrfSource } from "@firsthand/crypto";
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
  readonly keys: KeyTree;
  readonly domain: Eip712Domain;
  readonly epochs: EpochParams;
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly namespaces?: readonly NamespaceInfo[];
  readonly clock?: () => bigint;
  readonly logger?: Logger;
}

export class Locker {
  readonly keys: KeyTree;
  readonly domain: Eip712Domain;
  readonly epochs: EpochParams;
  readonly anchors: AnchorWriter;
  readonly blobs: BlobStore;
  readonly principalId: Bytes32;
  readonly logger: Logger;
  readonly #namespaces = new Map<number, NamespaceInfo>();
  readonly #clock: () => bigint;
  readonly #depositKeys = new Map<string, DepositKey>();

  constructor(options: LockerOptions) {
    this.keys = options.keys;
    this.domain = options.domain;
    this.epochs = options.epochs;
    this.anchors = options.anchors;
    this.blobs = options.blobs;
    this.logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    for (const ns of options.namespaces ?? [{ ns: 0, label: "default" }]) this.addNamespace(ns);
    this.principalId = this.keys.authorityKey().commitment;
  }

  static async open(source: PrfSource, options: Omit<LockerOptions, "keys">): Promise<Locker> {
    return new Locker({ ...options, keys: await KeyTree.fromSource(source) });
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

  /** All 16 deposit addresses for an epoch — the preimage of the attested `depositKeysRoot`. */
  depositAddresses(epoch: bigint = this.currentEpoch()): Address[] {
    const out: Address[] = [];
    for (let ns = 0; ns < MAX_NAMESPACES; ns++) out.push(this.keys.depositKey(ns, epoch).address);
    return out;
  }

  /** True when `origin` is a deposit address this locker can derive for `(ns, epoch)`. */
  isOwnOrigin(origin: Address, ns: number, epoch: bigint): boolean {
    return this.depositKey(ns, epoch).address === origin;
  }

  dispose(): void {
    for (const dk of this.#depositKeys.values()) dk.privateKey.dispose();
    this.#depositKeys.clear();
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
