import type { ConsentEvent } from "@firsthand/adapters/client";
import type { LockerSession } from "@firsthand/sdk/browser";
import type { AsyncActions } from "../../hooks/useAsyncActions.js";
import type { AppConfig } from "../../lib/config.js";
import type { Journal } from "../../lib/journal.js";
import type { CaptureClient } from "../../lib/locker.js";

export type LockerAction =
  | "activate"
  | "attest"
  | "anchor"
  | "manifest"
  | `approve:${string}`
  | `rescind:${string}`
  | `commit:${string}`
  | `reveal:${string}`
  | "device:register"
  | `device:revoke:${string}`;

/** What every card on the Locker shares. */
export interface LockerCtx {
  readonly session: LockerSession;
  readonly config: AppConfig;
  readonly client: CaptureClient;
  readonly journal: Journal;
  readonly mutate: (fn: (j: Journal) => void) => void;
  readonly actions: AsyncActions<LockerAction>;
  readonly events: readonly ConsentEvent[] | null;
  readonly refreshLedger: () => Promise<void>;
}
