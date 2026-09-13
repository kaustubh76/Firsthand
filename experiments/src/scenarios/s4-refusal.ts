import { RefusalError, type SignedPassport } from "@firsthand/core";
import { acceptSigned, mintPassport } from "@firsthand/sdk";
import { type Arm, Arms, memoryArm } from "../arms/index.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { ATTESTATION, datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S4 — refusal (README §15): inject N unprovable deposits (foreign lineage, forged content, stray
 * signer) alongside N genuine ones; measure refusal precision and recall. Target: 100 % / 100 %.
 */
export const s4: Scenario = {
  id: "s4",
  hypothesis: "refusal",
  arms: [Arms.MEMORY],
  async run(arm: string, ctx: RunContext) {
    const adapters = memoryArm(arm as Arm);
    const { locker, batcher } = seededLocker(1, adapters, ctx.clock, 256);
    const intruder = seededLocker(2, memoryArm(arm as Arm), ctx.clock).locker;
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
      },
      onChain: adapters.onChain,
      notes: [
        "Target: precision 1.0 and recall 1.0 — the locker refuses every unprovable deposit and no genuine one.",
      ],
    };
  },
};
