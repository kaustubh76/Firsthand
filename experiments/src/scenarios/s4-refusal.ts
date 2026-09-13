import {
  anchorStructHash,
  authorityDigest,
  ChainError,
  RefusalError,
  type SignedPassport,
} from "@firsthand/core";
import { signPassportDigest } from "@firsthand/crypto";
import { acceptSigned, mintPassport } from "@firsthand/sdk";
import { type ArmAdapters, Arms, memoryArm, resolveArm } from "../arms/index.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { ATTESTATION, datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S4 — refusal (README §15): inject N unprovable deposits (foreign lineage, forged content, stray
 * signer) alongside N genuine ones; measure refusal precision and recall. Target: 100 % / 100 %.
 */
export const s4: Scenario = {
  id: "s4",
  hypothesis: "refusal",
  arms: [Arms.MEMORY, Arms.ANCHORS_BASELINE],
  async run(arm: string, ctx: RunContext) {
    const adapters = await resolveArm(arm);
    const { locker, batcher } = seededLocker(1, adapters, ctx.clock, 256);
    await adapters.prepare(locker);
    const intruderArm: ArmAdapters = {
      ...memoryArm(Arms.MEMORY),
      uniqueSeeds: adapters.uniqueSeeds,
      ...(adapters.domain ? { domain: adapters.domain } : {}),
      ...(adapters.epochs ? { epochs: adapters.epochs } : {}),
      ...(adapters.clock ? { clock: adapters.clock } : {}),
    };
    const intruder = seededLocker(2, intruderArm, ctx.clock).locker;
    const genuineTerms = termsFor(locker);
    const foreignTerms = termsFor(intruder);
    const n = ctx.dryRun ? Math.min(ctx.n, 100) : ctx.n;

    let refused = 0;
    let wronglyAccepted = 0;
    let wronglyRefused = 0;
    const attack = (i: number): SignedPassport => {
      const kind = i % 3;
      if (kind === 0) {
        // Foreign lineage: a valid passport from someone else's passkey.
        return mintPassport(intruder, {
          ns: 0,
          datum: { kind: "bytes", bytes: datumBytes(i) },
          terms: foreignTerms,
          attestation: ATTESTATION,
        });
      }
      const genuine = mintPassport(locker, {
        ns: 0,
        datum: { kind: "bytes", bytes: datumBytes(i) },
        terms: genuineTerms,
        attestation: ATTESTATION,
      });
      if (kind === 1) {
        // Forged content under a real signature.
        return {
          passport: { ...genuine.passport, h: `0x${"ff".repeat(32)}` },
          signature: genuine.signature,
        };
      }
      // Replayed signature onto a different epoch.
      return {
        passport: { ...genuine.passport, epoch: genuine.passport.epoch + 1n },
        signature: genuine.signature,
      };
    };

    for (let i = 0; i < n; i++) {
      try {
        await acceptSigned(locker, batcher, attack(i), 0, datumBytes(i));
        wronglyAccepted++;
      } catch (error) {
        if (error instanceof RefusalError) refused++;
        else throw error;
      }
      try {
        const genuine = mintPassport(locker, {
          ns: 0,
          datum: { kind: "bytes", bytes: datumBytes(10_000 + i) },
          terms: genuineTerms,
          attestation: ATTESTATION,
        });
        await acceptSigned(locker, batcher, genuine, 0, datumBytes(10_000 + i));
      } catch (error) {
        if (error instanceof RefusalError) wronglyRefused++;
        else throw error;
      }
    }
    // On-chain half: anchors signed by the intruder's key against the genuine principal are refused by
    // the contract itself (the client-side gate above never lets them out; this bypasses it deliberately).
    let onchainRefused = 0;
    let onchainAccepted = 0;
    const onchainReasons: Record<string, number> = {};
    const onchainAttempts = adapters.onChain ? Math.min(n, ctx.dryRun ? 3 : 20) : 0;
    for (let i = 0; i < onchainAttempts; i++) {
      const epoch = locker.currentEpoch();
      const forged = {
        principalId: locker.principalId,
        ns: 0,
        epoch,
        batchRoot: `0x${(i + 1).toString(16).padStart(64, "0")}` as const,
        termsHash: `0x${"00".repeat(32)}` as const,
        nonce: `0x${(i + 1000).toString(16).padStart(64, "0")}` as const,
        depositKeys: locker.depositAddresses(epoch),
        depositSig: signPassportDigest(
          intruder.depositKey(0, epoch).privateKey,
          authorityDigest(
            anchorStructHash({
              principalId: locker.principalId,
              ns: 0,
              epoch,
              batchRoot: `0x${(i + 1).toString(16).padStart(64, "0")}`,
              termsHash: `0x${"00".repeat(32)}`,
              nonce: `0x${(i + 1000).toString(16).padStart(64, "0")}`,
            }),
            locker.domain,
          ),
        ),
      };
      try {
        await adapters.anchors.anchor(forged);
        onchainAccepted++;
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        onchainRefused++;
        const reason = String(error.context["reason"] ?? "unknown");
        onchainReasons[reason] = (onchainReasons[reason] ?? 0) + 1;
      }
    }
    if (adapters.onChain) await batcher.flush(); // the genuine passports land on chain

    const precision = refused + wronglyRefused === 0 ? 1 : refused / (refused + wronglyRefused);
    const recall = refused + wronglyAccepted === 0 ? 1 : refused / (refused + wronglyAccepted);
    return {
      metrics: {
        injected: { value: n, unit: "count" },
        refused: { value: refused, unit: "count" },
        wronglyAccepted: { value: wronglyAccepted, unit: "count" },
        wronglyRefused: { value: wronglyRefused, unit: "count" },
        precision: { value: precision, unit: "ratio" },
        recall: { value: recall, unit: "ratio" },
        ...(adapters.onChain
          ? {
              onchainForgedAttempts: { value: onchainAttempts, unit: "count" },
              onchainRefused: { value: onchainRefused, unit: "count" },
              onchainAccepted: { value: onchainAccepted, unit: "count" },
            }
          : {}),
      },
      onChain: adapters.onChain,
      notes: [
        "Target: precision 1.0 and recall 1.0 — the locker refuses every unprovable deposit and no genuine one.",
        ...(adapters.onChain
          ? [`On-chain refusals by reason: ${JSON.stringify(onchainReasons)}`]
          : []),
      ],
    };
  },
};
