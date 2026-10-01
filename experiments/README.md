# @firsthand/experiments

Harness for README §15. Arms are adapter selections (ADR-0006); results are raw JSON under
`results/` and rendered with `pnpm --filter @firsthand/experiments report`.

| Scenario | Hypothesis | Runnable today | Command |
|---|---|---|---|
| S1 deposit at scale | H3 (memory arm), H1 (`anchors-baseline` / `anchors-paged` on a chain) | yes | `pnpm --filter @firsthand/experiments s1 -- --n 10000` · `… s1 -- --arm anchors-paged --n 2560` |
| S2 buyer loop | H1 (settlement gas), H3 (manifest with receipts) | yes (memory, `anchors-baseline`) | `… s2 -- --n 100` · `… s2 -- --arm anchors-baseline --n 100` |
| S3 rescission race | H2 | anvil only — see the Monad note below | `… s3 -- --arm B2-public-mempool --n 50` · `… --arm commit-reveal` · `… --arm btx-blind` |
| S4 refusal | refusal precision | yes | `… s4 -- --n 1000` |

## Findings so far (memory arm, this machine)

**S1, 10 000 passports, batch 256 → 40 anchors.** Merkle-only manifest verification (H3 as
specified: ≤ 8 hashes/asset) **1.93 s** ≈ 193 µs/asset — at the 2 s target, dominated by parsing
a 12.4 MB manifest, not by hashing (8 keccaks ≈ 13 µs). Full mode that also re-proves every origin
signature: **31.4 s** ≈ 2.9 ms/asset — pure-JS secp256k1 recovery. Conclusion: H3 holds for
inclusion proofs; per-asset signature re-proof needs a native verifier (roadmap) or sampling
(`signatures: N`), and the manifest format should stream. Regressions are reported here as
prominently as wins.

**S1 on-chain, 2 560 passports = 10 batches per layout — H1 measured on both pricings.**

| layout | anvil (vanilla EVM) | **Monad testnet (10143)** |
|---|---|---|
| baseline | 168,109 gas/batch · 657 /passport | **200,858 gas/batch · 785 /passport** |
| paged (clustered) | 171,358 gas/batch · 669 /passport | **192,450 gas/batch · 752 /passport** |
| paged vs baseline | **+1.9 % (worse)** | **−4.2 % (better)** |

**H1 is not supported on a vanilla EVM and is supported on Monad.** The clustering that costs 1.9 %
extra under uniform SSTORE pricing earns 4.2 % back under Monad's storage pricing — the sign of the
effect flips, which is exactly what the two-layout design was built to detect. Note also that Monad
charges *more* in absolute terms for the same anchor (+19 % baseline, +12 % paged), so the layout
choice matters more there, not less. Measured 2026-09-16 against the live deployment in
`deployments/10143.json`; ADR-0010 carries the verdict.

**Why 4.2 % and not the ~98 % headline — the MIP-8 spec answers it, and the answer is that the
measurement is right.** [MIP-8](https://mips.monad.xyz/MIPs/MIP-8) (testnet 2026-08-12, mainnet
2026-09-02, so the run above is post-activation) prices a **page of 128 consecutive 32-byte slots**
(`page_index(slot) = slot >> 7`) with `BASE_COST` 100, `LOAD_COST` 8 000, `WRITE_COST` 2 800 and
`STATE_GROWTH_COST` 17 000. The famous ratio is **8 100 → 100**: the first access to a page in a
transaction pays cold, every other slot *of that page, in that same transaction* is warm. The
discount is therefore an **intra-transaction amortisation**, and `PassportAnchors.anchor()` writes
**one batch root per transaction** — there is no second access to amortise. What the clustered
layout can still save is one page's worth of I/O, and that is what it saves: the paged arm is
8 408 gas cheaper on Monad and 3 249 gas *dearer* on a vanilla EVM (it pays for an extra scattered
`_pointer` slot), an 11 657-gas swing against one page's `LOAD + BASE + WRITE` = **10 900**. The
17 000 state-growth charge that dominates a new anchor is charged on new slot occupancy and
clustering does not avoid it. So the layout is capturing the whole discount available to this
workload; the headline describes a different access pattern — one that reads or rewrites many
clustered slots in a single transaction. The place that pattern *does* occur here is **verification**
(`isAnchored` / `anchorBlock` over many roots, and access lists, which MIP-8 explicitly dedupes by
page); measuring an `anchorMany` arm would show the same effect on the write path. Neither is
measured yet, and neither is claimed.

Caveat on the same run: `verifyMerkleMs` for on-chain arms (9.0 s / 7.3 s for 2 560 assets) is
**not** comparable to the H3 figure below — on a live chain the verifier makes one `isAnchored` RPC
round-trip per batch root, so that number is dominated by network latency, not hashing.

**S4 on-chain half (`anchors-baseline`), 20 forged anchors signed by a foreign deposit key against
an enrolled principal:** 20 refused by the contract (`InvalidDepositSignature`), 0 accepted; a
never-enrolled principal is refused with `EpochNotAttested`. **Re-run on Monad testnet 2026-09-16:
identical — 200/200 client-side refusals (precision 1.0, recall 1.0) and 20/20 forged anchors
refused on chain.**

**S2 on Monad testnet, 1 grant → 25 paid queries:** **348,087 gas per `RoyaltyRouter.settle`**
(vs 241,741 on a vanilla EVM, +44 %), query latency p50 **3.47 s** / p95 3.57 s end to end — real
0.4 s blocks plus confirmation, against 102 ms on instant-mining anvil. 25/25 receipts recorded, the
manifest with receipts verifies, and the settlement after rescission is refused. The anvil numbers
below remain the like-for-like comparison against the other arms.

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

**S3 on Monad testnet: not reproducible, and that is the finding.** The observer model needs a
readable pending pool; Monad has **no global mempool** — RPC nodes forward straight to the next
leaders — so `txpool_content` is unsupported and an RPC-level watcher has nothing to see. The
harness refuses the arm with that reason rather than reporting 50 blind trials as a result. So on
Monad the public-mempool baseline cannot even be *staged* from a public endpoint: the realistic
adversary is a leader or builder with privileged visibility, not a bot on an RPC. That narrows H2's
threat model considerably and should be stated that way rather than as a win. This is Monad's own
documented design, not an inference from a failed probe — [the differences
page](https://docs.monad.xyz/developer-essentials/differences) states it plainly: *"There is no
global mempool. For efficiency, transactions are forwarded to the next few leaders."* So the
question BTX answers here is **leader visibility**, and an encrypted mempool's claim should be read
against that adversary.

**S4, 60 injected attacks × 3 classes (foreign lineage, forged content, replayed epoch) + 60
genuine:** precision 1.0, recall 1.0 — the locker refused every unprovable deposit and no genuine one.
