import { useCallback, useRef, useState } from "react";
import { reportFailure } from "../lib/failures.js";

export interface AsyncActions<K extends string> {
  /** Which action is running; siblings disable themselves while one is (one relayer nonce). */
  readonly busy: K | null;
  readonly error: string | null;
  /** Which action the error belongs to, so a card shows only its own failure. */
  readonly errorKey: K | null;
  run(key: K, fn: () => Promise<void>): Promise<boolean>;
  is(key: K): boolean;
  /** The error message when it belongs to `key` (or to any key matching `prefix`). */
  errorFor(key: K | ((k: K) => boolean)): string | null;
  clearError(): void;
}

/**
 * The one way a screen runs something that can fail: it names the action, the hook holds the
 * pending flag and the sentence a person reads when it fails. Replaces the hand-rolled
 * `run(label, fn)` every route used to carry.
 */
export function useAsyncActions<K extends string = string>(options?: {
  explain?: ((error: unknown) => string) | undefined;
  onError?: ((message: string, key: K) => void) | undefined;
}): AsyncActions<K> {
  const [busy, setBusy] = useState<K | null>(null);
  const [failure, setFailure] = useState<{ key: K; message: string } | null>(null);
  const opts = useRef(options);
  opts.current = options;
  const run = useCallback(async (key: K, fn: () => Promise<void>) => {
    setBusy(key);
    setFailure(null);
    try {
      await fn();
      return true;
    } catch (e) {
      const message = (opts.current?.explain ?? reportFailure)(e);
      setFailure({ key, message });
      opts.current?.onError?.(message, key);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  const is = useCallback((key: K) => busy === key, [busy]);
  const errorFor = useCallback(
    (key: K | ((k: K) => boolean)) => {
      if (!failure) return null;
      const match = typeof key === "function" ? key(failure.key) : failure.key === key;
      return match ? failure.message : null;
    },
    [failure],
  );
  const clearError = useCallback(() => setFailure(null), []);
  return {
    busy,
    error: failure?.message ?? null,
    errorKey: failure?.key ?? null,
    run,
    is,
    errorFor,
    clearError,
  };
}
