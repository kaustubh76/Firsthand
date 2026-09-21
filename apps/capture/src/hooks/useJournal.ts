import type { Bytes32 } from "@firsthand/core";
import { useCallback, useSyncExternalStore } from "react";
import { type Journal, journalSnapshot, subscribeJournal, updateJournal } from "../lib/journal.js";

const NONE: Journal = { deposits: [], grants: [], receipts: [] };

/**
 * This browser's record of a locker as live state: every screen sees the same journal. With no
 * principal yet (before the passkey), an empty, frozen journal.
 */
export function useJournal(
  principalId: Bytes32 | null,
): readonly [Journal, (fn: (journal: Journal) => void) => void] {
  const journal = useSyncExternalStore(
    subscribeJournal,
    () => (principalId ? journalSnapshot(principalId) : NONE),
    () => (principalId ? journalSnapshot(principalId) : NONE),
  );
  const mutate = useCallback(
    (fn: (journal: Journal) => void) => {
      if (principalId) updateJournal(principalId, fn);
    },
    [principalId],
  );
  return [journal, mutate] as const;
}
