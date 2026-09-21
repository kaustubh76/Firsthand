import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { ToastHost } from "../ui/Toast.js";

export type ToastTone = "info" | "success" | "error" | "pending";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string | undefined;
  /** A transaction hash to show shortened with a copy button. */
  readonly hash?: string | undefined;
  readonly action?: { label: string; onClick?: () => void; href?: string } | undefined;
  /** Sticky toasts stay until dismissed (errors); pending ones stay until updated. */
  readonly sticky?: boolean | undefined;
}

export interface Toaster {
  readonly toasts: readonly Toast[];
  push(toast: Omit<Toast, "id">): number;
  update(id: number, patch: Partial<Omit<Toast, "id">>): void;
  dismiss(id: number): void;
}

const TTL_MS: Record<ToastTone, number | null> = {
  info: 5_000,
  success: 4_500,
  error: null,
  pending: null,
};
/** At most this many on screen; the oldest non-sticky one makes room. */
const MAX_VISIBLE = 3;

const ToastContext = createContext<Toaster>({
  toasts: [],
  push: () => 0,
  update: () => {},
  dismiss: () => {},
});

/**
 * Nothing the app does on chain is silent: a relayed transaction, a landed deposit, a failure —
 * each is a toast. Pending toasts wait for `update()`; successes fade; errors stay until read.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback(
    (id: number, tone: ToastTone, sticky: boolean | undefined) => {
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.delete(id);
      const ttl = sticky ? null : TTL_MS[tone];
      if (ttl !== null)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ttl),
        );
    },
    [dismiss],
  );

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((list) => {
        const next = [...list, { ...toast, id }];
        while (next.length > MAX_VISIBLE) {
          const i = next.findIndex((t) => t.tone !== "pending" && !t.sticky);
          if (i === -1) break;
          const [gone] = next.splice(i, 1);
          if (gone) {
            const timer = timers.current.get(gone.id);
            if (timer) clearTimeout(timer);
            timers.current.delete(gone.id);
          }
        }
        return next;
      });
      arm(id, toast.tone, toast.sticky);
      return id;
    },
    [arm],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.tone) arm(id, patch.tone, patch.sticky);
    },
    [arm],
  );

  const value = useMemo<Toaster>(
    () => ({ toasts, push, update, dismiss }),
    [toasts, push, update, dismiss],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export const useToasts = (): Toaster => useContext(ToastContext);
