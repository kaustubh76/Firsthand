/** Bounded in-memory TTL map — the fallback behind Redis-shaped ports in tests and single-node deploys. */
export interface TTLStoreOptions {
  readonly defaultTtlMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TTLStore<T> {
  readonly #map = new Map<string, Entry<T>>();
  readonly #ttl: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: TTLStoreOptions) {
    this.#ttl = options.defaultTtlMs;
    this.#max = options.maxEntries ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  set(key: string, value: T, ttlMs = this.#ttl): void {
    this.sweep();
    if (!this.#map.has(key) && this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  get(key: string): T | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }

  get size(): number {
    this.sweep();
    return this.#map.size;
  }

  private sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt <= now) this.#map.delete(key);
    }
  }
}
