# @firsthand/experiments

Harness for README §15. Arms are adapter selections (ADR-0006); results are raw JSON under
`results/` and rendered with `pnpm --filter @firsthand/experiments report`.

| Scenario | Hypothesis | Runnable today | Command |
|---|---|---|---|
| S1 deposit at scale | H3 (memory arm), H1 (`anchors-baseline` / `anchors-paged` on a chain) | yes | `pnpm --filter @firsthand/experiments s1 -- --n 10000` · `… s1 -- --arm anchors-paged --n 2560` |
| S2 buyer loop | H1 (settlement gas), H3 (manifest with receipts) | yes (memory, `anchors-baseline`) | `… s2 -- --n 100` · `… s2 -- --arm anchors-baseline --n 100` |
| S3 rescission race | H2 | yes (`B2-public-mempool`, `commit-reveal`, `btx-blind` on anvil; `btx` needs `BTX_RPC_URL`) | `… s3 -- --arm B2-public-mempool --n 50` · `… --arm commit-reveal` · `… --arm btx-blind` |
| S4 refusal | refusal precision | yes | `… s4 -- --n 1000` |

## Findings so far (memory arm, this machine)

**S1, 10 000 passports, batch 256 → 40 anchors.** Merkle-only manifest verification (H3 as
specified: ≤ 8 hashes/asset) **1.93 s** ≈ 193 µs/asset — at the 2 s target, dominated by parsing
a 12.4 MB manifest, not by hashing (8 keccaks ≈ 13 µs). Full mode that also re-proves every origin
signature: **31.4 s** ≈ 2.9 ms/asset — pure-JS secp256k1 recovery. Conclusion: H3 holds for
inclusion proofs; per-asset signature re-proof needs a native verifier (roadmap) or sampling
(`signatures: N`), and the manifest format should stream. Regressions are reported here as
prominently as wins.

**S1 on-chain (anvil --odyssey, vanilla EVM pricing), 2 560 passports = 10 batches per layout:**
baseline **168,109 gas/batch = 657 gas/passport**; paged **171,358 gas/batch = 669 gas/passport**
(+1.9 %). The clustered "page" layout is slightly *more* expensive without MIP-8's page discount —
H1 is not supported on a vanilla EVM and must be re-measured on Monad testnet (ADR-0010).

**S4 on-chain half (`anchors-baseline`), 20 forged anchors signed by a foreign deposit key against
an enrolled principal:** 20 refused by the contract (`InvalidDepositSignature`), 0 accepted; a
never-enrolled principal is refused with `EpochNotAttested`.

**S2 on-chain (`anchors-baseline`, anvil --odyssey), 1 grant → 100 paid queries → manifest:**
100 receipts recorded, **241,741 gas per `RoyaltyRouter.settle`** (EIP-3009 pull + floor split to one
payee + receipt), p50 **102 ms** / p95 **201 ms** per query end-to-end (predicate + typed-data
signing + simulate + broadcast + inclusion on anvil's instant mining); the exported manifest with the
last receipt verifies (`signatures: "all"`); after a direct rescission the next settlement is refused
by the contract (`GrantNotLive`), and no receipt is written. The memory arm (accounting double, no
token movement) runs the same loop at p50 **4.5 ms** / p95 **8.0 ms** — the predicate and payment
signing are not the bottleneck; the chain round-trip is. Per-query cost is dominated by the ERC-20
storage writes (transfer in, transfer out, nonce) and the receipt slot; the split itself is a
handful of `MULMOD`s (ADR-0003).

**S3 on-chain (anvil --odyssey, blocks every 400 ms driven by the harness, fee-ordered, 50 trials per
arm).** The observer bot is the grantee's own key submitting `RoyaltyRouter.settle` directly; an
extraction "succeeds" when the chain ordered it before the effective point — `(block, index)`, not
wall clock. Consent ends at the rescission's inclusion (the commit block for commit-reveal).

| arm | extraction success | Δ_race p50 / p95 (ms) | detection p50 | extractions before end (p50) | queries paid / trial (p50) |
|---|---|---|---|---|---|
| B2-public-mempool | **0.98** (49/50) | 411 / 603 | 15 ms | 4 | 4 |
| commit-reveal | **1.00** | 430 / 606 | 10 ms | 4 | 4 (+2 post-commit receipts across 50 trials) |
| btx-blind (no signal, **not BTX**) | **0.98** (49/50) | 381 / 521 | — | 6 | 13 |
| btx | skipped — BTX is not deployed on Monad testnet as of 2026-09 (Category Labs' batched threshold encryption; no RPC surface) | | | | |

What the numbers say, without spin:

- **The public-mempool race is real and cheap.** The bot sees the pending `rescind` in ~15 ms,
  fires four settles that outbid it on priority fee, and all four are ordered before the
  rescission in the same block. It pays only when signalled.
- **Commit-reveal does not shorten the window; it removes attribution.** The bot cannot map a
  commitment to a grant, so a paranoid bot reacts to every commit — and wins the same race. What
  the fallback buys is a *dated end of consent at the commit block*: the two settlements that
  landed after it are provably post-consent receipts (accountability, not prevention, README §14).
- **An encrypted mempool removes the signal, not block-position competition.** With no signal the
  bot must extract continuously, paying ~13 queries per trial to land ~6 in the rescission block —
  the bound BTX would leave under fee ordering. **H2 as worded (~0 % extraction under BTX, Δ_race
  median ≤ 0) is therefore not what a 400 ms fee-ordered block gives; it is not measurable until
  BTX exists, and the no-signal bound suggests the honest claim is "no targeted burst at zero idle
  cost", not "the race never starts".** The obvious mitigation — the principal bidding a high
  priority fee on the rescission so it is ordered first in its block — is not yet measured
  (`PreparedTx` carries no fee fields; follow-up).
- One trial per public arm was cut off: the block sealed between broadcast and the bot's burst.

**S4, 60 injected attacks × 3 classes (foreign lineage, forged content, replayed epoch) + 60
genuine:** precision 1.0, recall 1.0 — the locker refused every unprovable deposit and no genuine one.
