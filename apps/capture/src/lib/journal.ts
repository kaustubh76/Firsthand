import type { Bytes32 } from "@firsthand/core";

/**
 * What this browser did with its locker, kept locally so history survives the gateway's scan window
 * (a log-backed ledger sees a bounded range of blocks per request) and reloads. Nothing here is key
 * material: passport ids, grant ids and transaction hashes are all public on chain. The one value
 * that is not yet public is a `PendingRescission.salt`, and it becomes public the moment its
 * rescission is revealed — see the note on that type. Bigints are strings because this is JSON.
 */
export interface DepositEntry {
  readonly passportId: Bytes32;
  readonly label: string;
  readonly kind: "text" | "media" | "import";
  readonly ns: number;
  readonly blobId: Bytes32;
  readonly at: number;
  anchorTx?: Bytes32;
  published?: boolean;
}

export interface GrantEntry {
  readonly grantId: Bytes32;
  readonly granteeCard: Bytes32;
  readonly ns: number;
  readonly termsHash: Bytes32;
  readonly txHash: Bytes32;
  readonly at: number;
  rescindTx?: Bytes32;
  /** The grantee's ERC-8004 agent id, when the request carried one and the binding verified. */
  agentId?: string;
  agentName?: string;
}

export interface ReceiptEntry {
  readonly receiptId: Bytes32;
  readonly grantId: Bytes32;
  readonly passportId: Bytes32;
  readonly txHash: Bytes32 | null;
  readonly paidUnits: string;
  readonly at: number;
}

/**
 * A commit-reveal rescission this browser started (README §8 claim 1's fallback, ADR-0012).
 *
 * `Rescissions.commit` publishes `keccak256(grantId, salt)` and nothing else, so the mempool cannot
 * tell which grant is ending or whose it is; `GrantManager.revealRescind` then back-dates the end of
 * consent to the **commit's block**, which is the property the two steps buy. The salt is what links
 * them, so it has to survive a reload and lives here. It is not key material and it is published at
 * reveal; until then its only job is unlinkability. Losing it costs nothing irreversible — the grant
 * is still live and a direct rescission still ends it.
 */
export interface PendingRescission {
  readonly grantId: Bytes32;
  readonly salt: Bytes32;
  readonly commitment: Bytes32;
  readonly commitTx: Bytes32;
  /** The block the commitment landed in — what the reveal back-dates consent's end to. */
  commitBlock?: string;
  readonly at: number;
}

/** A deposit delegation issued from this browser — scope only, never the code itself. */
export interface DelegationEntry {
  readonly ns: number;
  readonly epoch: string;
  readonly at: number;
}

export interface Journal {
  enrolBlock?: string;
  enrolTx?: Bytes32;
  attestTx?: Bytes32;
  deposits: DepositEntry[];
  grants: GrantEntry[];
  receipts: ReceiptEntry[];
  /** Commit-reveal withdrawals committed but not yet revealed. */
  pendingRescissions?: PendingRescission[];
  delegations?: DelegationEntry[];
  /** Beats of the three-minute script this browser has been through (the journey rail reads them). */
  refusalAt?: number;
  manifestAt?: number;
  evidenceSeenAt?: number;
}

const KEY = (principalId: string) => `firsthand.journal.${principalId}`;
const EMPTY = (): Journal => ({ deposits: [], grants: [], receipts: [] });

// One snapshot per principal, replaced on every save, so React can subscribe to the journal as an
// external store: a deposit landed on the Capture tab shows up in the Locker's tiles at once.
const snapshots = new Map<string, Journal>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export function loadJournal(principalId: string): Journal {
  try {
    const raw = localStorage.getItem(KEY(principalId));
    if (!raw) return EMPTY();
    const parsed = JSON.parse(raw) as Partial<Journal>;
    return { ...EMPTY(), ...parsed };
  } catch {
    return EMPTY();
  }
}

export function saveJournal(principalId: string, journal: Journal): void {
  try {
    localStorage.setItem(KEY(principalId), JSON.stringify(journal));
  } catch {
    // storage unavailable: the session still works, it just will not remember across reloads
  }
  snapshots.set(principalId, journal);
  notify();
}

/** The current journal, referentially stable until the next save (for useSyncExternalStore). */
export function journalSnapshot(principalId: string): Journal {
  const cached = snapshots.get(principalId);
  if (cached) return cached;
  const loaded = loadJournal(principalId);
  snapshots.set(principalId, loaded);
  return loaded;
}

export function subscribeJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget what this browser recorded about a locker; the chain keeps the truth. */
export function clearJournal(principalId: string): void {
  try {
    localStorage.removeItem(KEY(principalId));
  } catch {
    // nothing to remove
  }
  snapshots.set(principalId, EMPTY());
  notify();
}

/** Mutate-and-save in one step; returns the new journal for state updates. */
export function updateJournal(principalId: string, fn: (j: Journal) => void): Journal {
  const j = loadJournal(principalId);
  fn(j);
  saveJournal(principalId, j);
  return j;
}
