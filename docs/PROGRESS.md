# FIRSTHAND — progress report

**Monad Metropolis 2026 · Track 04 (Trust, Identity & AI Infrastructure) · solo build**
Repo: <https://github.com/kaustubh76/Firsthand> · as of 17 Sep 2026
**Live on Monad testnet (chainId 10143)** — addresses and costs in `deployments/NOTES.md`
**Try it:** <https://firsthand-capture.vercel.app> (passkey → capture → anchored on Monad) ·
gateway <https://firsthand-gateway.vercel.app>

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

### Update — the browser tier, and what it caught (16 Sep 2026)

The previous update said "verified against Monad testnet". It was — from Node. Every gate in the
repo ran in Node or anvil, and none of them could see what a browser sees. So there is now a
**browser tier**: `pnpm --filter firsthand-capture e2e` serves the committed `deploy/capture` tree
(the bytes Vercel ships) in headless Chromium, drives it with a virtual passkey that speaks PRF, and
runs enrol → activate → capture → anchor → publish against a spawned anvil + gateway, Monad testnet
(`E2E_TESTNET=1`), or a hosted gateway (`E2E_GATEWAY_URL`).

Its first run failed at "Activate on chain" with *relay unreachable*. The cause was a one-line
browser-only bug in every fetch-based adapter: the transport stored `fetch` on the instance and
called `this.#fetch(...)`, which invokes `window.fetch` with `this` bound to the transport — Chrome
refuses that as "Illegal invocation". **No keyless browser could ever have anchored.** Bound to
`globalThis`, pinned by a unit test, and the tier now passes in all three modes — including against
the exact hosted gateway bundle npm-installed on Node 22, the way Vercel runs it.

The PWA also no longer has a silent failure mode: an error boundary turns render exceptions into
words, a status strip on every screen says `live · chain 10143 · host` or `offline · <why>`, and
discovery gives up after 8 s with a reason instead of hanging on "Loading…".

**Hosting (17 Sep):** both surfaces are public — <https://firsthand-capture.vercel.app> and
<https://firsthand-gateway.vercel.app> — deployed from the committed trees with the Vercel CLI
(`pnpm deploy:hosted`), durable passports in Vercel Blob, a dedicated small-float relayer. The browser
tier passes against the live URLs: real relayed transactions on Monad testnet from a public link.

### Update — the whole judge script from one link (18 Sep 2026)

<https://firsthand-capture.vercel.app> now performs all three verbs against Monad testnet, from a
browser that holds no key and pays no gas:

- **deposit** — a note, a photo/clip from the camera (mime/size/name committed in the attestation's
  `metaHash`), or a ChatGPT/Claude export (one passport per conversation, refusals collected), each
  anchored through the relay and published to the gateway. And the refusal, on screen: a well-formed
  passport signed by another locker's key is turned away with `FH_REFUSED_ORIGIN` before anything is
  sealed — the S4 gate a judge can press.
- **query** — a demo buyer agent in the same browser funds itself from the MockUSDC faucet double
  (the relay now carries exactly `mint(address,uint256)` on the token, selector-scoped), registers
  its card, accepts the terms by preimage; the human grants; the agent pays per query over x402, the
  gateway settles on chain and writes a receipt, and the page shows the plaintext, the receipt, the
  settle transaction and the payee's USDC delta.
- **rescind** — one passkey-signed transaction from the Recall screen or from any grant in the
  Locker; the same query is then refused with `FH_GRANT_RESCINDED` (HTTP 403), no data, no charge.
  (The previous Rescind screen only ever posted a commit and never revealed — consent had not
  actually been ending from the PWA. Direct rescission is the path now.)
- **Consent Ledger** in the Locker — enrolled · attested · granted · rescinded with block numbers,
  read from logs by the gateway since the principal's enrol block (`?fromBlock=` on the audit routes,
  bounded by `LEDGER_MAX_SCAN_BLOCKS`), merged with a local journal so history outlives the scan
  window. **Lineage Manifest** exported and verified in-browser against the chain, downloadable.
- Every hash links to `testnet.monadexplorer.com`; a masthead and one-sentence copy per action.

The browser tier now drives that entire script — note → photo → import → refusal → recall → ledger
→ manifest — and passes on anvil, on Monad testnet, and against the live links. It caught a second
browser-only bug on the way: the x402 header codec used `Buffer`, so the first paid query from a
page died with "Buffer is not defined". Portable base64 now.

**Still not built:** Envio handlers (the logs-backed ledger serves the demo), the external x402
facilitator (memory verification + on-chain settlement is what runs), the docs site, media beyond
6 MiB, the BTX rescission path (not on Monad testnet), and the MCP↔PWA PRF handoff.

### Update — verifiable demand, the buyer's file, durability (18 Sep 2026, later)

What README §1 promises beyond the three verbs, now on the public link and proven by the browser
tier on anvil and on Monad testnet:

- **The buyer's compliance file.** `manifestFromQueries` (SDK) builds a Lineage Manifest from what
  a paid query returns — sidecar + receipt per asset, anchor block from the chain — and
  `manifestFromSidecars` rebuilds the seller's from the gateway's public objects. The Recall tab
  hands the buyer its verified file; the Locker's export now survives a reload (it no longer depends
  on in-memory batches). The MCP gains `firsthand_export_manifest`.
- **Verifiable demand from outside the browser.** `firsthand_request_access` (MCP) reads a
  passport's sidecar, registers the agent's card, accepts the exact terms on chain — all through
  the gateway's relay, the agent holds no gas — and returns an approval link. The human opens it,
  the Locker shows "*agent* asks for namespace *n*", one passkey tap grants and publishes the wrap;
  the agent pays and exports. The e2e runs this handshake with a Node-side buyer against the page.
- **Verify, for anyone.** A tab that needs no locker: paste a manifest → verified against the
  chain (a tampered proof fails with `MERKLE_INVALID`); look up a passport id → origin, terms,
  anchor block.
- **Durability and honesty.** Earnings (receipts, USDC total) in the Locker; the status strip says
  when this epoch needs a fresh attestation instead of letting an anchor revert; the gateway
  publishes `limits.maxUploadBytes` (hosted 4 MiB — Vercel returns 413 above ~4.5 MB, measured)
  and the PWA sizes captures under it.
- SDK: a key-less client built from a deployment now anchors through its explicit transport, so the
  MCP works as seller *and* buyer against the hosted gateway with only `GATEWAY_URL` + `RPC_URL`.

**Still not built:** Envio handlers, the external x402 facilitator, the docs site, BTX (not on
testnet), the MCP↔PWA PRF handoff, and buyer-side USDC funding inside `firsthand_request_access`.

### Update — the judge's path, and the evidence on screen (18 Sep 2026, evening)

- **Activation where the judge stands.** Capture and Recall show an activation card (enroll +
  attest, two relayed transactions) instead of pointing at another tab; it stays with its
  transaction links once done. Epoch rollover shows "Attest this epoch" the same way.
- **Consent Ledger beyond the scan window.** Gateway events are merged with the local journal by
  transaction hash — chain rows carry block numbers, journal-only rows read *local record* — so a
  judge who returns hours later still sees the whole history.
- **Evidence tab** (Readme §19's last beat): H1 gas per batch/passport on a vanilla EVM and on
  Monad with the sign flip stated (+1.9 % / −4.2 %), H2 per arm with BTX marked *not measurable*,
  H3 Merkle-only 1.93 s vs 31 s full re-proof reported as the regression, S2 and S4. Every number
  is read from `experiments/results/*.json` at build time and pinned by a unit test to the README's
  figures. Reachable without a locker, like Verify.
- **The MCP buyer funds itself:** `firsthand_request_access` mints from the faucet double through
  the selector-scoped relay when discovery says the gateway relays it, and says why when it does
  not — an agent goes from "give me a passport id" to "paid and exported" with no MON and no USDC.
- Gateway landing page and discovery (`app`) point at the capture app; `docs/SECURITY.md` §8
  describes the hosted surface: what the relayer float bounds, what the Blob store holds, what the
  browser and an access-request link carry.

The browser tier now activates from the Capture card and reads the Evidence tab; passes on anvil,
Monad testnet and the live links.

### Update — supply is discoverable; the app is phone-shaped; the relay is operable (20 Sep 2026)

- **Passports by principal.** The catalog port gains `listByPrincipal` (memory, fs and object-store
  backends keep a per-principal index beside the sidecars); the gateway serves
  `GET /v1/principals/:id/passports?ns=`; the MCP gains `firsthand_list_passports` and
  `firsthand_request_access` takes a `principalId`; the Locker has **Share your locker**
  (`?principal=<id>`), which opens the Verify tab listing what that principal published. The demand
  loop no longer starts with a passport id somebody had to be told — it starts with a link.
- **Phone-shaped.** The browser tier walks every screen at 390 px and fails on any horizontal
  overflow; the nav and segmented controls wrap, tables scroll within their box.
- **Operable relay.** `/healthz` reports the relayer's float (`balanceMon`, `low` below
  `RELAYER_LOW_WATERMARK_MON`); the browser tier prints it for hosted runs.
- **The judge's path.** `docs/JUDGES.md` is Readme §19 beat by beat against the live app, with the
  two beats that cannot be shown and why; the README carries a status block pointing at the app,
  the evidence and the guides — the spec itself is unchanged.

### Update — the ERC-8004 integration, for real (20 Sep 2026, later)

Readme §5/§24 claim "buyer agents are ERC-8004-carded" and "receipts feed its reputation surface".
The reference ERC-8004 v1 registries are live on Monad testnet at the CREATE2 addresses; today the
claim is code:

- `@firsthand/adapters`: `OnchainErc8004Registry` reads an agent (owner, `data:` registration,
  the `firsthand.card` metadata), **verifies the card binding** (metadata names the card *and* the
  agent's owner is the card's owner), sums reputation; the writer registers agents and gives
  feedback. Both writes are `msg.sender`-authorised — an agent spends one transaction of its own gas
  (~0.07 MON), the venue gives feedback as itself. Memory double for tests.
- Gateway: `discovery.erc8004`, `GET /v1/agents/:id`, and — hosted default on — one unit of
  `firsthand/paid-query` feedback after every settled query from a buyer that passes `?agent=` and
  provably owns the grant's card. Off the response path; never blocks a query.
- MCP: `firsthand_register_agent`, `firsthand_agent_reputation`, `BUYER_AGENT_ID`; request links and
  queries carry the agent.
- App: the Locker's request card shows *ERC-8004 agent #N “name” · owner · binding verified ✓ · N
  paid queries credited here* — or *no identity — an unverified card*; grants remember the agent;
  the Verify tab looks agents up. The in-browser demo agent stays uncarded and says why.
- `integrations/buyer-agent`: the partner template — discover → list → card/terms → (ERC-8004)
  → approval link → poll the deterministic grant id → pay → compliance file → reputation — is the
  library the browser tier's outside buyer runs, so template and proof are one code path.

Proven on Monad testnet by the browser tier: agent #1903 registered with its card bound, the human
saw *binding verified*, the buyer found its grant on chain by itself, paid, and the Reputation
Registry shows one `paid-query` from the gateway's relayer (`getSummary` count 1). Locally (anvil,
no registries) the section reports that and runs uncarded.

Two operational notes from the run: Monad executes asynchronously, so a just-funded key must wait
for its balance to show before spending (`awaitBalance`); and the deployer key that relays for
local testnet runs had drained to 0.02 MON — refilled 1 MON from the hosted float, both need the
faucet again before the judging window.

### Update — the judging window holds; the locker walks away; the agent gets a scoped key (21 Sep 2026)

Four things, in the order a judge would meet them.

**Hosted robustness.** One relayer key served five senders across serverless instances with no
nonce management, and every failure read "relay: submission failed". Now: the paying account uses
viem's nonce manager and every sender retries a nonce collision with a fresh pending nonce; a
simulated revert decodes to its custom error (`EpochNotAttested(…)`, not "would revert") and the
app turns it into the action to take; an empty float is `FH_INSUFFICIENT_FUNDS` naming the
relayer, shown as a banner, and the status strip reads `/healthz` every minute and words the float
once it is low; discovery retries a cold-starting gateway and can be re-run from the strip; a
dropped relay or publish request is retried once (safe: the relay simulates first, publishing is
idempotent); the Consent Ledger walks newest-first with a wall-clock budget and reports what it
covered instead of timing out; the faucet relay is capped per call; hosted rate limits fit a
judging room behind one NAT. The browser tier gained a beat: a second gateway with an unfunded
relayer, and the page names it — banner, card, strip.

The live run then found the next one: Monad's public RPC enforces a per-second window shared with
everything behind Vercel's egress ("requests limited to 15/sec"; 50/s from a home IP), and viem's
second of retries did not span it — a wrap read became an opaque 500. The chain clients now back
off 300·2^n ms four times, a rate-limited RPC surfaces as 503 + `retry-after`, and every
idempotent read (the app's, the demo agent's, the buyer template's) honours it.

**Two spec claims made true.** README §13 says buyers filter by attestation class; the sidecar
carried only the hash. The attestation preimage now travels with the sidecar (verified at ingest
against `passport.attest`), listings show class / capture time / source tag and take `?class=`,
the MCP's `firsthand_list_passports` takes `class`, the buyer's compliance file carries the class
per asset (`ATTESTATION_MISMATCH` if relabelled), the Verify tab shows it. README §7.3's freshness
— `s(t) = 1 − 2^(−t/τ)` since a namespace's newest anchor — is computed by the gateway from the
anchor's block time and returned with every listing, stated as the market signal it is.

**Exit (README §4 / §12 / §13).** A locker bundle is the gateway's public objects for one
principal — ciphertext, wrapped DEKs, signed sidecars, grant wraps; never plaintext, never a key —
exported by the SDK with every object re-hashed against its reference and re-published through the
same verified ingest every publisher uses. Locker → *Take your locker with you* / *Re-publish
here*; MCP `firsthand_export_locker` / `firsthand_import_locker`. Proven by the browser tier: the
page downloads the bundle, a second empty gateway takes it whole, and the outsider pays gateway B
with the grant it already held.

**The handoff (the MCP↔PWA gap, closed).** The passkey cannot be used over stdio, so the app issues
a *deposit delegation*: the three keys of one namespace-epoch (`k_dep`, `k_nonce`, `k_ns,e`) with
the public scope, as one `fhd1.` code. `KeyTree.delegate` is the tree's one serialisation;
`DelegatedKeys` refuses every other derivation with `FH_DELEGATION_SCOPE` — no authority key, no
other namespace or epoch, nothing past the epoch boundary. `firsthand-mcp` opens it from
`FIRSTHAND_DELEGATION`; `deposit`/`import` land under the human's principal; enrol, attest, grant
and rescind answer "open the app". SECURITY.md §3 says exactly what leaves the device and why it
is a capability, not a key export. Proven by the browser tier: an agent with no passkey deposits
into the page's locker, anchored through the relay and listed by the gateway; the same code cannot
rescind.

Also: a forge test pins that a rescinded grantee cannot be re-granted in the same epoch (stricter
than §7.6); SECURITY.md §6 gains that, per-passport pricing, the off-chain ERC-8004 binding,
freshness, and the screening citations it claimed; `check:all` runs `forge test` when Foundry is
installed.

**Live, honestly.** After these changes the hosted links ran the script through activation,
captures, the recall loop, the ledger, verify (classes and freshness live), evidence, and the
outside buyer's ERC-8004 registration (agent #1907, binding verified on screen) — then hit the RPC
window described above, which the last commit handles. A full live run costs the hosted relayer
≈0.3 MON at 102 gwei (measured 20 Sep; the earlier 0.08 estimate was wrong), and both testnet
floats now sit at ≈0.23 MON: the complete live proof of the last commit, and the judging window
itself, need the faucet first.

**Still not built:** Envio handlers, the external x402 facilitator, the docs site, BTX (not on
testnet).

### Update — the interface (21 Sep 2026, later)

Every verb was wired and proven, and the page was plain: one column, system font, 210 lines of
CSS, buttons that only swapped their label while a transaction landed, a 900-character delegation
code on screen, errors as trailing red lines. This pass redesigned `apps/capture` without touching
a contract, a package or the browser tier — the e2e ran unchanged after every commit.

- **What hooks.** The Data Passport is an object (`PassportCard`: class chip, ids, and a seal that
  moves sealing → anchored → published as the deposit lands); the Consent Ledger is a timeline with
  a rescission drawn as a cut; Readme §19 is a **journey rail** under the header whose seven beats
  are derived from the credential, the chain and the journal — never from clicks; every relayed
  transaction is a **toast** (pending → mined with the explorer link) and an Activity row; the
  venue is one tap away in a **settings sheet** (gateway switcher on the `?gateway=` mechanism,
  `/healthz` + discovery readout, theme, install, forget-passkey / clear-journal).
- **Zero new dependencies.** Design tokens (dark default, light by OS or choice, reduced motion),
  inline SVG icons, `src/ui` primitives, `src/hooks` shared by every screen. The Locker became a
  dashboard of cards with stat tiles; Capture has tabs, drop zones and passport cards; Recall is a
  step timeline that now shows what was paid to whom over x402 and which mempool the withdrawal
  took; Verify shows each section's failure next to its control; Evidence is claim cards.
- **Kept honest.** The browser tier is the UI's contract (`apps/capture/README.md` lists what a
  redesign must preserve); it passed on a local chain after every commit, including the 390 px
  pass. A dark-mode tour (`e2e/dark-tour.ts`) screenshots the built tree at phone and laptop widths.
- **One harness fix on the way:** the local readiness check waited for the registry alone while
  MockUSDC's deploy could still be in flight; it now waits for every contract the demo touches.

Not done here: the hosted redeploy (the relayer float still needs the faucet before a full live run).


### Update — the x402 facilitator, for real (23 Sep 2026)

README §8 claim 4 — *"Native x402 facilitator + ERC-8004 → the buyer side exists"* — was the last
integration the spec claimed and the repo had not built. Four "Still not built" paragraphs above
record the reason as *"the blocker is an endpoint, not code."* Both halves were wrong.

**The endpoint is live**, and nothing here could have reached it. `GET
https://x402-facilitator.molandak.org/supported` (no auth) lists `exact` on `eip155:10143` and
`eip155:143` — but Monad's facilitator *"only supports x402 version 2 and above"*, and FIRSTHAND
spoke v1 in every field that v2 renamed: `x402Version: 1`, `maxAmountRequired`, `monad-testnet`,
`X-PAYMENT`. The integration was a wire-format migration, not a configuration change.

x402 v2 is now a **projection** of the same canonical requirements (`x402/wire.ts`), so nothing that
reads `maxAmountRequired` moved; CAIP-2 ids live in core; the 402 offers the price in both
spellings plus the v2 `PAYMENT-REQUIRED` header, and a payment is read from either header name. An
off-the-shelf x402 v2 agent can now pay FIRSTHAND, and every buyer built against v1 still can.

**Measured, not asserted** (`packages/adapters/test/testnet/x402-facilitator.interop.test.ts`, run
by `pnpm --filter @firsthand/adapters test:testnet`, deliberately outside `check:all` — no gate
here should depend on a third party's uptime). Three findings the documentation could not have
given:

- Monad's facilitator **verified a FIRSTHAND payment for FIRSTHAND's own MockUSDC**:
  `{"isValid": true, "payer": "0xf288…"}`. The faucet double uses USDC's exact EIP-712 domain, and
  there is no asset allow-list. That is §8 claim 4, earned.
- The x402 **specification's request envelope is refused** (`unsupported_scheme`); the one in
  Monad's own guide is accepted. The client defaults to the measured shape and the test asks both
  every run, so the day that changes, a test says so instead of a judge's query.
- It answers **verdicts with failure statuses** — `insufficient_funds` as 400, a forged signature as
  500 ("execution reverted": it verifies by simulating the transfer on chain). A client reading
  status codes as outages would retry three times to reach the same "no".

Two things were wrong at home, and this exposed them. `MemoryFacilitator` **never checked a
signature** — its own docstring said "that is the real facilitator's job" — so the gate in front of
every paid query was decorative, backed only by `RoyaltyRouter.settle` reverting later.
`LocalFacilitator` now verifies the EIP-3009 signature, the validity window, replay
(`authorizationState`) and balance, which is also the fallback ADR-0006's table had been carrying
an em dash for. And `FallbackFacilitator` consults it **only** when the facilitator is unreachable
or declines the *kind* of payment — never on a verdict about the payment itself, because falling
back on "invalid signature" would be a bypass wearing resilience's clothes.

**Settlement stays in the RoyaltyRouter.** Monad's facilitator would settle and pay the gas itself,
but its settle is a bare `transferWithAuthorization`: the USDC would move and there would be no
receipt, no royalty split and no rate-limit counter. Receipts are the product, so the gateway
verifies with the facilitator and settles on chain, and `/.well-known/firsthand.json` names both
halves (`x402.verification`, `x402.settlement`) instead of leaving a reader to assume (ADR-0014).

FIRSTHAND also offers what it had to build: `GET /x402/supported` and `POST /x402/verify` verify
x402 `exact` payments for anyone, free — and there is deliberately no `/settle`, because settling
spends this gateway's relayer float. The browser tier proves that surface on every run: a forged
signature is refused, an honest one from an unfunded stranger comes back `insufficient_funds`.

**Still not built:** Envio handlers, the docs site, BTX (not on testnet), and the Cleanverse/CVI
"Silver" tier, which the spec mentions (§7.2, §13) and nothing implements.
