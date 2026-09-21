import { useSyncExternalStore } from "react";

/** A media query as React state; false during SSR-less first paint when `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia === "undefined") return () => {};
      const mq = matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof matchMedia === "undefined" ? false : matchMedia(query).matches),
    () => false,
  );
}
