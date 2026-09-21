import { createContext, useContext } from "react";
import type { IconName } from "../ui/Icon.js";

export type Route = "capture" | "locker" | "recall" | "verify" | "evidence";

export const ROUTES: readonly { id: Route; label: string; icon: IconName }[] = [
  { id: "capture", label: "Capture", icon: "camera" },
  { id: "locker", label: "Locker", icon: "lock" },
  { id: "recall", label: "Recall", icon: "replay" },
  { id: "verify", label: "Verify", icon: "shield" },
  { id: "evidence", label: "Evidence", icon: "chart" },
];

export const isRoute = (value: string | null | undefined): value is Route =>
  ROUTES.some((r) => r.id === value);

/**
 * No router: the route is state in App, mirrored into `location.hash`. `go()` may name a target
 * card id; App scrolls to it and moves focus there once the route has rendered.
 */
export interface Navigator {
  readonly route: Route;
  readonly target: string | null;
  go(route: Route, target?: string): void;
}

export const NavigationContext = createContext<Navigator>({
  route: "capture",
  target: null,
  go: () => {},
});

export const useNavigation = (): Navigator => useContext(NavigationContext);

/** The route a fresh load starts on: a shared link or a request wins, then the hash, then Capture. */
export function initialRoute(input: {
  sharedPrincipal: boolean;
  hasRequests: boolean;
  hash: string;
}): Route {
  if (input.sharedPrincipal) return "verify";
  if (input.hasRequests) return "locker";
  const fromHash = input.hash.replace(/^#/, "");
  return isRoute(fromHash) ? fromHash : "capture";
}
