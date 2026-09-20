import type { Bytes32 } from "@firsthand/core";

/**
 * What this browser did with its locker, kept locally so history survives the gateway's scan window
 * (a log-backed ledger sees a bounded range of blocks per request) and reloads. Nothing here is a
 * secret: passport ids, grant ids and transaction hashes are all public on chain. Bigints are
 * strings because this is JSON.
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
  delegations?: DelegationEntry[];
}

const KEY = (principalId: string) => `firsthand.journal.${principalId}`;
const EMPTY = (): Journal => ({ deposits: [], grants: [], receipts: [] });

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
}

/** Mutate-and-save in one step; returns the new journal for state updates. */
export function updateJournal(principalId: string, fn: (j: Journal) => void): Journal {
  const j = loadJournal(principalId);
  fn(j);
  saveJournal(principalId, j);
  return j;
}
