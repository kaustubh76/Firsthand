# For judges — the three-minute script, against the live app

Readme §19 beat by beat, with what to tap and what lands on chain. Nothing to install: a
passkey-capable browser (phone or laptop with Touch ID / Windows Hello / Android) and
<https://firsthand-capture.vercel.app>. Every hash on screen opens on `testnet.monadexplorer.com`.
Relayed steps take one to three seconds (Monad's 0.4 s blocks plus the relay's confirmation wait).

| Beat (Readme §19) | Tap | What you see / what landed |
| --- | --- | --- |
| 0:00 **Problem** | — | The masthead: *the data locker that can prove what's inside it*. The status strip says `live · chain 10143 · firsthand-gateway.vercel.app`. |
| **Enrol** | *Create passkey* | One WebAuthn tap; the PRF output derives every key. Nothing but a credential id is stored. |
| **Activate** | the card on Capture: *Activate on chain (enroll + attest)* | Two relayed transactions (`PrincipalRegistry.enroll`, `attest`) — the browser holds no key and pays no gas. The strip now reads `attested for epoch N`. |
| 0:20 **Deposit** | Capture → *Note* → type → *Stamp passport* | Passport minted under the passkey, sealed client-side, batch anchored (`PassportAnchors.anchor`), ciphertext + sidecar published — *published ↗* opens the gateway's copy. *Photo / clip* does the same for the camera (≤ 4 MiB hosted), *Import export* mints one passport per ChatGPT/Claude conversation. |
| 0:50 **Refusal** | Capture → *The refusal* → *Inject a scraped datum* | A well-formed passport signed by another locker's key is turned away: `FH_REFUSED_ORIGIN` — before anything is sealed (S4). |
| 1:05 **Query** | Recall → *Run the first recall* | A demo AI buyer in the same browser funds itself from the MockUSDC faucet double (relayed `mint`), registers its card, accepts your terms; **you grant** (one passkey tap); the agent **pays per query** over x402 — `RoyaltyRouter.settle` pulls 0.001 USDC by EIP-3009, splits it to your deposit key, writes a receipt — and opens the plaintext with the wrap. *download the buyer's compliance file*: the Lineage Manifest, verified against the chain. |
| 1:50 **Rescind** | (same run) | *You withdraw consent*: one passkey-signed `GrantManager.rescind`. *The same query is refused*: `FH_GRANT_RESCINDED` (HTTP 403) — no data, no charge. |
| 2:00 **Ledger** | Locker | Grants with *withdrawn*, Earnings (receipts, USDC), the **Consent Ledger** — enrolled · attested · granted · rescinded with block numbers — and *Export + verify manifest*. |
| 2:25 **Evidence** | Evidence tab | H1 (+1.9 % on a vanilla EVM, −4.2 % on Monad — the sign flip), H2 per arm with BTX *not measurable*, H3 1.93 s Merkle-only vs 31 s full re-proof, S2, S4 — read from `experiments/results` at build. |
| **Verify** (any time) | Verify tab, no locker needed | Paste a manifest → verified against the chain (edit one proof index → `MERKLE_INVALID`). Paste a passport id → origin, terms, anchor block. Paste a principal id (or open a shared locker link) → what they published, with each passport's attestation class and the namespace's freshness (README §7.3). |
| **Handoff** (the MCP from the phone's locker) | Locker → *Let an agent deposit for you* | An `fhd1.` deposit code for one namespace and this epoch. `FIRSTHAND_DELEGATION=…` in `firsthand-mcp`: `firsthand_deposit` lands in *this* locker under *this* principal; grant, rescind and attest stay with the passkey (`FH_DELEGATION_SCOPE`). |
| **Exit** (README §4) | Locker → *Take your locker with you* | One file: ciphertext, sidecars, grant wraps — no plaintext, no key. Point the app at another gateway (`?gateway=…`) and *Re-publish here*: it verifies every object against the chain before hosting it. The browser tier proves a second, empty gateway serves the buyer's paid query under the grant it already held. |

## An external buyer, not a stand-in — and an ERC-8004-carded one

Locker → *Share your locker* gives a link. From an MCP-capable agent with the repo's
`firsthand-mcp` pointed at the live gateway (no MON, no USDC — it rides the relay and the faucet):

`firsthand_register_agent` (once, the agent's own gas) → `firsthand_list_passports({ principalId })`
→ `firsthand_request_access({ principalId })` returns an **approval link**; open it in the app →
the Locker shows *ERC-8004 agent #N · binding verified ✓* → *Approve with passkey* →
`firsthand_query` pays and opens the plaintext → the gateway credits the query to the agent on the
ERC-8004 Reputation Registry (`firsthand_agent_reputation`) → `firsthand_export_manifest` returns
the verified compliance file. Recipe in [`apps/mcp/README.md`](../apps/mcp/README.md); the same
flow as a script in [`integrations/buyer-agent`](../integrations/buyer-agent/README.md).

## What cannot be shown, and why

- **The BTX split screen.** Monad's encrypted mempool is not deployed on testnet (2026-09); the
  transport ships probe-gated and the race harness refuses to fake it. The Evidence tab marks the
  arm *not measurable*; the public-mempool arm and commit-reveal are measured honestly (S3).
- **A large live clip.** Hosted captures are capped at 4 MiB (Vercel's request-body ceiling; the
  gateway publishes the limit). A self-hosted gateway takes 8 MiB.
- **Weekly epochs.** A locker attested last week needs *Attest this epoch* (offered on the Capture
  card) before it anchors again — the app says so before anything reverts; the strip announces a
  rollover inside its last six hours.
- **The venue's float.** Every relayed step is paid by the gateway's relayer (≈0.3 MON per full
  script at 102 gwei). The strip words the float once it is low; if it runs dry the app says so in
  a banner (`FH_INSUFFICIENT_FUNDS`) and reading, verifying and the evidence still work.

## Proof that this script works

`pnpm --filter firsthand-capture e2e` drives exactly this path in headless Chromium with a virtual
passkey — including an outside buyer's handshake and a 390 px phone pass — and passes on a local
chain, on Monad testnet, and against the live links (`E2E_GATEWAY_URL` / `E2E_APP_URL`). The
transactions of the last live run are in [`deployments/NOTES.md`](../deployments/NOTES.md).
