import { useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage.js";
import { useMediaQuery } from "./useMediaQuery.js";

export type ThemePref = "system" | "light" | "dark";

const KEY = "firsthand.theme";
const THEME_COLOR: Record<"light" | "dark", string> = { dark: "#0a0b10", light: "#f5f5fa" };

const parsePref = (raw: unknown): ThemePref | null =>
  raw === "system" || raw === "light" || raw === "dark" ? raw : null;

/**
 * Dark is the default; the OS can choose light; a person can pin either in Settings. The choice is
 * applied as `<html data-theme>` (tokens.css reads it) and mirrored into `<meta name="theme-color">`
 * so the browser chrome matches on a phone.
 */
export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (pref: ThemePref) => void;
} {
  const [pref, setPref] = useLocalStorage<ThemePref>(KEY, "system", parsePref);
  const osLight = useMediaQuery("(prefers-color-scheme: light)");
  const resolved: "light" | "dark" = pref === "system" ? (osLight ? "light" : "dark") : pref;
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") delete root.dataset["theme"];
    else root.dataset["theme"] = pref;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      // Two metas carry `media` for the OS scheme; with a pinned theme both must agree.
      meta.content = THEME_COLOR[resolved];
    }
  }, [pref, resolved]);
  return { pref, resolved, setPref };
}
