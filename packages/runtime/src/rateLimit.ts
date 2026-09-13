/**
 * Rate-limiter port (README §7.5 "anti-bulk-scrape throttle"). The chain-side counter in
 * ReceiptLedger is the source of truth; gateway limiters are a pre-filter. A memory token bucket
 * ships here; Redis-backed implementations plug in behind the same interface.
 */
export interface RateDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Unix ms at which at least one token will be available again. */
  readonly resetAt: number;
}

export interface RateLimiter {
  consume(key: string, cost?: number): Promise<RateDecision>;
}

export interface TokenBucketOptions {
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
  readonly now?: () => number;
  /** Maximum tracked keys before least-recently-used buckets are evicted. Default 10 000. */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class MemoryTokenBucketLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refill: number;
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillPerSecond < 0) {
      throw new RangeError("token bucket: capacity must be > 0 and refill >= 0");
    }
    this.#capacity = options.capacity;
    this.#refill = options.refillPerSecond;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  consume(key: string, cost = 1): Promise<RateDecision> {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      bucket = { tokens: this.#capacity, updatedAt: now };
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refill);
      bucket.updatedAt = now;
      this.#buckets.delete(key); // re-insert to keep Map order LRU-ish
    }
    this.#buckets.set(key, bucket);

    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    const deficit = Math.max(0, cost - bucket.tokens);
    const resetAt =
      this.#refill > 0
        ? now + Math.ceil((deficit / this.#refill) * 1000)
        : Number.POSITIVE_INFINITY;
    return Promise.resolve({ allowed, remaining: Math.floor(bucket.tokens), resetAt });
  }

  get size(): number {
    return this.#buckets.size;
  }
}
