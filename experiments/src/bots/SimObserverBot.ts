import type { Clock } from "../harness/Clock.js";
import type { RaceSample } from "../metrics/raceWindow.js";

export interface SimObserverBotOptions {
  /** Whether the bot can see the rescission before inclusion (public mempool) or not (BTX). */
  readonly seesMempool: boolean;
  /** How long a bulk extraction takes once started. */
  readonly extractionMs: number;
}

export interface RaceInput {
  readonly rescindBroadcastMs: number;
  /** Broadcast → inclusion latency of the rescission. */
  readonly inclusionDelayMs: number;
  readonly clock: Clock;
}

/**
 * Adversary model for S3 (README §13 row 1). With mempool visibility the bot starts extracting the
 * instant it sees the rescind; without it, the bot only learns at inclusion — too late by construction.
 * Timing-only simulation for the memory arm; `ObserverBot` is the real one over a mempool feed.
 */
export class SimObserverBot {
  readonly #options: SimObserverBotOptions;

  constructor(options: SimObserverBotOptions) {
    this.#options = options;
  }

  race(input: RaceInput): Promise<RaceSample> {
    const effective = input.rescindBroadcastMs + input.inclusionDelayMs;
    if (!this.#options.seesMempool) {
      // Learns at inclusion: extraction starts after consent has already ended.
      return Promise.resolve({
        rescindBroadcastMs: input.rescindBroadcastMs,
        rescindEffectiveMs: effective,
        extractionCompleteMs: null,
      });
    }
    const complete = input.rescindBroadcastMs + this.#options.extractionMs;
    return Promise.resolve({
      rescindBroadcastMs: input.rescindBroadcastMs,
      rescindEffectiveMs: effective,
      extractionCompleteMs: complete < effective ? complete : null,
    });
  }
}
