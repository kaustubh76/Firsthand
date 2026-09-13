import { EPOCH_SECONDS, LIVENESS_GRACE_EPOCHS } from "../constants.js";
import { ValidationError } from "../errors.js";

/**
 * Epoch arithmetic (README §7.4, ADR-0008). Epochs are fixed-length windows counted from an
 * immutable per-deployment `genesis` timestamp:
 *
 *   epoch(t) = floor((t - genesis) / length)
 *
 * Mirrored exactly by `EpochLib.sol`. All values are unix seconds / epoch indices as bigint.
 */
export interface EpochParams {
  /** Unix seconds of epoch 0's start (immutable constructor argument on-chain). */
  readonly genesis: bigint;
  /** Epoch length in seconds. */
  readonly length: bigint;
}

export const DEFAULT_EPOCH_LENGTH = EPOCH_SECONDS;

export function epochAt(timestamp: bigint, params: EpochParams): bigint {
  if (params.length <= 0n) throw new ValidationError("epoch: length must be positive");
  if (timestamp < params.genesis) {
    throw new ValidationError("epoch: timestamp precedes genesis", {
      context: { timestamp: timestamp.toString(), genesis: params.genesis.toString() },
    });
  }
  return (timestamp - params.genesis) / params.length;
}

export function epochStart(epoch: bigint, params: EpochParams): bigint {
  if (epoch < 0n) throw new ValidationError("epoch: negative epoch");
  return params.genesis + epoch * params.length;
}

export function epochEnd(epoch: bigint, params: EpochParams): bigint {
  return epochStart(epoch + 1n, params) - 1n;
}

/** Liveness: `e_now <= e_attested + grace` (the dead-man's switch check, README §7.3). */
export function isWithinGrace(
  epochNow: bigint,
  epochAttested: bigint,
  grace: bigint = LIVENESS_GRACE_EPOCHS,
): boolean {
  return epochNow <= epochAttested + grace;
}
