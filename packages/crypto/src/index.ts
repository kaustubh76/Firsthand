/**
 * @firsthand/crypto — the privacy boundary.
 *
 * This is the only package that handles PRF output, derived scalars, vault keys, DEKs or
 * decryption. `apps/gateway` (the serving path) is forbidden from depending on it; see
 * scripts/check-deps.mjs and docs/SECURITY.md.
 */
export * from "./delegation/index.js";
export * from "./envelope/index.js";
export * from "./kdf/index.js";
export * from "./prf/index.js";
export { randomBytes32, randomNonce } from "./random.js";
export * from "./sign/index.js";
export * from "./wrap/index.js";
export { SecretBytes, zeroize } from "./zeroize.js";
