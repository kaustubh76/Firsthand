import { GrantManagerAbi, RescissionsAbi } from "@firsthand/contracts/abi";
import type { Address, Bytes32 } from "@firsthand/core";
import { decodeFunctionData, getAbiItem, toFunctionSelector } from "viem";
import type { Clock } from "../harness/Clock.js";
import type { MempoolFeed, PendingTx } from "./MempoolFeed.js";

export type Trigger = (tx: PendingTx) => boolean;

/** Fires on a pending `GrantManager.rescind` for exactly this grant (the B2 public-mempool observer). */
export function rescindTrigger(grantManager: Address, grantId: Bytes32): Trigger {
  const selector = toFunctionSelector(getAbiItem({ abi: GrantManagerAbi, name: "rescind" }));
  return (tx) => {
    if (tx.to !== grantManager || !tx.input.startsWith(selector)) return false;
    try {
      const { args } = decodeFunctionData({ abi: GrantManagerAbi, data: tx.input });
      return (args as readonly unknown[])[0] === grantId;
    } catch {
      return false;
    }
  };
}

/**
 * Fires on *any* pending `Rescissions.commit`. The commitment is keccak(grantId ‖ salt), so the
 * observer cannot tell whose consent is ending — the paranoid bot reacts to every commit it sees.
 */
export function commitTrigger(rescissions: Address): Trigger {
  const selector = toFunctionSelector(getAbiItem({ abi: RescissionsAbi, name: "commit" }));
  return (tx) => tx.to === rescissions && tx.input.startsWith(selector);
}

export interface ObserverBotOptions {
  readonly feed: MempoolFeed;
  readonly trigger: Trigger;
  readonly onTrigger: () => Promise<void>;
  readonly clock: Clock;
}

/**
 * Adversary model for S3 (README §13 row 1): watches a mempool feed and, the instant the trigger
 * matches, starts extracting. Records when it saw the signal; fires at most once per arming.
 */
export class ObserverBot {
  readonly #o: ObserverBotOptions;
  #fired = false;
  detectedAtMs: number | null = null;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: ObserverBotOptions) {
    this.#o = options;
  }

  arm(): void {
    this.#fired = false;
    this.detectedAtMs = null;
    this.#o.feed.start((tx) => {
      if (this.#fired || !this.#o.trigger(tx)) return;
      this.#fired = true;
      this.detectedAtMs = this.#o.clock.nowMs();
      this.#pending = this.#o.onTrigger().catch(() => undefined);
    });
  }

  async disarm(): Promise<void> {
    this.#o.feed.stop();
    await this.#pending;
  }
}
