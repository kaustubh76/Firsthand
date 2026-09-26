import { FirsthandLensAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  type BatchProof,
  type Bytes32,
  type GrantStatus,
  type SignedPassport,
  ValidationError,
} from "@firsthand/core";
import type { Chain, PublicClient, Transport } from "viem";

/**
 * `VerifyFailure` as the chain numbers it (`contracts/src/types/Structs.sol`), ordinal by ordinal.
 * Solidity enums cross the ABI as integers, so this is the only place the two spellings meet — and
 * the gateway's `serving.test.ts` asserts it still matches `Object.keys(VerifyFailure)`, because a
 * reason that decoded to the wrong name would make the twin look like it disagreed when it did not.
 */
export const LENS_REASONS = [
  "NONE",
  "SIG_INVALID",
  "MERKLE_INVALID",
  "ROOT_UNKNOWN",
  "TERMS_MISMATCH",
  "EPOCH_OUT_OF_GRANT",
  "GRANT_NOT_LIVE",
  "GRANT_RESCINDED",
  "GRANT_EXPIRED",
  "GRANT_FROZEN",
  "SCOPE_MISMATCH",
] as const;

type Siblings8 = readonly [Bytes32, Bytes32, Bytes32, Bytes32, Bytes32, Bytes32, Bytes32, Bytes32];

/** The ABI wants `bytes32[8]`; a sidecar that carries any other depth is not a FIRSTHAND proof. */
function siblings8(siblings: readonly Bytes32[]): Siblings8 {
  if (siblings.length !== 8) {
    throw new ValidationError("a batch proof has exactly 8 siblings (Merkle depth 8, ADR-0004)", {
      context: { got: siblings.length },
    });
  }
  return siblings as unknown as Siblings8;
}

export interface OnchainLensReaderOptions {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly firsthandLens: Address;
}

/**
 * What `FirsthandLens.verify` actually reads. Deliberately narrower than `PassportSidecar`: a
 * Lineage Manifest asset carries exactly these three fields and none of the serving-side ones, and
 * a buyer auditing their own file is the caller with the most reason to ask the chain directly.
 */
export interface LensSubject {
  readonly signed: SignedPassport;
  readonly batchRoot: Bytes32;
  readonly proof: BatchProof;
}

export interface LensVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * `FirsthandLens` — the one verification call evaluated by the chain rather than by us, plus the
 * two dashboard reads the contract exposes beside it (README §7.3, §9).
 *
 * It is the twin of `verifyPredicate` in `@firsthand/core`: the same check order, the same reason
 * codes. Asking both and showing the pair is the only way that claim is visible to someone who did
 * not run the test suite — which is why this lives in adapters rather than inside the gateway, where
 * it began. The gateway is not the only caller that should be able to ask the chain; a browser
 * auditing a manifest has better reason to, because the gateway's word is exactly what is in
 * question there.
 *
 * Read-only: no key, no transport, one `eth_call` per question.
 */
export class OnchainLensReader {
  readonly #c: PublicClient<Transport, Chain>;
  readonly address: Address;

  constructor(options: OnchainLensReaderOptions) {
    this.#c = options.publicClient;
    this.address = options.firsthandLens;
  }

  async verify(subject: LensSubject, grantId: Bytes32): Promise<LensVerdict> {
    const [ok, reason] = await this.#c.readContract({
      address: this.address,
      abi: FirsthandLensAbi,
      functionName: "verify",
      args: [
        subject.signed.passport,
        subject.signed.signature,
        subject.batchRoot,
        { index: subject.proof.index, siblings: siblings8(subject.proof.siblings) },
        grantId,
      ],
    });
    return { ok, reason: LENS_REASONS[Number(reason)] ?? `UNKNOWN_${reason}` };
  }

  /** Lazily-evaluated status: RESCINDED > EXPIRED > FROZEN > ACTIVE, as the chain computes it. */
  async grantStatus(grantId: Bytes32): Promise<GrantStatus> {
    return (await this.#c.readContract({
      address: this.address,
      abi: FirsthandLensAbi,
      functionName: "grantStatus",
      args: [grantId],
    })) as GrantStatus;
  }

  principalIsLive(principalId: Bytes32): Promise<boolean> {
    return this.#c.readContract({
      address: this.address,
      abi: FirsthandLensAbi,
      functionName: "principalIsLive",
      args: [principalId],
    });
  }

  currentEpoch(): Promise<bigint> {
    return this.#c.readContract({
      address: this.address,
      abi: FirsthandLensAbi,
      functionName: "currentEpoch",
    });
  }
}
