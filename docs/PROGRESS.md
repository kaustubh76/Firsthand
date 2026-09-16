# FIRSTHAND — progress report

**Monad Metropolis 2026 · Track 04 (Trust, Identity & AI Infrastructure) · solo build**
Repo: <https://github.com/kaustubh76/Firsthand> · as of 16 Sep 2026
**Live on Monad testnet (chainId 10143)** — addresses and costs in `deployments/NOTES.md`

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
| 5 · Surfaces | quickstart + `pnpm demo`, MCP and capture PWA on the live deployment, gateway relay, Consent Ledger | **done** except Envio and the docs site |
| 6 · Traction & freeze | two external integration PRs, testnet deploy, demo, videos | next |

Shipped so far: 7 immutable contracts (no proxies, no admin keys) with **121 Foundry tests, 100 %
line coverage** on `src/`, 10 000-run fuzz and invariant suites; a TypeScript monorepo of 10
packages with **309 tests** and coverage gates; an MCP server with all seven tools; a self-hostable
gateway that holds no key material; a capture PWA; ChatGPT/Claude importers; and an experiments
harness whose raw traces are committed as JSON.

Every phase gate runs against a live chain in CI (`anvil --odyssey`, which ships the RIP-7212 P-256
precompile), not just against mocks — **and all four now also pass against the real deployment on
Monad testnet**, where the P-256 precompile is native rather than emulated. Deploy plus the full
gate-and-experiment run cost 3.18 MON.

## What the experiments actually measured

Results are reported the same way whether they support the thesis or not.

**H3 — verification is cheap (supported).** 10 000 passports, batch 256 → 40 anchors. Merkle-only
manifest verification: **1.93 s** (≈ 193 µs/asset, 8 hashes each) — at the 2 s target. Re-proving
every origin signature as well costs 31.4 s in pure JS; that needs a native verifier or sampling,
and it is written down as such.

**H1 — clustered storage is cheaper: false on a vanilla EVM, true on Monad.** The same harness, the
same 10 × 256 batches, two pricings:

| layout | anvil (vanilla EVM) | Monad testnet |
|---|---|---|
| baseline | 168 109 gas/batch | 200 858 |
| paged (clustered) | 171 358 (**+1.9 %**) | 192 450 (**−4.2 %**) |

The sign flips. Clustering costs 1.9 % extra under uniform SSTORE pricing and saves 4.2 % under
Monad's — which is precisely why both layouts were built and kept. Monad also charges more in
absolute terms for the same anchor, so the layout choice matters more there, not less.

**Paid query path.** `RoyaltyRouter.settle` — EIP-3009 pull, integer-exact royalty split, receipt —
costs **241 741 gas** on a vanilla EVM and **348 087 gas on Monad testnet** (+44 %). End-to-end
query latency is p50 **3.5 s** on testnet against 102 ms on instant-mining anvil — real blocks and
confirmation, not predicate cost. Receipts land on chain, the manifest carrying them verifies, and
the first settlement after a rescission reverts.

**H2 — an encrypted mempool stops the extraction race (the interesting one).** Two things get in the
way of measuring this on Monad, and both are worth stating plainly. BTX is not deployed. And Monad
has **no global mempool** — RPC nodes forward straight to the next leaders, so `txpool_content` does
not exist and an RPC-level observer has nothing to watch at all; the harness refuses the arm with
that reason rather than reporting blind trials as a result. The realistic adversary on Monad is a
leader or builder with privileged visibility, not a bot on a public endpoint, which narrows H2's
threat model considerably. What follows is therefore the anvil measurement of the bound: 50 trials
per arm,
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
   Related: with no global mempool on Monad, is the intended threat model for BTX *leader*
   visibility rather than mempool visibility? That changes what H2 should even be claiming.
2. **MIP-8 storage pages.** My clustered layout measures 4.2 % cheaper than the flat one on testnet,
   which is the right direction but smaller than the ~98 % headline. Is there a spec or pricing note
   so I can tell whether the layout is actually hitting the page discount, or only partly?
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
> + withdrawable consent. **Live on Monad testnet** — all ten contracts deployed and all four phase
> gates passing against the real chain, P-256 enrolment running on the native RIP-7212 precompile.
> Phases 0–4 of 6 done: 121 Foundry tests at 100 % line coverage, gateway, MCP server, SDK, capture
> PWA, and an experiments harness whose raw traces are committed.
>
> The headline result: I shipped two storage layouts specifically to test whether clustering pays on
> Monad. On a vanilla EVM the clustered one is **1.9 % worse**; on Monad testnet it is **4.2 %
> better** — the sign flips, so that claim is true on Monad and false generically. A paid query
> settles in 348 k gas on testnet (242 k on a vanilla EVM). Refusal holds at precision/recall 1.0.
>
> Two things I'd love help with: (1) **BTX** — any testnet endpoint or timeline? My transport is
> written and probe-gated. And since Monad has no global mempool (`txpool_content` doesn't exist, so
> my RPC-level observer bot has nothing to watch), is BTX's threat model *leader* visibility rather
> than mempool visibility? That changes what my H2 should claim. (2) **Integration partners** for
> Phase 6 — if you're building an agent or marketplace that wants provenance-checked data with a
> receipt trail, integration is an SDK call and an endpoint, and I'll write the PR.
>
> Repo: https://github.com/kaustubh76/Firsthand

---

## Update — Phase 5 in progress (16 Sep 2026)

**A stranger can now get to a first recall.** `QUICKSTART.md` → `pnpm demo` spawns a local chain,
deploys, starts the real gateway process and runs the whole loop — deposit, grant, two paid queries,
Lineage Manifest, rescission, and the refusal that follows it — in **about 15 seconds**, with no
keys, no faucet and no accounts. `pnpm demo -- --testnet` runs the identical script against the live
Monad deployment; transaction hashes print as explorer links.

Three things that were quietly broken and are now fixed:

- **The MCP server could never produce a recallable deposit.** It hardcoded an in-memory anchor
  writer regardless of configuration, so nothing it deposited was anchored, and the gateway refused
  the sidecar as unanchored. It now reads one `DEPLOYMENTS_FILE`, anchors for real and publishes to
  a gateway — and when it is *not* configured for that, the tool says so instead of looking fine.
- **`.env` files were decorative.** Nothing loaded them; a gateway started per its own README ran on
  defaults while the operator believed otherwise. Both apps now load `.env` and log which file.
- **A browser could not submit a transaction at all.** The gateway has an opt-in relay
  (`POST /v1/relay`), allow-listed to the deployment's authority contracts, zero value, simulated
  first — safe because authorisation lives in the calldata, never in `msg.sender`.

**The Consent Ledger is real and reads from chain logs** (ADR-0013), exposed at
`/v1/principals/:id/timeline` — the demo's last step prints enrolled → attested → granted →
rescinded with block numbers. Envio remains the indexed path; two measured limits made the log path
worth pinning down: Monad's public RPC caps `eth_getLogs` at **100 blocks per call** and **25
requests/second**, so this is a recent-window view, not an archive.

Still open in Phase 5: the capture PWA on live contracts (the relay unblocks it), the docs site, and
Envio's handlers.

### Update — the capture PWA is live (16 Sep 2026)

**Every user-facing surface now reaches the chain.** The PWA was the last one on memory doubles:
nothing it captured was anchored or published, and its rescission screen printed a transaction hash
that the memory transport had invented. It now discovers every address from the gateway's
`/.well-known/firsthand.json` — the browser's substitute for the deployment file it cannot read —
reads through a key-less viem client, and **writes through the gateway's relay**. Verified against
Monad testnet: enrol → attest → capture → anchor → publish, after which `GET /v1/passports/:id`
serves the sidecar, so a buyer can query what a phone captured.

The browser holding no key is not a workaround; it is the architecture. Every authority-signed entry
point authorises by the signature inside the calldata rather than `msg.sender`, so relaying cannot
change what a call means — the relay is allow-listed to the deployment's contracts, rejects non-zero
value, and simulates before spending gas.

Two things running it for real surfaced:

- **Relaying returns when the gateway accepts a transaction, not when it lands.** `attest` was being
  simulated against a principal that `enroll` had not yet written, and was refused. Dependent calls
  now wait for inclusion — the kind of bug that only appears against a real chain.
- **Anchoring requires enrol + attest first**, because `PassportAnchors.anchor` checks the deposit-key
  signature against the attested root. The PWA now has an explicit "Activate on chain" step rather
  than failing at the first anchor.

Also: `firsthand_import` turns a ChatGPT or Claude export into one passport per conversation (the
`--from-export` the docs had promised and nothing implemented); the gateway serves a landing page at
`/` instead of a 404; and README §10 now describes the repository that actually exists.

**Still not built:** Envio handlers (deferred — the logs-backed Consent Ledger covers the demo, see
ADR-0013), the docs site, media/clip capture in the PWA, and the MCP↔PWA WebAuthn PRF handoff.
