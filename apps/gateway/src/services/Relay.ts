import {
  classifySendError,
  explainRevert,
  insufficientFundsError,
  type PreparedTx,
  sendWithNonceRetry,
  type TxRef,
} from "@firsthand/adapters";
import { type Address, ChainError, ValidationError } from "@firsthand/core";
import type { Logger } from "@firsthand/runtime";
import type { Abi, Chain, PublicClient, Transport, WalletClient } from "viem";
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
/**
 * An allow-list entry: a whole contract (every entry point authorises by signature), or one
 * contract restricted to named 4-byte selectors — how the testnet faucet double's `mint` rides the
 * relay without the relay becoming a general USDC transaction service.
 */
export type RelayAllow =
  | Address
  | { readonly address: Address; readonly selectors: readonly `0x${string}`[] };

export interface RelayOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** Contracts a relayed call may target — the four with signature-authorised entry points. */
  readonly allow: readonly RelayAllow[];
  /** ABIs to decode a simulated revert against, so the caller reads `EpochNotAttested`, not "would revert". */
  readonly abis?: readonly Abi[];
  /**
   * Per-selector policy on the calldata itself — how the faucet double's `mint` is capped at an
   * amount, so the relay pays gas for a demo, not for someone minting 2^256−1 test dollars.
   */
  readonly policies?: readonly RelayPolicy[];
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface RelayPolicy {
  readonly address: Address;
  readonly selector: `0x${string}`;
  /** Returns a refusal reason for this calldata, or null to allow it. */
  readonly check: (data: `0x${string}`) => string | null;
}

export class Relay {
  readonly #o: RelayOptions;
  /** address → null (any selector) or the permitted selectors. */
  readonly #allow: ReadonlyMap<string, ReadonlySet<string> | null>;
  readonly #policies: ReadonlyMap<string, RelayPolicy["check"]>;

  constructor(options: RelayOptions) {
    this.#o = options;
    this.#allow = new Map(
      options.allow.map((entry) =>
        typeof entry === "string"
          ? [entry.toLowerCase(), null]
          : [entry.address.toLowerCase(), new Set(entry.selectors.map((s) => s.toLowerCase()))],
      ),
    );
    this.#policies = new Map(
      (options.policies ?? []).map((p) => [
        `${p.address.toLowerCase()}:${p.selector.toLowerCase()}`,
        p.check,
      ]),
    );
  }

  get relayer(): Address {
    return this.#o.walletClient.account.address;
  }

  /** Addresses, with `:selector` suffixes where an entry is selector-scoped — what discovery publishes. */
  get allowList(): readonly string[] {
    return [...this.#allow].flatMap(([address, selectors]) =>
      selectors === null ? [address] : [...selectors].map((s) => `${address}:${s}`),
    );
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
    const selectors = this.#allow.get(to);
    if (selectors === undefined) {
      throw new ValidationError("relay: target is not a FIRSTHAND authority contract", {
        context: { to, allow: this.allowList },
      });
    }
    const selector = tx.data.slice(0, 10).toLowerCase();
    if (selectors !== null && !selectors.has(selector)) {
      throw new ValidationError("relay: this entry point is not relayable on that contract", {
        context: { to, selector, allow: this.allowList },
      });
    }
    if (tx.value !== undefined && tx.value !== 0n) {
      throw new ValidationError("relay: value must be zero", {
        context: { value: String(tx.value) },
      });
    }
    const policy = this.#policies.get(`${to}:${selector}`);
    const refused = policy ? policy(tx.data) : null;
    if (refused !== null) {
      throw new ValidationError(`relay: ${refused}`, { context: { to, selector } });
    }
    // Simulate first: a revert is the caller's bug, and the relayer should not pay for it. The
    // decoded reason travels in the message — it is the one line the caller can act on.
    try {
      await this.#o.publicClient.call({
        account: this.#o.walletClient.account,
        to,
        data: tx.data,
      });
    } catch (cause) {
      const failure = classifySendError(cause);
      if (failure.kind === "rpc") {
        throw new ChainError(`relay: could not simulate — the RPC is busy (${failure.detail})`, {
          cause,
          retryable: true,
          context: { to, selector },
        });
      }
      if (failure.kind === "funds") throw this.#outOfGas(cause, to);
      const why = explainRevert(cause, this.#o.abis ?? []);
      const reason =
        why.reason === null
          ? failure.kind === "revert"
            ? "unknown reason"
            : failure.detail
          : why.args.length > 0
            ? `${why.reason}(${why.args.map(String).join(", ")})`
            : why.reason;
      throw new ChainError(`relay: transaction would revert: ${reason}`, {
        cause,
        context: { to, selector, reason: why.reason, args: why.args, raw: why.raw },
      });
    }
    const account = this.#o.walletClient.account;
    try {
      const hash = await sendWithNonceRetry(
        () =>
          this.#o.walletClient.sendTransaction({
            to,
            data: tx.data,
            ...(tx.gas === undefined ? {} : { gas: tx.gas }),
          }),
        {
          account,
          chainId: this.#o.walletClient.chain.id,
          onRetry: (attempt, detail) =>
            this.#o.logger.warn("relay: nonce collision, retrying", { to, attempt, detail }),
        },
      );
      this.#o.logger.info("relayed", { to, hash });
      return { hash, transport: "public", submittedAt: (this.#o.now ?? Date.now)() };
    } catch (cause) {
      const failure = classifySendError(cause);
      if (failure.kind === "funds") throw this.#outOfGas(cause, to);
      throw new ChainError(`relay: submission failed (${failure.detail})`, {
        cause,
        retryable: failure.kind === "rpc" || failure.kind === "nonce",
        context: { to, selector, kind: failure.kind },
      });
    }
  }

  #outOfGas(cause: unknown, to: Address): ChainError {
    const relayer = this.relayer;
    this.#o.logger.error("relayer float exhausted", { relayer, to });
    return insufficientFundsError(
      `relay: this gateway's relayer ${relayer} is out of gas — the operator must top it up`,
      relayer,
      cause,
    );
  }
}
