# ADR-0005 — Key derivation tree

**Status:** accepted (nonce rule is a user decision) · **Date:** 2026-09-13

## Decision

```
prf        = WebAuthn PRF(eval.first = SHA-256("FIRSTHAND/prf/v1"))              32 bytes
PRK        = HKDF-Extract(SHA-256, salt = "FIRSTHAND/kdf/v1", IKM = prf)
k_id       = HKDF-Expand(PRK, "id"    ‖ 0x00,                         48) → P-256 scalar
k_ns,e     = HKDF-Expand(PRK, "ns"    ‖ 0x00 ‖ u32be(ns) ‖ u64be(e), 32) → vault KEK
k_dep      = HKDF-Expand(PRK, "dep"   ‖ 0x00 ‖ u32be(ns) ‖ u64be(e), 48) → secp256k1 scalar
k_nonce    = HKDF-Expand(PRK, "nonce" ‖ 0x00 ‖ u32be(ns) ‖ u64be(e), 32) → HMAC key
scalar     = (int_be(okm48) mod (n − 1)) + 1                                (FIPS 186-5 A.2.1 style)
```

- Labels are NUL-terminated so `"ns" ‖ …` can never collide with another label.
- `principalId = keccak256(abi.encode(x, y))` of the P-256 authority key.
- `Passport.nonce = HMAC-SHA256(k_nonce(ns,e), h)` — **deterministic**: identical content in the same
  `(ns, e)` yields the same `passportId`, so duplicate detection is structural (batcher + root
  uniqueness on-chain) with no per-passport storage. Different epochs give unlinkable ids.
- The authority key is a *derived software P-256 key rooted in the PRF*, not the passkey's own
  credential key (README §7.3 equation). The precompile verifies a plain 32-byte digest; WebAuthn
  assertion parsing on-chain is roadmap.

## Addendum (2026-09-21): deposit delegations

`KeyTree.delegate({ ns, epoch, chainId, expiresAt })` is the tree's one serialisation: the three
scoped secrets of a single `(ns, e)` — `k_dep`, `k_nonce`, `k_ns,e` — with the public scope, as an
`fhd1.` code. `DelegatedKeys` implements the same `KeyProvider` interface the SDK's `Locker` runs
on and refuses every other derivation (`FH_DELEGATION_SCOPE`), which is what makes the
MCP↔PWA handoff a capability rather than a key export: deposit-only, one namespace, one epoch, no
authority key. The attested deposit-key set travels as the sixteen public addresses, so a
delegated locker anchors against exactly the root the passkey attested. See SECURITY.md §3.

## Verification

Hand vectors derived with OpenSSL 3 (`openssl kdf HKDF`, `openssl pkeyutl -sign`) and `cast`; see
`packages/crypto/scripts/gen-vectors.ts`.
