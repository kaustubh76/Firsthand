import type { PreparedTx, TxRef } from "@firsthand/adapters";
import { type Address, ChainError, ValidationError } from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";
import type { Chain, PublicClient, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Submits *relayable* transactions on behalf of clients that hold no key — the capture PWA above all.
 * Safe by construction: every authority-signed entry point puts the authorisation inside the calldata
 * (a P-256 signature over an EIP-712 digest under the contract's own domain, ADR-0009) and never reads
 * `msg.sender`, so a stranger relaying a transaction cannot alter its meaning. The relayer only pays gas.
 *
 * What it is not: a general-purpose transaction service. `to` is allow-listed to this deployment's
 * authority contracts, value must be zero, and every call is simulated first so a revert costs the
 * relayer nothing and returns the decoded reason to the caller.
 */
export interface RelayOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** Contracts a relayed call may target — the four with signature-authorised entry points. */
  readonly allow: readonly Address[];
  readonly logger: Logger;
  readonly now?: () => number;
}

export class Relay {
  readonly #o: RelayOptions;
  readonly #allow: ReadonlySet<string>;

  constructor(options: RelayOptions) {
    this.#o = options;
    this.#allow = new Set(options.allow.map((a) => a.toLowerCase()));
  }

  get allowList(): readonly string[] {
    return [...this.#allow];
  }

  capabilities() {
    return {
      kind: "public" as const,
      relayer: this.#o.walletClient.account.address,
      allow: this.allowList,
      note: "relays signature-authorised calls only; authorisation lives in the calldata, not msg.sender",
    };
  }

  async send(tx: PreparedTx): Promise<TxRef> {
    const to = tx.to.toLowerCase() as Address;
    if (!this.#allow.has(to)) {
      throw new ValidationError("relay: target is not a FIRSTHAND authority contract", {
        context: { to, allow: this.allowList },
      });
    }
    if (tx.value !== undefined && tx.value !== 0n) {
      throw new ValidationError("relay: value must be zero", {
        context: { value: String(tx.value) },
      });
    }
    // Simulate first: a revert is the caller's bug, and the relayer should not pay for it.
    try {
      await this.#o.publicClient.call({
        account: this.#o.walletClient.account,
        to,
        data: tx.data,
      });
    } catch (cause) {
      throw new ChainError("relay: transaction would revert", { cause, context: { to } });
    }
    try {
      const hash = await this.#o.walletClient.sendTransaction({
        to,
        data: tx.data,
        ...(tx.gas === undefined ? {} : { gas: tx.gas }),
      });
      this.#o.logger.info("relayed", { to, hash });
      return { hash, transport: "public", submittedAt: (this.#o.now ?? Date.now)() };
    } catch (cause) {
      throw new ChainError("relay: submission failed", { cause, retryable: true, context: { to } });
    }
  }
}
