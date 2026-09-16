# ADR-0010 — Anchor semantics and the two storage layouts

**Status:** accepted · **Date:** 2026-09-13 (Phase 2)

## Context

README §7.1 anchors one Merkle root per batch of ≤ 256 passports; §8 claim 2 rests on Monad's MIP-8
storage pages making per-asset anchoring near-free; §15 (H1) requires measuring MIP-8 against a
naive SSTORE baseline. The MIP-8 page layout is unconfirmed at Phase 0 (README §16).

## Decisions

1. **Authorisation.** `anchor()` is relayable: the secp256k1 deposit-key signature over the EIP-712
   `Anchor` digest (under PassportAnchors' own domain, ADR-0009) must recover to `depositKeys[ns]`,
   and `keccak256(abi.encodePacked(address[16] depositKeys))` must equal the root the principal
   attested for `epoch` in `PrincipalRegistry`. Deposit keys never hold funds (decision #11).
2. **Epoch rule.** A batch may be anchored for any epoch `≤ current` that the principal attested
   (late flushes are normal); never a future epoch, never an unattested one.
3. **Uniqueness.** Roots are globally unique (`DuplicateRoot`), non-zero, append-only per
   `(principal, ns, epoch)` page with dense indices. Nonces are per principal.
4. **Validation lives once.** The abstract `PassportAnchors` performs every check; subclasses only
   implement `_pageAppend / _store / _load / _exists`. One shared conformance suite runs for both.
5. **Baseline layout.** `mapping(root => AnchorRecord)` (3 slots) + `mapping(pageKey => bytes32[])`.
6. **Paged layout (MIP-8 arm).** All state of a page in one contiguous slot run
   (`count, principalId, packed(ns,epoch), then [root, termsHash, packed(block,index)]×n`) rooted at
   `keccak256(principalId, ns, epoch, salt)` with the low 32 bits cleared, so one pointer slot per
   root (`base | index+1`) gives O(1) lookup. This is a **best guess** at what MIP-8 rewards
   (contiguity); it is isolated behind the hooks so it can change without touching validation.
7. **`isIncluded(root, passportId, proof)`** is the on-chain half of `verify()`: anchored AND
   Merkle membership at `proof.index`.

## Measured (vanilla EVM, anvil, S1 with 10 batches of 256)

| layout | gas / batch | gas / passport | first anchor on page (unit test) |
|---|---|---|---|
| baseline | 168,109 | 657 | 200,914 |
| paged | 171,358 | 669 | 246,163 |

Without MIP-8 pricing the clustered layout costs +1.9 % per batch (and +22 % for the first anchor
on a page, which writes the page header). H1 is therefore **not** supported on a vanilla EVM.

## Measured (Monad testnet 10143, 2026-09-16, same harness, same 10 × 256 batches)

| layout | gas / batch | gas / passport | vs baseline |
|---|---|---|---|
| baseline | 200,858 | 785 | — |
| paged | 192,450 | 752 | **−4.2 %** |

**Verdict: H1 holds on Monad and not on a vanilla EVM.** The sign of the effect flips — clustering
costs 1.9 % extra under uniform SSTORE pricing and saves 4.2 % under Monad's — which is what the
two-layout design existed to detect. Monad also charges more in absolute terms for the same anchor
(+19 % baseline, +12 % paged), so the layout choice matters more there, not less.

The deployment binds `PassportAnchorsBaseline` as the canonical `PassportAnchors` (decision 5) since
that is what the gates ran against; switching the demo to the paged layout is one env var
(`ANCHORS_LAYOUT=paged`) and a redeploy, and on these numbers it is the better default on Monad.
