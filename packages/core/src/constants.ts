/**
 * Protocol parameters (README §7.5 "Initial research parameters") and fixed encodings.
 * Changing any value here is a protocol change: the Solidity twins in
 * `contracts/src/libraries` and the golden vectors must move with it.
 */

/** Fixed-point scale for royalty weights (1e18). */
export const WAD = 10n ** 18n;
/** Maximum recipients in a royalty split. Bounds the dust residual to `n - 1` units. */
export const MAX_RECIPIENTS = 16;
/** Largest price accepted by SplitMath: keeps `price * weight` below 2^156, no overflow path. */
export const MAX_PRICE = (1n << 96n) - 1n;

/** Passports per anchored batch. Merkle depth 8 → every proof is exactly 8 siblings. */
export const BATCH_SIZE = 256;
export const MERKLE_DEPTH = 8;

/** Epoch length in seconds (7 days) — matches the passkey re-attestation ritual. */
export const EPOCH_SECONDS = 604_800n;
/** Liveness grace in epochs before a principal's grants freeze lazily. */
export const LIVENESS_GRACE_EPOCHS = 2n;
/** Maximum grant term in epochs. */
export const MAX_GRANT_TERM_EPOCHS = 8n;
/** Maximum namespaces per principal. */
export const MAX_NAMESPACES = 16;
/** Price floor in USDC base units — keeps receipts non-degenerate. */
export const PRICE_FLOOR = 1n;
/** Default per-grant query rate limit per epoch. */
export const DEFAULT_RATE_LIMIT = 100;
/** USDC decimals. */
export const USDC_DECIMALS = 6;

/** EIP-712 domain. `verifyingContract` is the PassportAnchors deployment (ADR-0002). */
export const EIP712_NAME = "FIRSTHAND";
export const EIP712_VERSION = "1";

/** Monad testnet chain id. Verify against the current testnet before deployment. */
export const MONAD_TESTNET_CHAIN_ID = 10143n;

/** Byte prefixes for Merkle domain separation (RFC 6962 style). */
export const MERKLE_LEAF_PREFIX = 0x00;
export const MERKLE_NODE_PREFIX = 0x01;
