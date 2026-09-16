import {
  buildPaymentPayload,
  type PaymentPayload,
  type PaymentRequirements,
  splitSignature,
} from "@firsthand/adapters";
import { RoyaltyRouterAbi } from "@firsthand/contracts/abi";
import type { Address, Bytes32, Terms } from "@firsthand/core";
import {
  type Chain,
  encodeFunctionData,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Clock } from "../harness/Clock.js";

export interface ExtractorOptions {
  readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly router: Address;
  readonly grantId: Bytes32;
  readonly terms: Terms;
  readonly requirements: PaymentRequirements;
  readonly clock: Clock;
  /** Priority fee multiplier over the node's estimate — the bot outbids the principal inside a block. */
  readonly priorityFeeMultiplier?: bigint;
  /** Fixed gas so no simulation sits between the signal and the send (S2 measured 241,741). */
  readonly gas?: bigint;
}

export interface SettleAttempt {
  readonly hash: Bytes32;
  readonly sentAt: number;
  minedAtMs: number | null;
  blockNumber: bigint | null;
  transactionIndex: number | null;
  status: "success" | "reverted" | "pending";
}

/**
 * The extraction side of the race: a grantee that submits `RoyaltyRouter.settle` straight to the
 * chain (settle is permissionless; the buyer's EIP-3009 authorization is what moves funds), as fast
 * as it can, with its own nonce stream. No simulation, no receipt wait between sends.
 */
export class Extractor {
  readonly #o: ExtractorOptions;
  readonly attempts: SettleAttempt[] = [];
  #nonce: number | null = null;
  #fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null = null;
  #presigned: PaymentPayload[] = [];
  #loop: ReturnType<typeof setInterval> | null = null;

  constructor(options: ExtractorOptions) {
    this.#o = options;
  }

  /** Syncs the nonce and fee estimate once, then signs `k` payment authorizations ahead of time. */
  async prepare(k: number): Promise<void> {
    const account = this.#o.wallet.account;
    this.#nonce = await this.#o.publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    const fees = await this.#o.publicClient.estimateFeesPerGas();
    const mult = this.#o.priorityFeeMultiplier ?? 10n;
    const priority = (fees.maxPriorityFeePerGas ?? 1_000_000_000n) * mult;
    this.#fees = {
      maxPriorityFeePerGas: priority,
      maxFeePerGas: fees.maxFeePerGas * 2n + priority,
    };
    this.#presigned = [];
    for (let i = 0; i < k; i++) {
      this.#presigned.push(await buildPaymentPayload(account, this.#o.requirements));
    }
  }

  /** Fires `k` settle transactions back to back and returns once they have all been accepted by the node. */
  async burst(k: number): Promise<void> {
    const sends: Promise<void>[] = [];
    for (let i = 0; i < k; i++) sends.push(this.#sendOne());
    await Promise.all(sends);
  }

  /** Keeps sending one settle every `everyMs` until `stop()` — the no-signal extractor. */
  continuous(everyMs: number): void {
    this.stopContinuous();
    this.#loop = setInterval(() => {
      void this.#sendOne();
    }, everyMs);
  }

  stopContinuous(): void {
    if (this.#loop) clearInterval(this.#loop);
    this.#loop = null;
  }

  async #sendOne(): Promise<void> {
    if (this.#nonce === null || this.#fees === null) throw new Error("Extractor.prepare first");
    const payload =
      this.#presigned.shift() ??
      (await buildPaymentPayload(this.#o.wallet.account, this.#o.requirements));
    const auth = payload.payload.authorization;
    const { r, s, v } = splitSignature(payload.payload.signature as `0x${string}`);
    const data = encodeFunctionData({
      abi: RoyaltyRouterAbi,
      functionName: "settle",
      args: [
        this.#o.grantId,
        {
          price: this.#o.terms.price,
          licenseId: this.#o.terms.licenseId,
          scope: this.#o.terms.scope,
          ns: this.#o.terms.ns,
          rateLimit: this.#o.terms.rateLimit,
          payees: [...this.#o.terms.payees],
          weights: [...this.#o.terms.weights],
        },
        {
          from: auth.from as Address,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce as Bytes32,
          v,
          r,
          s,
        },
      ],
    });
    const nonce = this.#nonce++;
    const sentAt = this.#o.clock.nowMs();
    try {
      const hash = await this.#o.wallet.sendTransaction({
        to: this.#o.router,
        data,
        gas: this.#o.gas ?? 400_000n,
        nonce,
        ...this.#fees,
      });
      this.attempts.push({
        hash,
        sentAt,
        minedAtMs: null,
        blockNumber: null,
        transactionIndex: null,
        status: "pending",
      });
    } catch {
      // A rejected send (e.g. nonce gap after a dropped tx) is simply not an attempt that reached the pool.
    }
  }

  /** Polls receipts for every attempt until all are mined or `timeoutMs` elapses. */
  async collect(timeoutMs = 10_000, pollMs = 100): Promise<void> {
    const deadline = this.#o.clock.nowMs() + timeoutMs;
    while (this.#o.clock.nowMs() < deadline) {
      const pending = this.attempts.filter((a) => a.status === "pending");
      if (pending.length === 0) return;
      await Promise.all(
        pending.map(async (a) => {
          const receipt = await this.#o.publicClient
            .getTransactionReceipt({ hash: a.hash })
            .catch(() => null);
          if (!receipt) return;
          a.minedAtMs = this.#o.clock.nowMs();
          a.blockNumber = receipt.blockNumber;
          a.transactionIndex = receipt.transactionIndex;
          a.status = receipt.status === "success" ? "success" : "reverted";
        }),
      );
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
