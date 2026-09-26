import type { Bytes32 } from "@firsthand/core";
import type { LockerSession } from "@firsthand/sdk/browser";
import type { AppConfig } from "./config.js";
import { type PendingRescission, updateJournal } from "./journal.js";
import { readerFor } from "./liveness.js";
import type { CaptureClient } from "./locker.js";

/**
 * Withdrawing consent, both ways the protocol offers (README §7.5, §8 claim 1, ADR-0012).
 *
 * **Direct** is one passkey-signed `GrantManager.rescind`, effective at its own block. Simple, and on
 * a public mempool it announces which grant is about to end before it ends — the race the observer
 * bot in §13 is built to win.
 *
 * **Commit-reveal** is the fallback for exactly that: `Rescissions.commit(keccak256(grantId, salt))`
 * carries no signature and names nothing, so it is unattributable in the mempool and needs no passkey
 * tap; then `GrantManager.revealRescind` proves the preimage and **back-dates the end of consent to
 * the commit's block**. Anything served between the two is provably post-consent, which is what makes
 * the commit the timestamp that matters rather than the reveal.
 *
 * The reveal has a deadline: `revealRescind` reverts `RevealWindowElapsed` once
 * `block.number - commitBlock > revealWindowBlocks`. Missing it forfeits the commit, not the grant —
 * a fresh commit or a direct rescission still ends consent, which is why losing the salt is
 * survivable and why this module says so on screen rather than treating it as data loss.
 */
export type RescindMode = "direct" | "commit-reveal";

/** Where a committed withdrawal stands against the chain's head. */
export type CommitState =
  | { kind: "unknown" }
  | { kind: "pending" }
  | { kind: "revealable"; blocksLeft: bigint }
  | { kind: "window-elapsed" };

/**
 * Twin of the contract's check, `block.number - commitBlock > revealWindowBlocks`, so a UI deadline
 * and an on-chain refusal cannot disagree.
 */
export function commitState(
  pending: PendingRescission,
  headBlock: bigint | null,
  windowBlocks: bigint | null,
): CommitState {
  if (pending.commitBlock === undefined) return { kind: "pending" };
  if (headBlock === null || windowBlocks === null) return { kind: "unknown" };
  const elapsed = headBlock - BigInt(pending.commitBlock);
  if (elapsed > windowBlocks) return { kind: "window-elapsed" };
  return { kind: "revealable", blocksLeft: windowBlocks - elapsed };
}

export function pendingFor(
  pendings: readonly PendingRescission[] | undefined,
  grantId: Bytes32,
): PendingRescission | null {
  return pendings?.find((p) => p.grantId === grantId) ?? null;
}

/** The deployment's reveal window; null when there is no chain to ask. */
export async function fetchRevealWindow(
  config: AppConfig,
  client: CaptureClient,
): Promise<bigint | null> {
  if (!client.publicClient) return null;
  try {
    return await readerFor(config, client.publicClient).revealWindowBlocks();
  } catch {
    return null;
  }
}

/**
 * Step one: publish the blind commitment. No passkey tap — `Rescissions.commit` authorises nobody and
 * anyone may relay it, which is the point: the sender carries no information about the principal.
 */
export async function commitRescind(
  session: LockerSession,
  client: CaptureClient,
  grantId: Bytes32,
): Promise<PendingRescission> {
  const plan = session.planCommit(grantId);
  const sent = await session.sendRescind(plan);
  await client.waitForTx?.(sent.txHash, "Withdrawal committed");
  let commitBlock: string | undefined;
  if (client.publicClient) {
    const receipt = await client.publicClient
      .getTransactionReceipt({ hash: sent.txHash })
      .catch(() => null);
    if (receipt) commitBlock = receipt.blockNumber.toString();
  }
  const record: PendingRescission = {
    grantId,
    // `planCommit` always returns both; the SDK types them optional because a direct plan has neither.
    salt: plan.salt as Bytes32,
    commitment: plan.commitment as Bytes32,
    commitTx: sent.txHash,
    ...(commitBlock === undefined ? {} : { commitBlock }),
    at: Date.now(),
  };
  updateJournal(session.locker.principalId, (j) => {
    j.pendingRescissions = [
      ...(j.pendingRescissions ?? []).filter((p) => p.grantId !== grantId),
      record,
    ];
  });
  return record;
}

/** Step two: prove the preimage. Consent ends at the commit's block, not this one. */
export async function revealRescind(
  session: LockerSession,
  client: CaptureClient,
  pending: PendingRescission,
): Promise<Bytes32> {
  const sent = await session.sendRescind(session.planReveal(pending.grantId, pending.salt));
  await client.waitForTx?.(sent.txHash, "Consent withdrawn");
  updateJournal(session.locker.principalId, (j) => {
    const g = j.grants.find((x) => x.grantId === pending.grantId);
    if (g) g.rescindTx = sent.txHash;
    j.pendingRescissions = (j.pendingRescissions ?? []).filter(
      (p) => p.grantId !== pending.grantId,
    );
  });
  return sent.txHash;
}

/** A commit whose window has closed is dead weight; drop it so the row stops offering a reveal. */
export function forgetCommit(principalId: string, grantId: Bytes32): void {
  updateJournal(principalId, (j) => {
    j.pendingRescissions = (j.pendingRescissions ?? []).filter((p) => p.grantId !== grantId);
  });
}

/** The direct path, unchanged in behaviour — here so both modes read from one place. */
export async function directRescind(
  session: LockerSession,
  client: CaptureClient,
  grantId: Bytes32,
): Promise<Bytes32> {
  const sent = await session.sendRescind(session.planRescind(grantId));
  await client.waitForTx?.(sent.txHash, "Consent withdrawn");
  updateJournal(session.locker.principalId, (j) => {
    const g = j.grants.find((x) => x.grantId === grantId);
    if (g) g.rescindTx = sent.txHash;
  });
  return sent.txHash;
}
