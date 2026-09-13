import { isFirsthandError, TransportError } from "@firsthand/core";

/**
 * Retry with exponential backoff and full jitter. Retries only errors the predicate accepts — by
 * default `FirsthandError.retryable === true` — so a validation failure never loops.
 */
export interface RetryOptions {
  /** Maximum retries after the first attempt. Default 3. */
  readonly retries?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Multiplier per attempt. Default 2. */
  readonly factor?: number;
  readonly jitter?: boolean;
  readonly retryOn?: (error: unknown, attempt: number) => boolean;
  readonly signal?: AbortSignal;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export function defaultRetryOn(error: unknown): boolean {
  return isFirsthandError(error) ? error.retryable : false;
}

export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseMs ?? 100;
  const max = options.maxMs ?? 5_000;
  const factor = options.factor ?? 2;
  const raw = Math.min(max, base * factor ** attempt);
  if (options.jitter === false) return raw;
  return Math.floor((options.random ?? Math.random)() * raw);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): TransportError {
  return new TransportError("FH_TRANSPORT", "operation aborted", {
    retryable: false,
    cause: signal?.reason,
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const retryOn = options.retryOn ?? defaultRetryOn;
  const doSleep = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !retryOn(error, attempt)) throw error;
      const delay = backoffDelay(attempt, options);
      options.onRetry?.(error, attempt, delay);
      await doSleep(delay, options.signal);
    }
  }
}
