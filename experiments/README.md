# @firsthand/experiments

Harness for README §15. Arms are adapter selections (ADR-0006); results are raw JSON under
`results/` and rendered with `pnpm --filter @firsthand/experiments report`.

| Scenario | Hypothesis | Runnable today | Command |
|---|---|---|---|
| S1 deposit at scale | H3 (and H1 once on-chain) | yes (memory arm) | `pnpm --filter @firsthand/experiments s1 -- --n 10000` |
| S2 buyer loop | H1 | Phase 3 | `… s2 -- --dry-run` |
| S3 rescission race | H2 | plumbing only (simulated mempool) | `… s3 -- --dry-run` |
| S4 refusal | refusal precision | yes | `… s4 -- --n 1000` |

## Findings so far (memory arm, this machine)

**S1, 10 000 passports, batch 256 → 40 anchors.** Merkle-only manifest verification (H3 as
specified: ≤ 8 hashes/asset) **1.93 s** ≈ 193 µs/asset — at the 2 s target, dominated by parsing
a 12.4 MB manifest, not by hashing (8 keccaks ≈ 13 µs). Full mode that also re-proves every origin
signature: **31.4 s** ≈ 2.9 ms/asset — pure-JS secp256k1 recovery. Conclusion: H3 holds for
inclusion proofs; per-asset signature re-proof needs a native verifier (roadmap) or sampling
(`signatures: N`), and the manifest format should stream. Regressions are reported here as
prominently as wins.

**S4, 60 injected attacks × 3 classes (foreign lineage, forged content, replayed epoch) + 60
genuine:** precision 1.0, recall 1.0 — the locker refused every unprovable deposit and no genuine one.
