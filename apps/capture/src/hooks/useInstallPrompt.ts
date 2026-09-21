import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const standalone = () =>
  typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches;

/** Chromium's install prompt, held until the person asks for it; "installed" from display-mode. */
export function useInstallPrompt(): {
  canInstall: boolean;
  installed: boolean;
  prompt: () => Promise<"accepted" | "dismissed" | "unavailable">;
} {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(standalone);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const prompt = useCallback(async () => {
    if (!deferred) return "unavailable" as const;
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setDeferred(null);
      return outcome;
    } catch {
      return "unavailable" as const;
    }
  }, [deferred]);
  return { canInstall: deferred !== null && !installed, installed, prompt };
}
