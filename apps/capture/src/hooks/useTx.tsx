import type { Bytes32 } from "@firsthand/core";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { txUrl } from "../lib/explorer.js";
import { explainFailure } from "../lib/failures.js";
import type { CaptureClient } from "../lib/locker.js";
import { useToasts } from "./useToasts.js";

export type TxStatus = "pending" | "mined" | "failed";

export interface TrackedTx {
  readonly hash: Bytes32;
  readonly label: string;
  readonly status: TxStatus;
  readonly sentAt: number;
  readonly minedAt?: number | undefined;
  readonly error?: string | undefined;
}

export interface TxTracker {
  readonly txs: readonly TrackedTx[];
  readonly pendingCount: number;
  /** Wait for a relayed transaction, showing it as a toast and a timeline row along the way. */
  track(hash: Bytes32, label: string): Promise<void>;
  clear(): void;
  /** The client with `waitForTx` wrapped by `track()`, for the routes. */
  readonly client: CaptureClient | null;
}

const noop: TxTracker = {
  txs: [],
  pendingCount: 0,
  track: async () => {},
  clear: () => {},
  client: null,
};

export const TxContext = createContext<TxTracker>(noop);
export const useTx = (): TxTracker => useContext(TxContext);

/**
 * Every relayed transaction the browser waits for passes through here, so a judge sees "relayed ·
 * waiting for a block" and then the mined hash with its explorer link — never a frozen button.
 * `track()` rethrows so the calling action still fails properly; it never rejects unobserved.
 */
export function useTxTracker(raw: CaptureClient | null, chainId: bigint | null): TxTracker {
  const toasts = useToasts();
  const [txs, setTxs] = useState<TrackedTx[]>([]);
  const toastIds = useRef(new Map<string, number>());

  const patch = useCallback((hash: Bytes32, p: Partial<TrackedTx>) => {
    setTxs((list) => list.map((t) => (t.hash === hash ? { ...t, ...p } : t)));
  }, []);

  const track = useCallback(
    async (hash: Bytes32, label: string) => {
      const wait = raw?.waitForTx;
      if (!wait) return;
      const href = chainId === null ? null : txUrl(chainId, hash);
      setTxs((list) =>
        [{ hash, label, status: "pending" as const, sentAt: Date.now() }, ...list].slice(0, 50),
      );
      const toastId = toasts.push({
        tone: "pending",
        title: `${label} — relayed`,
        detail: "waiting for a block",
        hash,
      });
      toastIds.current.set(hash, toastId);
      try {
        await wait(hash);
        patch(hash, { status: "mined", minedAt: Date.now() });
        toasts.update(toastId, {
          tone: "success",
          title: `${label} — mined`,
          detail: undefined,
          ...(href ? { action: { label: "View ↗", href } } : {}),
        });
      } catch (e) {
        const message = explainFailure(e);
        patch(hash, { status: "failed", error: message });
        toasts.update(toastId, {
          tone: "error",
          title: `${label} — not included`,
          detail: message,
        });
        throw e;
      }
    },
    [raw, chainId, toasts, patch],
  );

  const clear = useCallback(() => setTxs([]), []);

  const client = useMemo<CaptureClient | null>(() => {
    if (!raw) return null;
    if (!raw.waitForTx) return raw;
    return { ...raw, waitForTx: (hash, label) => track(hash, label ?? "transaction") };
  }, [raw, track]);

  return useMemo<TxTracker>(
    () => ({
      txs,
      pendingCount: txs.filter((t) => t.status === "pending").length,
      track,
      clear,
      client,
    }),
    [txs, track, clear, client],
  );
}
