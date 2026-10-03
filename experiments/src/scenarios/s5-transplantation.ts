import { AttestationClass, RefusalError } from "@firsthand/core";
import { acceptSigned, deviceClassFor, mintPassport, signCaptureWitness } from "@firsthand/sdk";
import { type ArmAdapters, Arms, memoryArm, resolveArm } from "../arms/index.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { percentile } from "../metrics/stats.js";
import { datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S5 — transplantation resistance (ADR-0015).
 *
 * **Not** "admit rate per class", which is a tautology of the class definitions: a class-3
 * passport is admitted when it carries a verifying witness, so measuring that measures the
 * definition. What is worth measuring is the *attack*: a witness that was genuinely produced by a
 * secure element, lifted onto a deposit it was not made for. The digest binds `origin` and
 * `nonce`, so the same photo under a second locker is a different digest and the signature stops
 * covering it. Target: every transplant refused, every genuine deposit admitted.
 *
 * The device here is a software P-256 key, and that is not a shortcut. This scenario measures the
 * **gate**, which is pure cryptography over a digest and is identical whether the scalar lives in
 * StrongBox or in this process. What a secure element adds — that the key provably never existed
 * outside it — is established by `HardwareDeviceRegistry` verifying a certificate chain, which is
 * measured on a chain by `packages/sdk/test/anvil/device.roundtrip.test.ts`, not here.
 *
 * Deliberately **not** reported, because this process cannot measure them without a handset:
 * StrongBox signing latency, and the security level and chain size of a real attestation. A
 * number produced here and labelled with one of those names would be evidence of nothing.
 */
export const s5: Scenario = {
  id: "s5",
  hypothesis: "refusal",
  arms: [Arms.MEMORY],
  async run(arm: string, ctx: RunContext) {
    const adapters = await resolveArm(arm);
    const { locker, batcher } = seededLocker(1, adapters, ctx.clock, 256);
    await adapters.prepare(locker);

    // A second locker, to transplant onto: different deposit keys, so a different `origin`, and a
    // different deterministic nonce for the same bytes.
    const otherArm: ArmAdapters = {
      ...memoryArm(Arms.MEMORY),
      uniqueSeeds: adapters.uniqueSeeds,
      ...(adapters.domain ? { domain: adapters.domain } : {}),
      ...(adapters.epochs ? { epochs: adapters.epochs } : {}),
      ...(adapters.clock ? { clock: adapters.clock } : {}),
    };
    const { locker: other, batcher: otherBatcher } = seededLocker(2, otherArm, ctx.clock, 256);
    await otherArm.prepare(other);

    // Two P-256 keypairs standing in for secure elements. Derived the way every other key in
    // this repository is — a locker's own authority key has exactly the shape a witness signer
    // needs — rather than by reaching for a curve library this package does not depend on.
    const device = seededLocker(7, otherArm, ctx.clock).locker.authorityKey();
    const impostor = seededLocker(8, otherArm, ctx.clock).locker.authorityKey();
    const deviceClass = deviceClassFor(device.publicKey);
    const terms = termsFor(locker);
    const otherTerms = termsFor(other);
    const n = ctx.dryRun ? Math.min(ctx.n, 50) : ctx.n;

    let genuineAdmitted = 0;
    let refused = 0;
    let wronglyAccepted = 0;
    let wronglyRefused = 0;
    const gateMs: number[] = [];

    const attestation = (capturedAt: bigint) => ({
      class: AttestationClass.HARDWARE,
      capturedAt,
      sourceTag: `0x${"5e".repeat(32)}` as const,
      deviceClass,
      metaHash: `0x${"00".repeat(32)}` as const,
    });

    for (let i = 0; i < n; i++) {
      const bytes = datumBytes(i);
      const capturedAt = 1_700_000_000n + BigInt(i);
      const attest = attestation(capturedAt);

      // ── the genuine deposit, and the cost of the gate that admits it ──────────────────────
      const signed = mintPassport(locker, {
        ns: 0,
        datum: { kind: "bytes", bytes },
        terms,
        attestation: attest,
      });
      const witness = signCaptureWitness(device, {
        chainId: locker.domain.chainId,
        passport: signed.passport,
        attestation: attest,
      });
      const started = performance.now();
      try {
        await acceptSigned(locker, batcher, signed, 0, bytes, {
          attestation: attest,
          hardware: witness,
        });
        gateMs.push(performance.now() - started);
        genuineAdmitted++;
      } catch (error) {
        if (!(error instanceof RefusalError)) throw error;
        wronglyRefused++;
      }

      // ── four ways to hold a witness that should not be admitted ───────────────────────────
      // 1. Transplanted: the *same* genuine signature, on the same bytes, deposited by a second
      //    locker. This is the attack the whole class exists to resist.
      const transplanted = mintPassport(other, {
        ns: 0,
        datum: { kind: "bytes", bytes },
        terms: otherTerms,
        attestation: attest,
      });
      // 2. A witness from a different secure element, claiming to be this one.
      const wrongDevice = signCaptureWitness(impostor, {
        chainId: locker.domain.chainId,
        passport: signed.passport,
        attestation: attest,
      });
      // 3. A class-3 passport with no witness at all.
      // 4. A genuine witness with one byte of the signature changed.
      const tampered = {
        publicKey: witness.publicKey,
        signature: flipLastByte(witness.signature),
      };

      const attacks: Array<() => Promise<unknown>> = [
        () =>
          acceptSigned(other, otherBatcher, transplanted, 0, bytes, {
            attestation: attest,
            hardware: witness,
          }),
        () =>
          acceptSigned(locker, batcher, signed, 0, bytes, {
            attestation: attest,
            hardware: wrongDevice,
          }),
        () => acceptSigned(locker, batcher, signed, 0, bytes, { attestation: attest }),
        () =>
          acceptSigned(locker, batcher, signed, 0, bytes, {
            attestation: attest,
            hardware: tampered,
          }),
      ];
      for (const attack of attacks) {
        try {
          await attack();
          wronglyAccepted++;
        } catch (error) {
          if (!(error instanceof RefusalError)) throw error;
          refused++;
        }
      }
    }

    const injected = n * 4;
    return {
      metrics: {
        deposits: { value: n, unit: "count" },
        genuineAdmitted: { value: genuineAdmitted, unit: "count" },
        injected: { value: injected, unit: "count" },
        refused: { value: refused, unit: "count" },
        wronglyAccepted: { value: wronglyAccepted, unit: "count" },
        wronglyRefused: { value: wronglyRefused, unit: "count" },
        refusalRate: { value: injected === 0 ? 1 : refused / injected, unit: "ratio" },
        witnessGateP50Ms: { value: percentile(gateMs, 50), unit: "ms" },
        witnessGateP95Ms: { value: percentile(gateMs, 95), unit: "ms" },
      },
      onChain: adapters.onChain,
      notes: [
        "Target: refusalRate 1.0 and wronglyRefused 0 — every transplanted, mismatched, missing or tampered witness turned away, and every genuine one admitted.",
        "The transplanted arm replays a *genuine* signature onto a second locker's deposit of the same bytes: different origin and nonce give a different hwDigest, so the signature no longer covers it.",
        "The device is a software P-256 key. That measures the gate, which is identical whichever side of a secure element the scalar sits on; that the key never left one is proved by the registry verifying a certificate chain, on a chain, in sdk/test/anvil/device.roundtrip.test.ts.",
        "Not measured here, because no handset is attached: StrongBox signing latency, and a real attestation's security level and chain size.",
      ],
    };
  },
};

function flipLastByte(signature: `0x${string}`): `0x${string}` {
  const last = Number.parseInt(signature.slice(-2), 16);
  const flipped = ((last + 1) & 0xff).toString(16).padStart(2, "0");
  return `${signature.slice(0, -2)}${flipped}` as `0x${string}`;
}
