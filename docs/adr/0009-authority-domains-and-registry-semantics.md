# ADR-0009 — Authority signatures verify under each contract's own domain; registry semantics

**Status:** accepted · **Date:** 2026-09-13 (Phase 1)

## Context

Authority operations (enroll, attest, grant, accept-terms, rescind) are P-256-signed EIP-712 structs
(`AuthorityDigests`). Passports are signed under the `PassportAnchors` domain (ADR-0002). A single
shared domain for authority ops would let a digest produced for one contract be replayed at another
whose struct happened to collide, and would couple every contract's address into every signature.

## Decisions

1. **Per-contract domains.** Each contract verifies authority signatures under
   `PassportLib.domainSeparator(block.chainid, address(this))` and exposes `domainSeparator()`.
   Clients derive it with `Locker.authorityDomain(contractAddress)`. Passports keep `PassportAnchors`.
2. **Enroll is permissionless and relayable.** `principalId = keccak256(abi.encode(x, y))`; the
   signature over `Enroll(keyCommit, epoch, nonce)` proves control of the key; `msg.sender` is
   irrelevant and pays gas. Off-curve keys fail closed because the precompile rejects them.
3. **Attest is the weekly ritual.** `epoch == currentEpoch()`, one `depositKeysRoot` per epoch (no
   overwrite: `AlreadyAttested`), `lastAttestedEpoch` moves forward only (`EpochNotMonotone`).
   Enroll sets `lastAttestedEpoch = epoch` so a fresh principal is live; publishing that epoch's
   deposit keys is a separate `attest` (the SDK chains the two).
4. **Nonces are scoped per principal** (`_nonceUsed[principalId][nonce]`) and shared across both
   verbs; a stranger cannot burn them, and a failed call rolls the nonce back.
5. **FROZEN is derived, never stored.** `effectiveStatus` / `isLive` compute it from
   `lastAttestedEpoch + livenessGrace`; the stored `status` stays `ACTIVE`. Thaw-after-one-epoch for
   grants (README §7.6) belongs to `GrantManager` (Phase 3).

## Consequences

- SDK plans carry the contract address; the same locker signature is invalid at any other contract
  (tested: enroll signature under the passport domain fails `verifyP256`).
- Local chains need the RIP-7212 precompile: `anvil --odyssey` provides it; tests etch the daimo
  verifier at `0x100` (`P256Double`).
