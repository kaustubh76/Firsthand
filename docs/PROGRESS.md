# FIRSTHAND — progress report

**Monad Metropolis 2026 · Track 04 (Trust, Identity & AI Infrastructure) · solo build**
Repo: <https://github.com/kaustubh76/Firsthand> · as of 16 Sep 2026

---

## What it is, in three sentences

FIRSTHAND stamps every piece of human-created data with a passkey-signed **passport** of origin,
price and consent. AI buyers pay **per query** over x402 and every read leaves an on-chain receipt,
so a corpus comes with a Merkle-proved lineage file instead of a scraping disclaimer. Consent is
withdrawable: a rescission travels Monad's encrypted mempool (with a commit-reveal fallback) so the
grantee cannot race it — and the ledger dates the end of consent even when they try.

Three verbs — `deposit` / `query` / `rescind` — and one verification call, `verify()`, that returns
the same answer on-chain and off.

## Where the build is

The roadmap is verification-gated: a phase only closes when its experiment passes on a live chain.
**Phases 0–4 of 6 are done and pushed** (54 commits), roughly two and a half weeks ahead of the
project's own calendar.

| Phase | Scope | Status |
|---|---|---|
| 0 · Freeze the mechanism | spec frozen, externals identified | done (two externals still open — see asks) |
| 1 · Keys & registry | PRF→HKDF key tree, P-256 enroll/attest, `PrincipalRegistry` | **done** — enroll→attest round-trip on a live chain |
| 2 · Passports & anchors | passports, batching, `PassportAnchors` (two storage layouts), deposit refusal | **done** — S1 + S4 pass on chain |
| 3 · Grants, payment, verify | `GrantManager`, x402 settlement, `RoyaltyRouter`, `ReceiptLedger`, `FirsthandLens` | **done** — S2 end-to-end paid query |
| 4 · Rescind | BTX transport, commit-reveal fallback, race harness, freeze/thaw hysteresis | **done** — S3 run, H2 data collected |
| 5 · Surfaces | capture PWA on live contracts, Envio consent ledger, docs site | next |
| 6 · Traction & freeze | two external integration PRs, testnet deploy, demo, videos | next |

Shipped so far: 7 immutable contracts (no proxies, no admin keys) with **121 Foundry tests, 100 %
line coverage** on `src/`, 10 000-run fuzz and invariant suites; a TypeScript monorepo of 10
packages with **309 tests** and coverage gates; an MCP server with all seven tools; a self-hostable
gateway that holds no key material; a capture PWA; ChatGPT/Claude importers; and an experiments
harness whose raw traces are committed as JSON.

Every phase gate also runs against a live chain in CI (`anvil --odyssey`, which ships the RIP-7212
P-256 precompile), not just against mocks.

## What the experiments actually measured

Results are reported the same way whether they support the thesis or not.

**H3 — verification is cheap (supported).** 10 000 passports, batch 256 → 40 anchors. Merkle-only
manifest verification: **1.93 s** (≈ 193 µs/asset, 8 hashes each) — at the 2 s target. Re-proving
every origin signature as well costs 31.4 s in pure JS; that needs a native verifier or sampling,
and it is written down as such.

**H1 — clustered storage is cheaper (not supported on a vanilla EVM).** Baseline anchoring costs
**168 109 gas/batch (657 gas/passport)**; the clustered "page" layout costs **171 358 (+1.9 %)**.
The claim depends entirely on Monad's MIP-8 page pricing and is honestly recorded as unproven until
re-measured on testnet. Both layouts ship so the comparison can be re-run in one command.

**Paid query path.** `RoyaltyRouter.settle` — EIP-3009 pull, integer-exact royalty split, receipt —
costs **241 741 gas** per query; 100 paid queries, receipts on chain, manifest with receipts
verifies, and the first query after a rescission reverts.

**H2 — an encrypted mempool stops the extraction race (the interesting one).** BTX is not deployed
on Monad testnet, so I built the race harness anyway and measured the bound. 50 trials per arm,
400 ms fee-ordered blocks, with the observer bot submitting settlements directly:

| arm | extraction success | detection | queries paid |
|---|---|---|---|
| public mempool (baseline) | 0.98 | 15 ms | 4 |
| commit-reveal fallback | 1.00 | 10 ms | 4 (+2 post-consent receipts) |
| no-signal bound (what BTX would give) | 0.98 | — | 13 |

The honest reading: **an encrypted mempool removes the *signal*, not same-block fee competition.** A
bot with no signal, paying continuously, still lands ~6 queries in the rescission block. So H2 as
originally worded ("~0 % extraction under BTX") is not what a 400 ms fee-ordered block gives, and it
is not measurable until BTX ships. What the mechanism does deliver is bounded loss — one block of
queries, at the bot's own expense — plus a **dated, provable end of consent**, which is what the
commit-reveal path exists for. Next experiment: let the principal bid a priority fee on the
rescission and re-measure.

**Refusal.** 1 000 unprovable deposits injected (foreign lineage, forged content, replayed epoch):
precision 1.0, recall 1.0 — the client refused every one and no genuine deposit. On-chain, 20/20
forged anchors were refused by the contract itself.

## What I'd like help with

1. **BTX (Monad / Category Labs).** Is there any testnet endpoint or timeline for the encrypted
   mempool? The transport is written and probe-gated — it signs, seals through a hook, and posts via
   a configurable RPC method; it refuses rather than silently falling back to the public mempool. I
   need the method name and whether the seal step is client-side. Happy to be an early tester.
2. **MIP-8 storage pages.** Is there a spec or pricing note for clustered storage? My paged layout
   is a best guess at what the discount rewards (contiguity), and H1 rests on it.
3. **Passkey PRF (Mera or equivalent).** I need a provider that exposes the WebAuthn PRF extension
   so keys can be derived externally via HKDF. Which providers are known to expose it on mobile?
4. **Native x402 facilitator.** The client is built against the standard `exact` scheme; I'd like a
   testnet facilitator URL to run interop against, plus testnet USDC with EIP-3009.
5. **Integration partners (this is the big one).** Phase 6 needs two external integrations. The
   natural fits: an AI agent or data-buying team that wants provenance-checked training data with a
   receipt trail; a marketplace that wants per-asset lineage; or anyone building on ERC-8004 who
   wants query receipts feeding a reputation surface. Integrating is small — an SDK call and an
   endpoint — and I'll write the PR.
6. **A second pair of eyes on the H2 finding.** If the race-window analysis is wrong, I want to know
   before the demo, not after.

## What I am explicitly not building

No marketplace UI, no quality scoring or autorater, no injection screening, no ZK selective
disclosure, no TEE attestation, no cross-chain, no token, no admin keys or upgradability, no
mainnet. Rescission governs *future* access: it cannot un-read delivered data or un-train a model —
it gives accountability, not prevention, and the README says so in those words.

## Where to look

- `Readme.md` — the frozen spec (mechanism, contracts, threat model, honest limitations)
- `docs/diagrams/firsthand-product.excalidraw` — the whole system on one canvas
- `experiments/README.md` + `experiments/results/*.json` — the measurements above, raw
- `docs/adr/` — twelve decision records, including why each claim is or is not supported
- `docs/SECURITY.md` — derivation tree, rotation, threat model

— Kaushtubh

---

## Short version (for a DM or a Discord mentor channel)

> **FIRSTHAND** (Metropolis Track 04, solo): passkey-signed data passports + per-query x402 payment
> + withdrawable consent, on Monad. Phases 0–4 of 6 are done and pushed — 7 immutable contracts
> (121 tests, 100 % line coverage), gateway, MCP server, SDK, capture PWA, and an experiments
> harness whose traces are committed. Measured so far: anchoring 657 gas/passport, a paid query
> settles in 241 741 gas, 10 k passports verify in 1.93 s, and the refusal gate turns away 100 % of
> unprovable deposits. Two findings I report as prominently as the wins: the clustered-storage gas
> claim is **not** supported on a vanilla EVM (+1.9 %, needs MIP-8 pricing), and my rescission-race
> harness says an encrypted mempool removes the attacker's *signal* but not same-block fee
> competition — so the honest guarantee is bounded loss plus a dated end of consent, not "the race
> never starts".
>
> Two things I'd love help with: (1) **BTX** — any testnet endpoint or timeline? My transport is
> written and probe-gated, I just need the RPC surface. (2) **Integration partners** for Phase 6 —
> if you're building an agent or marketplace that wants provenance-checked data with a receipt
> trail, integration is an SDK call and an endpoint, and I'll write the PR.
>
> Repo: https://github.com/kaustubh76/Firsthand
