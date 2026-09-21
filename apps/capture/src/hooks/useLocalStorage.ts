import { useCallback, useState } from "react";

/**
 * A piece of state mirrored into localStorage. Storage may be unavailable (private mode, quota):
 * every access is guarded, and the in-memory value still works for the session.
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
  parse: (raw: unknown) => T | null = (raw) => raw as T,
): readonly [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return parse(JSON.parse(raw)) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // storage unavailable: the value still lives for this session
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set] as const;
}
