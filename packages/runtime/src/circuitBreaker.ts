import { TransportError } from "@firsthand/core";

/**
 * Circuit breaker: after `failureThreshold` consecutive failures the circuit opens and calls fail
 * fast with `FH_CIRCUIT_OPEN` until `resetMs` elapses; one trial call then half-opens it.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  readonly name: string;
  readonly failureThreshold?: number;
  readonly resetMs?: number;
  /** Which errors count as failures. Default: all. */
  readonly isFailure?: (error: unknown) => boolean;
  readonly now?: () => number;
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  readonly name: string;
  #state: CircuitState = "closed";
  #failures = 0;
  #openedAt = 0;
  readonly #threshold: number;
  readonly #resetMs: number;
  readonly #isFailure: (error: unknown) => boolean;
  readonly #now: () => number;
  readonly #onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.#threshold = options.failureThreshold ?? 5;
    this.#resetMs = options.resetMs ?? 30_000;
    this.#isFailure = options.isFailure ?? (() => true);
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#resetMs) {
      this.transition("half-open");
    }
    return this.#state;
  }

  get failures(): number {
    return this.#failures;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      throw new TransportError("FH_CIRCUIT_OPEN", `${this.name}: circuit open`, {
        retryable: false,
        context: {
          breaker: this.name,
          retryAfterMs: this.#resetMs - (this.#now() - this.#openedAt),
        },
      });
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.#isFailure(error)) this.onFailure();
      throw error;
    }
  }

  reset(): void {
    this.#failures = 0;
    this.transition("closed");
  }

  private onSuccess(): void {
    this.#failures = 0;
    if (this.#state !== "closed") this.transition("closed");
  }

  private onFailure(): void {
    this.#failures++;
    if (this.#state === "half-open" || this.#failures >= this.#threshold) {
      this.#openedAt = this.#now();
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#onStateChange?.(from, to);
  }
}
