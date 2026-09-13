# ADR-0007 — Envelope encryption and grant wraps

**Status:** accepted · **Date:** 2026-09-13

## Decision

- One AEAD everywhere: XChaCha20-Poly1305 (24-byte nonces, no nonce-reuse bookkeeping).
- Container v1: `"FH1E" ‖ 0x01 ‖ nonce(24) ‖ ciphertext ‖ tag(16)`.
- Per blob: random DEK; `blob = AEAD(DEK, nonce, plaintext, aad = passportId)`;
  `wrappedDek = AEAD(k_ns,e, nonce', DEK, aad = passportId ‖ u32be(ns) ‖ u64be(e))`.
  AADs bind ciphertext to the passport and namespace-epoch: a blob cannot be re-attached elsewhere.
- Grant wrap = X25519 sealed box to the grantee's card key:
  `key = HKDF-SHA256(ss, salt = epk ‖ granteePk, info = "FIRSTHAND/wrap/v1" ‖ grantId, 32)`,
  `wrap = epk(32) ‖ nonce(24) ‖ AEAD(key, nonce, k_ns,e, aad = grantId ‖ u32be(ns) ‖ u64be(e))` — 104 bytes.
- On-chain the grant stores only `keccak256(wrap)`; bytes are served off-chain. No transition ever
  re-releases a wrap (README §7.5).

## Consequences

- A grantee learns exactly one `(ns, e)` vault key per wrap — attenuation only.
- The store (`BlobStore`) only ever holds ciphertext; `apps/gateway` can serve it without `@firsthand/crypto`.
