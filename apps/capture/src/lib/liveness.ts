import { OnchainGrantReader, type PrincipalLivenessView } from "@firsthand/adapters/client";
import type { Bytes32 } from "@firsthand/core";
import type { PublicClient } from "viem";
import type { AppConfig } from "./config.js";

/**
 * Where the principal stands this epoch, so the app can say "attest first" instead of failing on a
 * revert. Anchoring needs the *current* epoch's deposit-key root attested; grants stay live for a
 * grace period after the last attestation (README §7.6) and a gap schedules a thaw (ADR-0012).
 */
export type Liveness =
  | { kind: "unknown" }
  | { kind: "not-enrolled" }
  | { kind: "attest-needed"; epoch: bigint; lastAttested: bigint }
  | { kind: "frozen"; thawEpoch: bigint }
  | { kind: "live"; epoch: bigint };

export function livenessOf(view: PrincipalLivenessView | null, epochNow: bigint): Liveness {
  if (view === null) return { kind: "not-enrolled" };
  if (view.thawEpoch !== 0n && epochNow < view.thawEpoch) {
    return { kind: "frozen", thawEpoch: view.thawEpoch };
  }
  if (view.lastAttestedEpoch < epochNow) {
    return { kind: "attest-needed", epoch: epochNow, lastAttested: view.lastAttestedEpoch };
  }
  return { kind: "live", epoch: epochNow };
}

export function describeLiveness(l: Liveness): string {
  switch (l.kind) {
    case "unknown":
      return "";
    case "not-enrolled":
      return "not on chain yet — Locker → Activate";
    case "attest-needed":
      return `epoch ${l.epoch} needs a fresh attestation (last: ${l.lastAttested}) — Locker → Re-attest`;
    case "frozen":
      return `frozen until epoch ${l.thawEpoch} (a gap in attestation schedules a thaw)`;
    case "live":
      return `attested for epoch ${l.epoch}`;
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
