# For judges — the three-minute script, against the live app

Readme §19 beat by beat, with what to tap and what lands on chain. Nothing to install: a
passkey-capable browser (phone or laptop with Touch ID / Windows Hello / Android) and
<https://firsthand-capture.vercel.app>. **Enrol with a passkey the device in front of you holds** —
Touch ID on that Mac, Windows Hello on that PC, the screen lock on that phone. Do not scan a QR
code to use a passkey on a *second* device: Apple passes no PRF output through the cross-device
flow, and every key in a locker derives from that output, so the app will tell you so and refuse
rather than enrol something it cannot open. Every hash on screen opens on `testnet.monadexplorer.com`.
Relayed steps take one to three seconds (Monad's 0.4 s blocks plus the relay's confirmation wait).

| Beat (Readme §19) | Tap | What you see / what landed |
| --- | --- | --- |
| 0:00 **Problem** | — | The masthead: *the data locker that can prove what's inside it*. The status strip says `live · chain 10143 · firsthand-gateway.vercel.app`. Under it, **The script**: the seven beats of this table as a rail lit by real state — done beats checked, the next one lit, a tap jumps to it. The gear opens **Settings**: the venue's health and float, a gateway switcher, theme, install. |
| **Enrol** | *Create passkey* | Before the prompt, the three verbs and which tab each lives on — *deposit* (Capture), *query* (Recall), *rescind* (Locker) — ending on the one that matters: consent you can end, dated by a chain, with the refusal provable afterwards. Then one WebAuthn tap; the PRF output derives every key. Nothing but a credential id is stored. |
| **Activate** | the card on Capture: *Activate on chain (enroll + attest)* | Two relayed transactions (`PrincipalRegistry.enroll`, `attest`) — the browser holds no key and pays no gas. The strip now reads `attested for epoch N`. A locker attested in an earlier epoch reads *grants live through epoch N; attest to anchor new captures* instead — the chain gives two epochs of grace, so grants keep serving and only new captures need a fresh root. |
| 0:20 **Deposit** | Capture → *Note* → type → *Stamp passport* | Passport minted under the passkey, sealed client-side, batch anchored (`PassportAnchors.anchor`), ciphertext + sidecar published — *published ↗* opens the gateway's copy. *Photo / clip* does the same for the camera (≤ 4 MiB hosted), *Import export* mints one passport per ChatGPT/Claude conversation. |
| 0:50 **Refusal** | Capture → *The refusal* → *Inject a scraped datum* | A well-formed passport signed by another locker's key is turned away: `FH_REFUSED_ORIGIN` — before anything is sealed (S4). |
| 1:05 **Query** | Recall → *Run the first recall* | A demo AI buyer in the same browser funds itself from the MockUSDC faucet double (relayed `mint`), registers its card, accepts your terms; **you grant** (one passkey tap); the agent **pays per query** over x402 — `RoyaltyRouter.settle` pulls 0.001 USDC by EIP-3009, splits it to your deposit key, writes a receipt — and opens the plaintext with the wrap. *download the buyer's compliance file*: the Lineage Manifest, verified against the chain. |
| **Who checked the payment** | — (visible in `/.well-known/firsthand.json`) | `x402.verification` names Monad's native facilitator (`x402-facilitator.molandak.org`, x402 v2) — it verified that payment, and a forged signature would have been refused. `x402.settlement` names `RoyaltyRouter.settle`: the facilitator verifies, it never settles, because the receipt and the royalty split are the product (ADR-0014). The gateway offers the same verification to anyone at `POST /x402/verify`. |
| 1:50 **Rescind** | (same run; *How you withdraw* picks the path) | **Directly**: one passkey-signed `GrantManager.rescind`, effective at its own block and visible in the public mempool before it lands. **Privately**: `Rescissions.commit(keccak(grantId, salt))` — no grant named, no signature, **no passkey tap** — then *Reveal and end consent*, which back-dates the end of consent to the **commit's** block. Either way, *The same query is refused*: `FH_GRANT_RESCINDED` (HTTP 403) — no data, no charge. Between a commit and its reveal the buyer is still served: a commitment is not a rescission. |
| 2:00 **Ledger** | Locker | Grants with *withdrawn*, each live one showing *runs through epoch N* (consent lapses on its own even if nobody withdraws it); Earnings — priced from the terms the chain registered and split by their own weights, not from the app's idea of its price; the **Consent Ledger** — enrolled · attested · granted · rescinded, a rescission drawn as a cut and dated by the block consent *ended* at, which on the private path is the commit's, with the reveal's own block named beside it; and *Export + verify manifest*. |
| 2:25 **Evidence** | Evidence tab | H1 (+1.9 % on a vanilla EVM, −4.2 % on Monad — the sign flip), H2 per arm with BTX *not measurable* and its venue named (local anvil — Monad exposes no global mempool, so the race cannot be run there at all), H3 1.93 s Merkle-only vs 31 s full re-proof, S2, S4 — read from `experiments/results` at build. |
| **Verify** (any time) | Verify tab, no locker needed | Paste a manifest → verified against the chain (edit one proof index → `MERKLE_INVALID`). Paste a passport id → origin, terms, anchor block. Paste a principal id (or open a shared locker link) → what they published, with each passport's attestation class and the namespace's freshness (README §7.3), **and that locker's Consent Ledger** — the auditor's view, no passkey, bounded by the gateway's scan window, which the card states. Paste an ERC-8004 agent id → its identity, card binding and reputation. Beside the manifest verdict, `FirsthandLens` answers in the present tense: *consent now: N of M grant(s) would still be served* — the file proves the sale, the chain says whether consent still stands. |
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
  arm *not measurable* and names its venue: the arms ran on a local anvil, because Monad exposes no
  readable global mempool, so the race cannot be staged there at all. Commit-reveal **is** a path you
  can run here on your own grant — it is the fallback that ships — but it does not win the race: S3
  measured its extraction success at 1.00 against the public mempool's 0.98. What it buys is the
  timestamp, not immunity.
- **The Silver tier.** Readme §7.2 describes an optional rule — regulated namespaces requiring a
  Cleanverse CVI attestation on the grantee — and §13 and §20 refer to it in the present tense.
  **Nothing implements it**, as [`docs/PROGRESS.md`](PROGRESS.md) has said throughout. The sandbox
  exists and the integration shape is known (an off-chain EIP-712 attestation read through an
  oracle, already used by other projects on this chain), but the check belongs in
  `GrantManager.acceptTerms`, which is immutable by design — adding it means a constructor
  argument and a redeploy, and the anchors contract is the EIP-712 `verifyingContract` for every
  passport already minted. That was not a trade worth making inside the build window. Read §13 and
  §20 as "would offer", not "offers".
- **A class-3 capture from real hardware.** The tier is built and deployed:
  `HardwareDeviceRegistry` is live on Monad testnet at
  `0x76d709c041054F655e6b26d61830d32D10cDaa20`, it verifies an Android key-attestation chain on
  chain through the RIP-7212 precompile, and the Locker&rsquo;s **Devices** card will register one
  and revoke it in front of you. Twenty tests run the whole lifecycle against a chain — register,
  the contract verifying a capture witness, the same witness refused once transplanted onto a
  second locker, and refused again after revocation.
  **What that deployment is anchored to is a certificate this repository generated**, and its
  private key is in `packages/test-vectors`. So on testnet today anyone can forge a class-3
  device; a registration there proves the verifier and the plumbing and says nothing about
  hardware. The card says so itself, having read the registry&rsquo;s own `anchors()` rather than
  being configured with the fact. The reason it is not anchored to a real attestation root is
  arithmetic, not laziness: both roots Google publishes are RSA-4096 and P-384 (recorded, with the
  date, in `packages/test-vectors/recordings/`), RIP-7212 verifies P-256 only, so the anchor has
  to be a batch-specific *intermediate* — and that can only come off a handset. Anchors are
  constructor arguments with no setter (§22 forbids an upgradable anchor), so pinning the real one
  is a redeployment, which is one command and costs 0.3 MON.
  What it would prove even then is **transplantation resistance** — the witness cannot move
  between devices or lockers — and *not* that a camera saw anything. That is README §14
  limitation 3 and it is not going away.
- **A large live clip.** Hosted captures are capped at 4 MiB (Vercel's request-body ceiling; the
  gateway publishes the limit). A self-hosted gateway takes 8 MiB.
- **Weekly epochs.** A locker attested in an earlier epoch needs *Attest this epoch* (offered on the
  Capture card) before it **anchors** again — the app says so before anything reverts, and the strip
  announces a rollover inside its last six hours. Its **grants are unaffected** for two epochs of
  grace: granting, approving a request and being served all keep working, because that is what the
  chain's `effectiveStatus` says.
- **The reputation credit, sometimes.** A paid query by a carded agent should file one unit of
  ERC-8004 feedback. On the hosted gateway that happens after the response, and Monad's public RPC
  allows 15 requests per second from a serverless function's shared egress — measured twice on
  2026-09-27, a live run's four chain reads fell inside a saturated window and the credit never
  landed. The retry is tested and the outcome is now reported by `/healthz` (`reputation`), so the
  failure names itself instead of looking like the feature being switched off. Self-hosted, with its
  own RPC, it lands.
- **The venue's float.** Every relayed step is paid by the gateway's relayer (≈0.43 MON per full
  script at 102 gwei, measured 2026-09-27 — the private rescission is two transactions where the
  direct one is one). The strip words the float once it is low; if it runs dry the app says so in
  a banner (`FH_INSUFFICIENT_FUNDS`) and reading, verifying and the evidence still work.

## Proof that this script works

`pnpm --filter firsthand-capture e2e` drives this path and more in headless Chromium with a virtual
passkey: every beat above, plus an outside buyer's handshake, the private commit→reveal withdrawal
(asserting that consent still holds between the two steps), the auditor's public ledger opened in a
second browser context that holds no credential, and a 390 px phone pass. It is a required CI job on
a local chain, and runs on Monad testnet and against the live links by hand (`E2E_TESTNET=1`, or
`E2E_GATEWAY_URL` / `E2E_APP_URL`). `scripts/live-gate.mjs` separately checks that the live links are
serving the bytes this repository has committed. The transactions of recent live runs, and what each
of them cost, are in [`deployments/NOTES.md`](../deployments/NOTES.md).
