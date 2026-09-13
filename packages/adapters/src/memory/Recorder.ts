/**
 * Shared behaviour of every in-memory double: records calls for assertions and supports one-shot
 * fault injection (`failNext`) so retry, breaker and error paths are testable without a network.
 */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly at: number;
}

export class Recorder {
  readonly calls: RecordedCall[] = [];
  #pendingFailure: unknown = undefined;
  #hasPendingFailure = false;

  /** The next recorded call throws `error` instead of executing. */
  failNext(error: unknown): void {
    this.#pendingFailure = error;
    this.#hasPendingFailure = true;
  }

  protected record(method: string, ...args: readonly unknown[]): void {
    this.calls.push({ method, args, at: Date.now() });
    if (this.#hasPendingFailure) {
      const error = this.#pendingFailure;
      this.#pendingFailure = undefined;
      this.#hasPendingFailure = false;
      throw error;
    }
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.#pendingFailure = undefined;
    this.#hasPendingFailure = false;
  }
}
