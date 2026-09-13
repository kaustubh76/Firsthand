import { CryptoError } from "@firsthand/core";

/** Overwrites a buffer with zeros. Best effort — JS engines may keep copies, see SECURITY.md §3. */
export function zeroize(...buffers: readonly Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

/**
 * Owner handle for secret bytes.
 *
 * - The bytes are reachable only through `use()`, which prevents accidental capture in closures,
 *   logs or JSON: `JSON.stringify(secret)` yields `"[SecretBytes]"`, `String(secret)` likewise.
 * - `dispose()` zeroizes and makes every further `use()` throw.
 * - `expose()` exists for the few call sites that must hand raw bytes to a cipher; it is named
 *   so that a grep for it enumerates every such site.
 */
export class SecretBytes {
  static readonly REDACTED = "[SecretBytes]";
  readonly #bytes: Uint8Array;
  readonly #label: string;
  #disposed = false;

  constructor(bytes: Uint8Array, label = "secret") {
    this.#bytes = bytes;
    this.#label = label;
  }

  get length(): number {
    return this.#bytes.length;
  }

  get label(): string {
    return this.#label;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Runs `fn` with the raw bytes. Do not retain the reference past the callback. */
  use<T>(fn: (bytes: Uint8Array) => T): T {
    this.assertLive();
    return fn(this.#bytes);
  }

  /** Returns the live buffer. Every caller is an audit point. */
  expose(): Uint8Array {
    this.assertLive();
    return this.#bytes;
  }

  /** Copies into a fresh handle (e.g. to give a derived key its own lifetime). */
  clone(label = this.#label): SecretBytes {
    this.assertLive();
    return new SecretBytes(new Uint8Array(this.#bytes), label);
  }

  dispose(): void {
    if (this.#disposed) return;
    zeroize(this.#bytes);
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  toJSON(): string {
    return SecretBytes.REDACTED;
  }

  toString(): string {
    return SecretBytes.REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SecretBytes(${this.#label}, ${this.#bytes.length} bytes)`;
  }

  private assertLive(): void {
    if (this.#disposed) {
      throw new CryptoError(`${this.#label}: secret has been disposed`, {
        context: { label: this.#label },
      });
    }
  }
}
