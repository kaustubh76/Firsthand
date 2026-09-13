import { sha256, utf8 } from "@firsthand/core";

/**
 * Fixed WebAuthn PRF evaluation input: `prf.eval.first = SHA-256("FIRSTHAND/prf/v1")`.
 * Constant across devices so that the same passkey always yields the same key tree.
 */
export const PRF_EVAL_SALT: Uint8Array = sha256(utf8("FIRSTHAND/prf/v1"));
export const PRF_OUTPUT_LENGTH = 32;

/**
 * The single entry point for root secret material (README §7.3, ADR-0005).
 *
 * Implementations: `WebAuthnPrfSource` (in @firsthand/sdk, browser), `StaticPrfSource` (tests
 * and demos only). A future guardian-recovery or seed-based fallback implements this interface
 * without touching `kdf`.
 */
export interface PrfSource {
  /** Human-readable kind, for logs and capability checks. Never contains key material. */
  readonly kind: string;
  /** Evaluates the PRF for `salt`; must return exactly `PRF_OUTPUT_LENGTH` bytes. */
  evaluate(salt: Uint8Array): Promise<Uint8Array>;
}
