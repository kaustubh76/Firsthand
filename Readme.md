# FIRSTHAND
**A passkey-rooted data-provenance and consent-settlement protocol on Monad**
**Tagline:** The data locker that can prove what's inside it.
**One-line explanation:** FIRSTHAND stamps every piece of human-created data with a cryptographic passport of origin, price, and consent — so AI companies can buy the long tail of high-quality human data per query, and humans can withdraw consent faster than anyone can front-run it.

[![ci](https://github.com/kaustubh76/Firsthand/actions/workflows/ci.yml/badge.svg)](https://github.com/kaustubh76/Firsthand/actions/workflows/ci.yml)

*Monad Metropolis 2026 · Track 04: Trust, Identity & AI Infrastructure · Build window Sep 1 – Oct 13, judging Oct 14–27, winners Nov 3 · Solo: Kaushtubh (Cipher)*

> **Status (Sep 2026).** This document is the frozen spec; the build is live. **Try it:** <https://firsthand-capture.vercel.app> (passkey → capture → paid query → withdraw consent, on Monad testnet) · gateway <https://firsthand-gateway.vercel.app> · the measured evidence is the app's *Evidence* tab and [`experiments/README.md`](experiments/README.md) · judges start at [`docs/JUDGES.md`](docs/JUDGES.md), developers at [`QUICKSTART.md`](QUICKSTART.md), progress and honest gaps in [`docs/PROGRESS.md`](docs/PROGRESS.md). Two track integrations are live and measured, not declared: paid queries are verified by **Monad's native x402 facilitator** (x402 v2 — ADR-0014; settlement stays in `RoyaltyRouter.settle`, the facilitator never settles), and every settled query files **ERC-8004** `firsthand/paid-query` feedback for the buyer agent.
> Two things this document specifies are **not built**, and are named here so the spec is not read
> as a claim: the **BTX rescission path** (Monad's encrypted mempool is not deployed — the transport
> ships probe-gated and refuses rather than downgrading, and commit-reveal is the fallback that does
> ship) and the **Silver tier** of §7.2/§13/§20 (Cleanverse CVI on the grantee — read those as
> "would offer", not "offers"). [`docs/PROGRESS.md`](docs/PROGRESS.md) carries the full list.

---

## 1. Executive Summary

**The problem.** Frontier AI has consumed the public internet. Epoch AI projects with 80% confidence that the stock of high-quality public human-generated text will be effectively exhausted between 2026 and 2032; the dataset-licensing market — ~$4.8B in 2025, projected toward ~$22.6B by 2034, with single deals from $5M to $250M+ — exists because the data labs now need (real-world sensor captures, interaction histories, enterprise telemetry, human conversation) was never on the public web. It is fragmented across millions of individuals behind walls of ownership, consent, and formatting. The market's own diligence standard has crystallized into one question: *who owned this data before you, and did they agree — answerable per asset.* Today that question is answered with contracts and spreadsheets, which scale to thousands of professional rights holders and to zero individuals.

**Limitations of existing approaches.** Centralized licensed marketplaces (Troveo, Human Native AI, TollBit, ProRata) clear rights via bilateral contracts — economically impossible at individual scale. "Data locker" products have failed repeatedly because they solved storage and payment but not *verifiability*: a buyer cannot distinguish a locker of genuine human interaction history from scraped filler or synthetic sludge, so the demand side never arrived. Web-scale scraping now carries a litigation record (a $1.5B settlement is treated as the market's anchor figure). No existing system provides per-asset origin proof, machine-verifiable consent terms, automatic royalty routing, and enforceable consent withdrawal in one primitive.

**The loop FIRSTHAND creates.** A human enrolls with one passkey tap. Every datum deposited into their locker is minted with a passkey-signed **Data Passport** (origin, attestation, terms, price). Buyers verify the passport in one call, pay the poster's price per query over x402, and export a **Lineage Manifest** — a Merkle proof over every licensed passport that doubles as their compliance file. Every read emits an on-chain receipt; receipts feed the seller's earnings ledger and the buyer's audit trail; consent withdrawal (`rescind`) travels the BTX encrypted mempool so no grantee can race it. The loop: provable supply → verifiable demand → receipts → reputation and recurring access → more supply.

**Objective.** Ship the smallest protocol that makes the diligence question answerable per asset at individual scale, prove it live on Monad testnet with two external integrations, and measure (not narrate) its three core claims. Success = top-3 in Track 4. **Non-goals:** FIRSTHAND does not try to maximize dataset volume, does not attempt injection-proof screening, does not claim to un-train models, and does not build a marketplace UI — it is the rights layer marketplaces stand on.

## 2. The Central Research Question

> **Can per-asset data provenance and consent be made cheap enough to verify (one call, sub-cent, O(log n) audit) and fast enough to revoke (revocation lands before any observing grantee can complete an extraction race) that individually-owned data becomes a purchasable asset class?**

This makes FIRSTHAND more than another encrypted-storage-plus-token-gate project. It becomes a reproducible mechanism-design experiment: we measure passport verification cost, manifest proof size and verification time, and — the headline — the extraction-race window under public-mempool revocation versus BTX-encrypted revocation, in an adversarial harness. The project must demonstrate the mechanism works, not merely tell a compelling story about data ownership.

## 3. Why the Name "FIRSTHAND"?

Firsthand information is information obtained directly from the source — no intermediary, no retelling. That is precisely the property being certified: data whose rights chain has length one, from a provable human origin to the buyer, with the terms attached at the source. The name is *not* claiming the data is objectively true, high-utility, or bias-free — a passport certifies origin, consent, and integrity of the trail, never semantic quality. (Quality scoring is an explicitly separate, roadmap-stage concern; see §14.)

## 4. Why This Fits the Track

Track 04 — *Trust, Identity & AI Infrastructure*: "protocol-level primitives for trust, provenance, and user-owned data that make AI genuinely useful without any single platform capturing the value," with the belongs-here test: *the primary output is a protocol/primitive other applications build on, not a standalone consumer product.*

- **Trust:** verifiable origin and consent per asset; receipts as evidence.
- **Provenance:** the Data Passport is a certificate of origin with a tamper-evident audit trail that survives platform migration.
- **User-owned data:** keys derive only from the user's passkey; blobs are host-agnostic; exit = keys + blobs walk away; the gateway is open-spec and self-hostable.
- **Primitive, not product:** three verbs (`deposit / query / rescind`), one verification call, an SDK and an MCP tool. Marketplaces, agent platforms, and other Metropolis teams are the intended builders on top.
- **Uncapturable:** no central issuer (passkeys), no privileged screener, no protocol-held plaintext, open interchange format. Including by us.

## 5. Connection to Official / Existing Ideas

| Prior concept | Relationship / extension |
|---|---|
| Track suggested idea **#03** (personal data locker, pay-per-query) | **Anchor use case, implemented verbatim** — extended with per-asset provability, which is the missing demand-side mechanism |
| Track suggested idea **#01** (WebAuthn/P256 personhood, no biometrics) | Absorbed as the origin layer: one tap on existing hardware roots every passport |
| Track suggested idea **#02** (content passports for AI-generated assets) | **Deliberately inverted:** we passport *human*-generated assets, because in 2026 the scarce premium asset is the human original |
| C2PA / content-credentials standards | Conceptual cousin for media provenance; FIRSTHAND adds consent terms, payment settlement, and revocation — C2PA has no economic or consent layer |
| ERC-8004 (trustless agents) | Buyer agents are ERC-8004-carded; receipts feed its reputation surface |
| x402 (HTTP-402 payments) | The settlement rail for per-query pricing; Monad runs a native facilitator |
| UCAN/object-capability delegation; envelope encryption | The grant mechanics (scoped keys wrapped to a grantee's card key, attenuation-only) |
| Licensed-data marketplaces (Troveo, Human Native, TollBit) | Named prior work and *intended customers* — they clear rights by contract at institutional scale; FIRSTHAND clears rights by cryptography at individual scale |

## 6. What Makes FIRSTHAND Different?

- **vs. naive data lockers (encrypted store + token gate):** they cannot answer "who made this and did they agree" per asset; FIRSTHAND's locker *refuses* unprovable deposits — the demo's signature moment — and every response ships with its proof.
- **vs. centralized marketplaces:** they are one counterparty aggregating thousands of professional rights holders via contracts; FIRSTHAND is a standard any of them can adopt to reach the millions of individuals contracts cannot; we route royalties by protocol, they route by payroll.
- **vs. C2PA-style provenance:** certificates without settlement or consent-lifecycle; FIRSTHAND passports carry price, license terms, live grant state, and revocation.
- **vs. data-DAO / tokenized-data projects:** those pool data and sell pooled access, recreating a platform intermediary; FIRSTHAND keeps title, keys, and pricing with the individual — the protocol never holds plaintext or sets prices.

| Axis | Naive locker | Marketplace | C2PA | **FIRSTHAND** |
|---|---|---|---|---|
| Per-asset origin proof | ✗ | contractual | ✓ (media) | ✓ cryptographic |
| Consent terms machine-readable | ✗ | ✗ | ✗ | ✓ |
| Pay-per-query settlement | partial | ✗ (bulk deals) | ✗ | ✓ x402 |
| Revocation un-front-runnable | ✗ | ✗ | n/a | ✓ BTX |
| Individual-scale economics | ✗ (no demand) | ✗ (contract cost) | n/a | ✓ MIP-8 batching |

## 7. Core Mechanism

### 7.1 Observation / Input Capture (deposit)

On every deposit the client (app, phone capture flow, or import pipeline) produces a **Passport** and the chain records only its commitment. Events over heavy on-path computation throughout.

Passport `P` for datum `d`:

```
P = {
  h        = keccak256(canonical(d)),          // content hash
  origin   = pk_agent(ns, e),                  // deposit key (see 7.4)
  attest   = capture metadata commitment,       // device/source class, time, import-source tag
  terms    = { price, license_id, scope, ns },  // machine-readable license
  sig      = Sign_origin(h ‖ attest ‖ terms ‖ epoch ‖ nonce)
}
```

On-chain: `PassportAnchored(batchRoot, ns, epoch)` where `batchRoot` is the Merkle root of a deposit batch, written via MIP-8 storage pages. Individual passports live with the encrypted blobs (IPFS/self-host); the chain holds roots, terms hashes, grant state, receipts, revocations. **Deposit-time refusal:** the reference client rejects any datum whose origin signature does not verify against an enrolled passkey lineage — "the locker that turns data away."

### 7.2 Grant / Licensing Lifecycle (the delayed-signal analogue)

A buyer's query is only served under a live **Grant**:

```
G = { grantee_card, ns, epoch_start, term, terms_hash, wrap = Enc_pk_grantee(k_ns_e) }
```

Validation rules before any wrap is released: grantee holds a valid ERC-8004 card; terms accepted on-chain (signature over `terms_hash`); payment channel open; optional Silver-tier rule: regulated namespaces require a Cleanverse CVI attestation on the grantee. Grants are epoch-bound: a grant admits epochs `[e_start, e_now]` while live and *never* receives future-epoch wraps after rescission.

### 7.3 Core Calculation

**Key derivation (the identity math).** One passkey; WebAuthn PRF output `prf`; all keys derive:

$$k_{id} = \mathrm{HKDF}(prf, \text{"id"}) \rightarrow \text{P256 authority key}$$
$$k_{ns,e} = \mathrm{HKDF}(prf, \text{"ns"} \| ns \| e) \rightarrow \text{namespace–epoch vault key}$$
$$pk_{agent}(ns,e) = \mathrm{secp256k1\_pub}(\mathrm{HKDF}(prf, \text{"dep"} \| ns \| e))$$

Sign convention: **P256 = human authority** (enroll, terms, grant, rescind; verified via Monad's native precompile), **secp256k1 = machine labor** (deposit signing, cheap transactions). Scope is enforced by *which key exists*: no derivation path, no access — never by ACL text.

**Verification predicate (the one call).**

$$\mathrm{verify}(P, G, e_{now}) = \mathrm{SigOK}(P) \wedge \mathrm{MerkleOK}(P, batchRoot) \wedge \mathrm{GrantLive}(G) \wedge (e_{now} \le e_{attested} + g)$$

where `g` is the liveness grace (dead-man's switch: a principal who stops re-attesting freezes their locker's grants lazily — checked at verify time, no keepers).

**Royalty split (deterministic, integer-exact).** Price `p` (USDC, 6 decimals) splits by fixed-point weights `w_i` (1e18 scale, banker's rounding on the final conversion):

$$pay_i = \left\lfloor \frac{p \cdot w_i}{10^{18}} \right\rfloor,\quad residual = p - \sum_i pay_i \rightarrow \text{protocol dust pool}$$

Invariant: value is never minted nor lost; the residual is bounded by the number of recipients in wei-equivalents.

**Freshness (why query #2 gets paid).** Interaction data is a stream. Define a namespace's staleness at time `t` since last deposit as `s(t) = 1 - 2^{-t/\tau}` with half-life `τ` published per namespace; buyers price continuing access against `s(t)`. This is a *market signal computed off-chain from on-chain deposit timestamps*, not a protocol enforcement — stated as such (see §14).

**"Adverse" in this system** = any served query lacking a valid `verify()` — the protocol's toxicity metric is the count of such events, and the design target is zero by construction.

### 7.4 Aggregation / Epoch Logic

Epochs are fixed-length (demo: 1 week). Per epoch, per namespace: one vault key, one deposit key, one batch tree (roots aggregated per epoch). The **primary control metric** is the *rescission race window* `Δ_race = t_extraction_complete − t_rescind_broadcast` under adversarial observation (see §15). Secondary: verify() gas, manifest proof bytes, anchor cost per 1k passports.

### 7.5 Controller / Decision Rule (verify gate + grant state machine)

Grant states: `NONE → ACTIVE → (RESCINDED | EXPIRED | FROZEN)`. Transition rules: `ACTIVE→RESCINDED` only by P256 principal signature (via BTX path); `ACTIVE→FROZEN` lazily when `e_now > e_attested + g`; no transition ever re-releases a wrapped key. Caps and limits: per-grant query rate limit (anti-bulk-scrape throttle, set in terms), max grant term (demo: 8 epochs), max namespaces per principal (demo: 16), price floor of 1 unit to keep receipts non-degenerate.

**Initial research parameters**

| Param | Initial | Rationale |
|---|---|---|
| epoch length | 7 days | matches passkey re-attestation ritual |
| liveness grace g | 2 epochs | tolerates missed week without freezing |
| max grant term | 8 epochs | bounds stale-consent exposure |
| batch size | 256 passports | Merkle depth 8; proof = 8×32B |
| rate limit | terms-defined, default 100 q/epoch | anti-bulk-extraction throttle |
| dust pool sweep | monthly | keeps residual accounting visible |

### 7.6 Controlled Decay / Hysteresis

Rescission is intentionally asymmetric: instant to take effect, slow to forgive. Re-granting the same grantee requires a fresh grant (no auto-restore), and a namespace exiting `FROZEN` (principal re-attests) restores *future* epochs only after one full epoch boundary — preventing freeze/unfreeze oscillation from flapping attestation. Prices can change per epoch only (no intra-epoch repricing races).

## 8. Why Monad Is Essential (not decorative)

A pure application on a generic EVM cannot deliver three of the four core claims:

1. **BTX encrypted mempool → un-front-runnable rescission.** On a public mempool, a grantee watching pending txs sees the revocation and races a bulk extraction into the same block window. On Monad the rescind travels encrypted: the observer's race never starts. Fallback shipped: commit-reveal freeze (commit hash, reveal post-inclusion) — pending week-1 mentor confirmation of BTX testnet status.
2. **MIP-8 storage pages → per-asset economics.** Millions of passport anchors and receipts were cost-absurd on any EVM until the Sep 4, 2026 upgrade cut clustered-storage gas ~98%. Per-asset receipts at individual scale are the business model.
3. **Native P256 precompile → passkey authority on-chain.** Human authority ops verify WebAuthn-native signatures without a Solidity verifier's gas and audit burden — suggested idea #01 on official rails.
4. **Native x402 facilitator + ERC-8004 → the buyer side exists.** Monad's API-Hub/x402 stack (facilitator live, Foundation in the x402 Foundation) means per-query USDC settlement and carded buyer agents are platform features, not project scope.

Causal chain (text sequence): `passkey tap → PRF → derived keys → deposit signs passport → batch root anchors (MIP-8) → buyer accepts terms → grant wraps key → query pays (x402) → verify() gates → data+passport served → receipt anchors → [rescind via BTX] → next verify() fails → ledger shows timestamped end of consent`.

## 9. Smart Contract Architecture

| Contract | Responsibilities | Permissions / constraints |
|---|---|---|
| `PrincipalRegistry` | enroll principals (P256 pubkey commitment), epoch attestations, liveness state | enroll: anyone with valid P256 sig; attest: principal only |
| `PassportAnchors` | per-namespace batch roots, terms hashes | write: principal's deposit key; append-only |
| `GrantManager` | grant lifecycle state machine (§7.5), terms acceptance, wrap references | grant/rescind: principal P256 only; accept: grantee card |
| `Rescissions` | BTX-path revocation intake + commit-reveal fallback | principal P256 only; irreversible |
| `ReceiptLedger` | query receipts (payer, ns, terms hash, block), rate-limit counters | write: settlement path only |
| `RoyaltyRouter` | integer-exact split (§7.3), dust pool | pure math + transfer; no admin keys |
| `FirsthandLens` | read-only aggregation for dashboard/Envio | view-only |
| Libraries | `PassportLib`, `MerkleLib`, `SplitMath` — pure, independently fuzz-tested | no state |

Hackathon deployment is **immutable** — no proxies, no admin upgrade path (see §12).

## 10. Repository Structure

Start at [`QUICKSTART.md`](QUICKSTART.md) — `pnpm demo` runs a complete first recall in about fifteen
seconds. The whole system on one canvas: `docs/diagrams/firsthand-product.excalidraw`.

```
firsthand/                      # pnpm workspaces + Turborepo
├── contracts/                  # Solidity (Foundry): §9 contracts, libraries, fuzz + invariants
│   ├── src/ test/ script/      #   deploy writes deployments/<chainId>.json
│   └── ts/ abi/                #   typed deployment loader + generated ABIs
├── packages/
│   ├── core/                   # encodings, Merkle, SplitMath, epochs, verify() predicate
│   ├── crypto/                 # PRF→HKDF tree, P-256 / secp256k1, envelope, sealed box
│   ├── adapters/               # ports + memory doubles + on-chain implementations
│   ├── sdk/                    # Locker, Batcher, the three verbs, Lineage Manifest
│   ├── runtime/ importers/     # logging/env; ChatGPT & Claude exports → namespaces
│   ├── test-vectors/           # golden vectors shared by vitest and forge
│   └── indexer/                # Envio Consent Ledger (spec only — see ADR-0013)
├── apps/
│   ├── gateway/                # serving path: verified ingest, x402 query, relay (holds no keys)
│   ├── mcp/                    # firsthand-mcp: the verbs as agent tools
│   ├── capture/                # PWA: phone capture → passport, relayed on chain
│   └── demo/                   # `pnpm demo` — the first recall, end to end
├── experiments/                # S1–S4: race window, gas, refusal (§15) + raw results
├── docs/                       # ADRs, SECURITY.md, spec appendix, diagrams, PROGRESS.md
├── deployments/                # addresses + NOTES.md (judge credentials, testnet notes)
├── integrations/ demo/         # partner templates; demo assets
```

## 11. Risk / Control State

```solidity
struct PrincipalState {
    bytes32 p256KeyCommit;      // enrolled authority key
    uint64  lastAttestedEpoch;  // liveness
    uint8   status;             // ACTIVE | FROZEN
}
struct GrantState {
    bytes32 granteeCard;        // ERC-8004 ref
    uint32  ns;
    uint64  epochStart;
    uint64  epochEnd;           // 0 while ACTIVE
    bytes32 termsHash;
    uint8   status;             // ACTIVE | RESCINDED | EXPIRED | FROZEN
    uint64  queriesThisEpoch;   // rate limit counter
}
```

Regimes: `ACTIVE / FROZEN` per principal; grant states per §7.5. All gating (`verify()`, royalty split) is **deterministic from validated on-chain state** — no oracle, no off-chain judgment on the serving path.

## 12. Required Security Properties

- **AuthN/AuthZ:** every authority mutation requires a P256 signature verified via precompile against the enrolled commitment; deposit writes require the epoch deposit key; grants bind to ERC-8004 cards.
- **Safety bounds:** rate limits per grant; max term; price floor; batch-size cap; residual-dust invariant (`Σ pay + residual = p`, fuzz-tested).
- **Observation/finalization safety:** passports carry nonces (no replay); batch roots append-only; receipts unique per (grant, query nonce); epoch ordering monotone.
- **Liveness:** if BTX is unavailable → commit-reveal fallback path is always deployed; if the gateway/host is down → blobs are user-held, chain state is source of truth, any conformant client resumes; if the principal disappears → lazy freeze protects future consent.
- **Upgrade/governance:** immutable for the hackathon; parameter changes only via redeployment; no admin keys anywhere on the serving path.
- **Key hygiene:** PRF output and derived secrets never leave the client; SECURITY.md documents the full derivation tree and rotation semantics.

## 13. Threat Model

| Threat | Mitigation |
|---|---|
| Grantee front-runs rescission (bulk extraction race) | Rescind via BTX encrypted mempool; commit-reveal fallback; measured in §15 (H2) |
| AI-generated data laundered through a real passkey ("synthetic laundering") | Attestation classes on passports (import-tagged vs device-capture vs unattested); buyers filter by class; honest limitation §14 — origin ≠ semantic humanity guarantee; roadmap: hardware capture attestation |
| Passport replay / re-mint of same content | Nonces + content-hash dedup per namespace; duplicate anchors rejected |
| Stolen passkey | Platform-authenticator protections + epoch rotation bounds blast radius; guardian threshold recovery documented (demo: single passkey) |
| Bulk scraping within a live grant | Rate limits in terms; receipts make over-scope reads provable license breaches (accountability where prevention is impossible) |
| Sybil lockers (one human, many passkeys) | Not prevented at protocol layer (stated); economic relevance low — value accrues per verified stream, not per identity count; CVI tier (Silver) offers verified-human namespaces |
| Malicious MCP client injecting deposits | Deposits only valid under the user's derived keys; a hostile client can pollute *its user's* locker only; per-source attestation tags isolate importer trust |
| Chain reorg on anchors | Receipts and anchors carry block refs; manifest verifier requires finality depth |
| Us (protocol capture) | No admin keys, open spec, self-hostable gateway, exit = keys + blobs |

## 14. Honest Limitations (must never be claimed away)

1. Rescission governs **future** access and timestamps the end of consent; it **cannot un-read delivered plaintext or un-train a model.**
2. A buyer can cache and re-use delivered data; FIRSTHAND provides **accountability (provable license breach via receipts), not prevention.** The per-query market prices *continuing access to an evolving stream*, and we say exactly that.
3. A passport proves **origin key, attestation class, consent, and integrity — not truth, quality, or strict one-human-one-passkey.** Commodity-phone capture attestation is heuristic; hardware attestation is roadmap.
4. No injection/poisoning screening ships in core; provenance tags are the shipped defense layer (screening literature cited in SECURITY.md, not denied).
5. BTX advantage holds only where BTX is live; fallback narrows but does not eliminate the race — measured, not asserted.

## 15. Research Experiment

**Baselines:** (B1) naive ACL locker (no passports) on Monad; (B2) FIRSTHAND with rescission over the public mempool.

**Scenarios:** S1 deposit-at-scale (10k passports, batch=256); S2 buyer loop (grant→100 paid queries→manifest export); S3 adversarial rescission: an observer bot with mempool visibility attempts maximum-speed extraction on rescind broadcast, 50 trials per arm; S4 refusal: 1k unprovable deposits injected.

**Metrics:** verify() gas; anchor cost /1k passports (MIP-8 vs naive SSTORE baseline); manifest proof size + off-chain verification time; `Δ_race` distribution and extraction success rate per arm; refusal precision (target 100% on S4); royalty-split invariant over 1e6 fuzz runs.

**Hypotheses:**
- **H1:** per-asset anchoring + verification lands under 1¢-equivalent per datum at batch=256 (MIP-8 delta reported vs baseline).
- **H2:** extraction success rate under BTX rescission is ~0% vs materially >0% under public-mempool rescission at equal bot latency; `Δ_race` median ≤ 0 for BTX arm.
- **H3:** manifest verification is O(log n) — ≤ 8 hashes per asset at batch 256 — and a 10k-asset corpus verifies in < 2s in the reference verifier.

Regressions and failed hypotheses are reported in the README as prominently as wins; the experiment traces (scripts + raw outputs) are first-class deliverables in `/experiments`.

## 16. Development Roadmap (verification-gated)

- **Phase 0 — Freeze the mechanism (before any production code):** this document is the frozen spec; the two gating externals resolved: (a) Mera PRF exposure for external HKDF derivation, (b) BTX testnet availability. Gate: written mentor answers or fallbacks locked.
- **Phase 1 — Keys & registry:** PRF→HKDF tree, P256 enroll/attest, `PrincipalRegistry`. Gate: ceremony→on-chain enroll round-trip on testnet + key-tree unit tests green.
- **Phase 2 — Passports & anchors:** `PassportLib`, batching, `PassportAnchors`, deposit refusal. Gate: S1 + S4 pass.
- **Phase 3 — Grants, payment, verify:** `GrantManager`, x402 settlement, `verify()`, `RoyaltyRouter`. Gate: S2 end-to-end paid query on testnet.
- **Phase 4 — Rescind:** BTX path + fallback, race harness. Gate: S3 run, H2 data collected.
- **Phase 5 — Surfaces:** SDK polish, `firsthand-mcp`, importers, capture PWA, Envio ledger, docs, SECURITY.md. Gate: quickstart-to-first-recall < 10 min by a non-author (Cipher volunteer).
- **Phase 6 — Traction & freeze:** two integration PRs landed, demo recorded, deployment + judge credentials, videos. Gate: submission checklist complete; code freeze.

## 17. Suggested Calendar (actual dates)

| Dates | Work |
|---|---|
| **Sep 13–16** (ETHOnline tail, light) | Phase 0: register project, repo public + judge access, Cipher affiliation declared, mentor gate questions posted, Cleanverse sandbox request |
| **Sep 17–21** | Phase 1 |
| **Sep 22–26** | Phase 2 |
| **Sep 27–Oct 2** | Phase 3 |
| **Oct 3–5** | Phase 4 (+ Silver go/no-go decision Oct 3: Cleanverse tier, quality-score v0) |
| **Oct 6–9** | Phases 5–6; **submission effectively frozen Oct 9** (Aqua0 travel buffer) |
| **Oct 10–13** | Polish, videos re-cuts, rehearsal only — no new build. Deadline Oct 13 |

## 18. Team Split

Default: **solo** (explicitly welcomed by rules; "a team of one is a team"). Ownership discipline replacing peer review: every phase gate requires (a) CI green with coverage on math libs ≥ 95%, (b) invariant/fuzz suites for `SplitMath`/`MerkleLib`, (c) a self-review checklist commit.
**If one teammate joins (frontend/DevRel profile):** Developer A (Kaushtubh) — contracts, keys, experiments; Developer B — capture PWA, docs site, importers, integration PRs, videos. Shared: demo rehearsal. Review rule: each phase reviewed by the one who didn't write it. **Precondition:** written prize-split + post-event IP/continuation agreement before first commit (DeltaV/residency makes ambiguity expensive).

## 19. Three-Minute Judge Demo Script (timed)

- **0:00–0:20 — Problem:** "AI has eaten the public internet. The data labs need next belongs to millions of people who can't prove it's theirs, real, or consented. The market's own test: *who owned this, and did they agree — per asset.* Nobody can answer it at individual scale. We can."
- **0:20–0:50 — Deposit:** import a real ChatGPT export (passports mint, anchors land); phone captures a live clip, one tap, passport stamped.
- **0:50–1:05 — Refusal:** inject a scraped datum — locker rejects it on origin proof, on camera. "A locker is worth what you can prove about its contents."
- **1:05–1:50 — Query:** Qwen buyer agent accepts terms, pays the set price via x402; data returns *with its passport*; export the Lineage Manifest — "this file is the buyer's audit answer."
- **1:50–2:25 — Rescind:** passkey tap; split screen: public-mempool arm shows the extraction bot winning the race, BTX arm shows the same bot's query dying mid-flight. Consent Ledger shows the timestamped end of consent.
- **2:25–3:00 — Evidence & close:** H1/H2/H3 numbers on screen from `/experiments`; "three verbs, one primitive, live on Monad — the rights layer the $22B data economy is missing."

## 20. Likely Judge Questions (with honest answers)

- *"A buyer caches everything after one query — why is query #2 paid?"* → It isn't, for static data; the market sells continuing access to an evolving stream plus provable license accountability via receipts — stated in our docs, priced by freshness.
- *"Can't AI-generated junk be laundered through a real passkey?"* → Yes, and we never claim otherwise: passports certify origin key + attestation class + consent; buyers filter by attestation class; hardware capture attestation is the roadmap answer, and the limitation is printed in SECURITY.md.
- *"Rescission can't un-train a model — so what does it buy?"* → A cryptographically timestamped end of consent that no counterparty can pre-empt — exactly the artifact the litigation-and-compliance era prices.
- *"Why won't Troveo/Human Native crush you?"* → They're customers, not competitors: contract-based clearance can't reach individual scale; a neutral per-asset standard makes their catalogs deeper.
- *"What if BTX isn't live on testnet?"* → Commit-reveal fallback ships either way; the race-window experiment reports both arms honestly.
- *"Why Monad and not any L2?"* → Three claims die elsewhere: encrypted-mempool rescission, ~free per-asset anchoring post-MIP-8, and native P256 for passkey authority; §8 is the causal chain.
- *"One passkey = one human?"* → No, and we don't claim it; value accrues per verified stream, and the CVI tier offers verified-human namespaces where buyers require it.

## 21. Competitive Positioning

Related work acknowledged in-repo: licensed marketplaces (Troveo, Human Native AI, TollBit, ProRata), C2PA/content credentials, data-DAO pooling projects, agent-memory/poisoning literature, UCAN/ocap delegation. **The differentiated claim, to be demonstrated in code and experiment, not asserted:** *per-asset provenance + consent + settlement is cheap enough (H1, H3) and revocation is fast enough (H2) to make individually-owned data a purchasable asset class on Monad.* If the experiments falsify it, the write-up says so.

## 22. MVP Scope

**Must contain:** key tree + P256 enroll/attest · passport mint/batch/anchor · deposit refusal · grants + terms acceptance · x402 paid query + `verify()` + royalty split · BTX rescind + fallback · lineage manifest export/verify · `@firsthand/sdk` + `firsthand-mcp` · ChatGPT/Claude importers · capture PWA (minimal) · Envio Consent Ledger · `/experiments` with H1–H3 traces · docs + SECURITY.md · testnet deployment + judge credentials · two external integrations · both videos.

**Must NOT contain (explicit non-goals):** marketplace UI/discovery · quality scoring or autorater · injection screening · ZK selective disclosure · TEE attestation · cross-chain anything · token · admin keys/upgradability · mainnet.

## 23. Post-Hackathon Extensions

- Hardware capture attestation (StrongBox/Secure Enclave co-signing) — closes the laundering gap; medium complexity, device-fragmented.
- ZK manifest membership ("licensed from *some* verified human corpus ≥ N") — high complexity, clear spec written.
- Quality/consistency scoring as a separate, opt-in layer (the autorater doctrine: calibrated judge, frozen anchors, canaries) — the ACR lineage, kept out of the trust core.
- Marketplace partnerships (Troveo-class pilots) + basis-points royalty routing as the business model; DeltaV/residency continuation.
- Standards path: passport format proposed as an open interchange spec; receipts into ERC-8004 reputation.

## 24. Project Submission Description (ready to paste)

> **FIRSTHAND — the data locker that can prove what's inside it.** AI is running out of clean human data, and the data labs now need belongs to millions of people with no way to prove it's theirs, real, or consented. FIRSTHAND is a three-verb protocol on Monad: **deposit** stamps every datum with a passkey-signed Data Passport (origin, attestation, license terms, your price — one WebAuthn tap, no biometrics, no issuer); **query** lets AI companies pay you per call over x402 and export a Merkle Lineage Manifest that answers per-asset diligence and EU-AI-Act lineage in one file; **rescind** withdraws consent through Monad's BTX encrypted mempool — un-front-runnable, epoch-rotated, honestly scoped to future access. Passports anchor near-free via MIP-8 storage pages; human authority verifies through the native P256 precompile; buyer agents are ERC-8004-carded. Ships with SDK, MCP server, ChatGPT/Claude import, capture PWA, Envio Consent Ledger, an adversarial rescission-race study, and live integrations. The locker refuses data it can't prove — because a locker is only worth what a buyer can verify about its contents.

## 25. Final Pitch

The internet's free data is spent, and what remains — real human interaction, real-world capture — belongs to people who have never had a way to sell it safely or take it back. FIRSTHAND makes both true in three verbs: prove it, price it, rescind it. Built on the only chain where revocation can outrun its observers and per-asset receipts cost nothing, it is the rights layer a $22-billion licensing market is already searching for — starting with one passkey tap.

---
*Doctrine footer (repo README): claim only what ships · cite the field · cut before quality · make the honest sentence the impressive one · freeze the mechanism before the first commit.*