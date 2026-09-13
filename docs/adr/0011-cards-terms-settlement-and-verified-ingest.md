# ADR-0011 — Grantee cards, terms registration, x402 settlement and verified ingest

**Status:** accepted · **Date:** 2026-09-13 (Phase 3)

## Context

README §7.2–7.3 and §9 specify the demand side: a grantee accepts terms, the principal grants (and
may rescind) by authority signature, every `query` is paid per call over x402 and leaves a receipt,
and `verify()` is the one predicate every serve and every audit runs. Phase 3 had to pin down what
a "grantee card" is on chain, how the contract learns a terms preimage, which EIP-3009 flavour x402
"exact" actually uses, and how much the gateway is allowed to trust its own storage.

## Decisions

1. **Cards are on-chain commitments.** `cardId = keccak256(abi.encode(owner, x25519PubKey))`;
   `GrantManager.registerCard` is permissionless and idempotent. The owner (a secp256k1 address)
   signs `AcceptTerms` under GrantManager's own domain (ADR-0009, 65-byte `r‖s‖v`, low-s); the X25519
   key is what the principal's grant wrap is sealed to (ADR-0007). ERC-8004 identities map onto this
   off chain (agentId → owner + key → the same `cardId`) without depending on a registry ABI.
2. **Terms are registered by preimage at acceptance.** `acceptTerms(card, principal, TermsInput,
   nonce, cardSig)` hashes with `PassportLib.hashTerms` and stores `{price, rateLimit, ns}` under
   the hash, so `grant()` can enforce the price floor and `ReceiptLedger` the rate limit without
   the preimage being re-supplied. `RoyaltyRouter.settle` still takes the full `TermsInput`
   (payees, weights) and checks the hash — the split preimage is never stored.
3. **grant()** requires an enrolled principal, terms accepted by that card for
   `(principal, ns, termsHash)`, `price ≥ priceFloor`, `1 ≤ term ≤ maxTerm`, `epochStart ==
   currentEpoch()`, an unused `grantId = keccak(principal, card, ns, epochStart)`, and a P-256
   authority signature over `Grant(...)`. `wrapRef` is immutable per grant: no transition ever
   re-releases a wrap.
4. **Status is lazy** — `effectiveStatus`: `NONE` → `RESCINDED` (stored) → `EXPIRED`
   (`now ≥ epochStart + term`) → `FROZEN` (`!registry.isLive`) → `ACTIVE`, the same precedence as
   `core/grant/state.ts`. Thaw-after-one-full-epoch (README §7.6) is deferred to Phase 4.
5. **Rescission has two paths, one effect.** Direct: authority signature over
   `Rescind(grantId, epoch, nonce)` with `epoch == current`, ACTIVE only. Commit-reveal:
   `Rescissions.commit(keccak(grantId, salt))` first, then `revealRescind` with a signature over
   `RescindCommit(commitment, nonce)` within `revealWindowBlocks` of the commit; the **commit block
   is the effective end**, which is what H2 measures. Nonces are per-principal scopes.
6. **Settlement is standard x402 "exact".** The buyer signs USDC's EIP-3009
   `TransferWithAuthorization` with `to = RoyaltyRouter`; `settle` checks `effectiveStatus ==
   ACTIVE`, the terms hash and `value == price`, pulls with `transferWithAuthorization`, splits with
   `SplitMath` (ADR-0003), pays non-zero shares, keeps the residual as dust, and records the receipt
   with `receiptId = keccak(grantId, auth.nonce)` so payment and receipt dedup coincide. Known
   griefing: anyone who sees the raw authorization can submit it to the token directly; funds land
   in the router as dust rather than being stolen. `receiveWithAuthorization` (caller-bound) is the
   hardening path once the facilitator contract is pinned.
7. **ReceiptLedger.record is router-only**, takes the epoch from the router (which reads the
   registry), enforces `queriesThisEpoch < rateLimit` (0 = unlimited) and rejects duplicates.
8. **Lens.verify order** is fixed: signature → root anchored → Merkle inclusion → root's owner
   `(principal, ns)` equals the grant's (`SCOPE_MISMATCH`, added to both `VerifyFailure` enums) →
   terms hash → status → `epochStart ≤ P.epoch ≤ now`. The reference verifier in `@firsthand/core`
   runs the same order so a refusal reason means the same thing on and off chain.
9. **Gateway: verified ingest, verified serve.** The gateway hosts only what it can prove:
   `POST /v1/passports` accepts a sidecar iff the origin signature verifies, the root is anchored,
   the anchor's owner matches, the Merkle proof lands at its index and the terms preimage hashes to
   the passport's `termsHash`; `POST /v1/grants/:id/wrap` accepts bytes iff `keccak256 == wrapRef`;
   blobs are content-addressed. `serve` re-runs `verifyPredicate` against the chain (`GrantReader`,
   `AnchorWriter.anchorOf`) before settling, so a compromised catalog can at most refuse. The
   settlement relayer key signs `RoyaltyRouter.settle` only; it never holds user funds or keys
   (ADR-0001 rule 1 still holds: the gateway does not depend on `@firsthand/crypto`).
10. **402 carries chain time.** `accepts[].extra = {chainId, name, version, chainTime}` so the
    buyer derives `validAfter/validBefore` from the chain's clock, not the wall clock (anvil's
    block clock runs ahead; testnets drift).

## Measured (anvil --odyssey, vanilla EVM pricing; S2, 100 queries)

`RoyaltyRouter.settle` **241,741 gas** per paid query (EIP-3009 pull, one-payee split, receipt).
End-to-end query latency p50 102 ms / p95 201 ms on chain vs p50 4.5 ms in memory — the predicate
is not the cost, the round-trip is. Rescission is enforced by the contract on the very next
settlement (`GrantNotLive`) with no receipt written.
