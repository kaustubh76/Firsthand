# ADR-0012 — Thaw boundary, the rescission race protocol, and the BTX transport contract

**Status:** accepted · **Date:** 2026-09-15 (Phase 4)

## Context

README §16 Phase 4: "BTX path + fallback, race harness. Gate: S3 run, H2 data collected." Three
things were open after Phase 3: the FROZEN→thaw rule of §7.6 was deferred, `BtxTransport` was a
probe shell, and S3 was an arithmetic simulation. One external fact shapes all three: **BTX is not
deployed on Monad testnet as of 2026-09.** It is Category Labs' *batched threshold encryption*
scheme, announced by Monad as the first practical encrypted-mempool construction; there is no RPC
surface, and Monad's live architecture has no global mempool at all (RPC nodes forward to the next
leaders). README §8/§14/§20 anticipated this: the fallback ships either way and the race experiment
reports both arms honestly.

## Decisions

1. **Thaw boundary (§7.6).** `PrincipalState.thawEpoch` is appended to the registry struct. When an
   attest arrives beyond the grace of the previous watermark — the principal was FROZEN —
   `thawEpoch = epoch + 1` and `PrincipalThawScheduled(principalId, frozenFromEpoch, thawEpoch)` is
   emitted; `effectiveStatus` stays FROZEN while `currentEpoch() < thawEpoch`, then applies the
   grace check as before. A passed thaw is never cleared (it is ≤ now forever after). Gap epochs can
   never be attested, hence never anchored, so "future epochs only" is automatic for *data*; the
   rule delays the *grant's* return to ACTIVE by one full boundary, which is what stops
   freeze/unfreeze flapping. `GrantManager` and `FirsthandLens` are unchanged — they delegate to
   `isLive`. Twins: `principalEffectiveStatus` / `thawEpochAfterGap` in core, `MemoryGrantReader`,
   and the `GrantReader.principalLiveness` port method (replacing `principalLastAttested`).
2. **BtxTransport is a real client shape, gated by its probe.** Sign (viem wallet) → `seal` (identity
   by default; the threshold-encryption step goes here once the surface exists) → post the raw bytes
   via a configurable JSON-RPC method (default `eth_sendEncryptedRawTransaction`, a guess). While the
   node does not know the method, `send` refuses with `FH_BTX_UNAVAILABLE` — never a silent downgrade
   (ADR-0006). Opaque tickets fall back to keccak of the signed bytes as the tx id.
3. **A direct plan only travels a transport of its kind.** `sendRescind` refuses a `btx` plan on a
   `public` transport and vice versa (`FH_VALIDATION`, memory double excepted); commit-reveal plans go
   anywhere. `LockerSession.planRescind` defaults its path from the configured transport. MCP builds
   `BtxTransport` from `BTX_RPC_URL`/`BTX_METHOD`.
4. **S3 measures chain truth.** Blocks every 400 ms (Monad's cadence) driven by the harness
   (`evm_setAutomine false` + `evm_mine` on a timer — anvil's interval mining is seconds-only; automine
   restored in `finally` and asserted after each arm; never touched off anvil). Consent ends at the
   rescission's inclusion — the **commit block** for commit-reveal — and an extraction counts only if
   `(block, index)` ordered it before that point. `Δ_race` uses the harness's block clock; the raw
   distribution is persisted (`TrialResult.samples`). The bot is the grantee's own key submitting
   `RoyaltyRouter.settle` directly (permissionless; the EIP-3009 authorization moves the funds) with
   pre-signed authorizations, its own nonce stream, fixed gas and a 10× priority fee.
5. **Arms and their honest labels.** `B2-public-mempool`: the bot decodes the pending `rescind` for
   the grant. `commit-reveal`: the bot cannot attribute a commitment, so it reacts to *every* commit
   (paranoid); post-commit settlements are counted as post-consent receipts. `btx-blind` — **not
   BTX** — the rescission travels the public mempool but the bot has no feed and extracts
   continuously; only extractions *sent after* the broadcast count. This is the bound an encrypted
   mempool leaves. `btx`: the real transport, skipped with the status reason until `BTX_RPC_URL` is
   set. `memory`: the timing simulation, for unit tests.

## Measured (anvil --odyssey, fee-ordered, 50 trials per arm)

| arm | success | Δ_race p50 / p95 | detection | extractions before end | queries paid |
|---|---|---|---|---|---|
| B2-public-mempool | 0.98 | 411 / 603 ms | 15 ms | 4 | 4 |
| commit-reveal | 1.00 | 430 / 606 ms | 10 ms | 4 | 4 (+2 post-commit) |
| btx-blind | 0.98 | 381 / 521 ms | — | 6 | 13 |

Read plainly: the public race is real and cheap; commit-reveal removes attribution and dates the
end of consent, not the window; and **an encrypted mempool removes the signal, not same-block fee
competition** — a bot paying continuously still lands ~6 queries in the rescission block. H2 as
worded (~0 % under BTX, median Δ_race ≤ 0) is not measurable until BTX exists, and the no-signal
bound says the defensible claim is "no targeted burst at zero idle cost", not "the race never
starts". Follow-up: let the principal bid a priority fee on the rescission (`PreparedTx` has no fee
fields today) and re-measure.
