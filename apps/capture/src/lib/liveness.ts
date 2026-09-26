import { OnchainGrantReader, type PrincipalLivenessView } from "@firsthand/adapters/client";
import {
  type Bytes32,
  LIVENESS_GRACE_EPOCHS,
  PrincipalStatus,
  principalEffectiveStatus,
} from "@firsthand/core";
import type { PublicClient } from "viem";
import type { AppConfig } from "./config.js";

/**
 * Where the principal stands this epoch, so the app can say "attest first" instead of failing on a
 * revert.
 *
 * Two different facts live here, and conflating them is a bug this module used to have. The chain's
 * liveness rule is a dead-man's switch with slack: `PrincipalRegistry.effectiveStatus` is FROZEN
 * while a scheduled thaw has not arrived, and otherwise `withinGrace(now, lastAttested, 2)` —
 * so a principal who attested last epoch is still **live**, and their grants still serve. Anchoring
 * is the stricter question: a passport is anchored under the deposit-key root of *its own* epoch, so
 * a new capture needs an attestation for the current epoch specifically (README §7.3, §7.6,
 * ADR-0008/0012).
 *
 * `live.attestedThisEpoch` is therefore what gates depositing, and `kind === "live"` is what gates
 * granting, approving a request and being served. The rule itself is not restated here: it is
 * `principalEffectiveStatus`, the same function the gateway and the golden vectors use, which is the
 * twin of the Solidity.
 */
export type Liveness =
  | { kind: "unknown" }
  | { kind: "not-enrolled" }
  | { kind: "live"; epoch: bigint; lastAttested: bigint; attestedThisEpoch: boolean }
  /** Out of grace: the chain reads FROZEN, and no thaw is scheduled until the next attest. */
  | { kind: "lapsed"; epoch: bigint; lastAttested: bigint }
  | { kind: "frozen"; thawEpoch: bigint };

export function livenessOf(view: PrincipalLivenessView | null, epochNow: bigint): Liveness {
  if (view === null) return { kind: "not-enrolled" };
  if (principalEffectiveStatus(view, epochNow) === PrincipalStatus.ACTIVE) {
    return {
      kind: "live",
      epoch: epochNow,
      lastAttested: view.lastAttestedEpoch,
      attestedThisEpoch: view.lastAttestedEpoch >= epochNow,
    };
  }
  // FROZEN for one of two reasons, and they need different words: a thaw already scheduled and not
  // yet reached, or grace simply run out.
  if (view.thawEpoch !== 0n && epochNow < view.thawEpoch) {
    return { kind: "frozen", thawEpoch: view.thawEpoch };
  }
  return { kind: "lapsed", epoch: epochNow, lastAttested: view.lastAttestedEpoch };
}

/** True when a new capture can be anchored: this epoch's deposit-key root is attested. */
export function canAnchor(l: Liveness): boolean {
  return l.kind === "live" && l.attestedThisEpoch;
}

/** True when the chain would honour a grant, an approval or a serve. */
export function canGrant(l: Liveness): boolean {
  return l.kind === "live";
}

export function describeLiveness(l: Liveness): string {
  switch (l.kind) {
    case "unknown":
      return "";
    case "not-enrolled":
      return "not on chain yet — Locker → Activate";
    case "live":
      return l.attestedThisEpoch
        ? `attested for epoch ${l.epoch}`
        : `grants live through epoch ${l.lastAttested + LIVENESS_GRACE_EPOCHS}; attest to anchor new captures — Locker → Re-attest`;
    case "lapsed":
      return `attestation lapsed after epoch ${l.lastAttested} — grants are frozen until you re-attest (Locker → Re-attest)`;
    case "frozen":
      return `frozen until epoch ${l.thawEpoch} (a gap in attestation schedules a thaw)`;
  }
}

export function readerFor(config: AppConfig, publicClient: PublicClient): OnchainGrantReader {
  return new OnchainGrantReader({
    publicClient: publicClient as never,
    grantManager: config.grantManager,
    principalRegistry: config.principalRegistry,
    receiptLedger: config.receiptLedger,
  });
}

export async function fetchLiveness(
  config: AppConfig,
  publicClient: PublicClient | null,
  principalId: Bytes32,
  epochNow: bigint,
): Promise<Liveness> {
  if (!config.live || !publicClient) return { kind: "unknown" };
  try {
    return livenessOf(
      await readerFor(config, publicClient).principalLiveness(principalId),
      epochNow,
    );
  } catch {
    return { kind: "unknown" };
  }
}
