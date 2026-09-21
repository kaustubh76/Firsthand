import type { Bytes32 } from "@firsthand/core";
import type { LockerSession } from "@firsthand/sdk/browser";
import { updateJournal } from "./journal.js";
import type { CaptureClient } from "./locker.js";

/**
 * Putting a locker on chain: enroll the principal, then attest this epoch's deposit-key root. Both
 * ride the relay. `attest` reads what `enroll` wrote, so it must wait for inclusion — relaying
 * returns as soon as the gateway accepts a transaction, not when it lands. Shared by every screen
 * that can be blocked on activation, so the judge activates where they are.
 */
export interface Activated {
  readonly enrolTx: Bytes32;
  readonly attestTx: Bytes32;
  readonly enrolBlock: string | null;
}

export async function activate(session: LockerSession, client: CaptureClient): Promise<Activated> {
  const principalId = session.locker.principalId;
  const enrolled = await session.enroll();
  await client.waitForTx?.(enrolled.txHash, "Enrolled");
  const attested = await session.attest();
  await client.waitForTx?.(attested.txHash, "Attested");
  let enrolBlock: string | null = null;
  if (client.publicClient) {
    const receipt = await client.publicClient.getTransactionReceipt({ hash: enrolled.txHash });
    enrolBlock = receipt.blockNumber.toString();
  }
  updateJournal(principalId, (j) => {
    j.enrolTx = enrolled.txHash;
    j.attestTx = attested.txHash;
    if (enrolBlock) j.enrolBlock = enrolBlock;
  });
  return { enrolTx: enrolled.txHash, attestTx: attested.txHash, enrolBlock };
}

/** A new epoch needs a fresh root; the principal stays enrolled. */
export async function reattest(session: LockerSession, client: CaptureClient): Promise<Bytes32> {
  const attested = await session.attest();
  await client.waitForTx?.(attested.txHash, "Attested");
  updateJournal(session.locker.principalId, (j) => {
    j.attestTx = attested.txHash;
  });
  return attested.txHash;
}
