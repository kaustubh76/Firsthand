# SECURITY.md

FIRSTHAND is a hackathon build (Monad Metropolis 2026). This document is the honest account of what
the code protects, how the repository enforces it, and what it does **not** claim.

## 1. Scope and contact

In scope: everything under `packages/`, `apps/`, `contracts/`. Report issues to the maintainer
(Kaushtubh, see repository profile) — please do not open public issues for key-handling bugs.

## 2. Derivation tree (byte-exact)

```
passkey ──WebAuthn prf(eval.first = SHA-256("FIRSTHAND/prf/v1"))──▶ prf (32 B, zeroized after extract)
                                                                       │
                              PRK = HKDF-Extract(SHA-256, salt "FIRSTHAND/kdf/v1", prf)
                                                                       │
        ┌──────────────────────────┬───────────────────────────────────┼──────────────────────────────┐
  "id"‖00 → k_id (48 B → P-256)   "ns"‖00‖ns‖e → k_ns,e (32 B)   "dep"‖00‖ns‖e → k_dep (48 B → secp)   "nonce"‖00‖ns‖e → k_nonce (32 B)
  human authority: enroll/attest/  vault KEK: wraps per-blob DEKs;  machine labour: signs passports     HMAC key for deterministic
  grant/rescind (P256 precompile)  wrapped to grantees per grant    and anchors (ecrecover)             passport nonces
```

Scope is enforced by *which key exists*: a grantee receives `k_ns,e` for one `(ns, e)` and can derive
nothing else. Implementation: `packages/crypto/src/kdf/keytree.ts` (ADR-0005).

## 3. What never leaves the client, and how the repo enforces it

| Material | Lives in | Enforcement |
|---|---|---|
| PRF output, PRK, all derived scalars, vault keys, DEKs, plaintext | `@firsthand/crypto` and its callers (`sdk`, `mcp`, `capture`) | `scripts/check-deps.mjs` forbids `apps/gateway → @firsthand/crypto`; pnpm isolated `node_modules` makes a stray import fail to resolve; Biome `noRestrictedImports` on the gateway |
| Secret bytes at runtime | `SecretBytes` handles | `use()`/`expose()` are the only accessors (grep `expose(` to audit); `JSON.stringify`, `String()`, `util.inspect` all redact; `dispose()` zeroizes — regression test `packages/crypto/src/memory.test.ts` |
| Logs | `@firsthand/runtime` logger | non-removable redaction of `prf`, `prk`, `secret`, `privateKey`, `dek`, `vaultKey`, `scalar`, `seed`, … plus `[bytes N]` for buffers |
| Ciphertext at rest | `BlobStore` | content-addressed; AADs bind blobs to `passportId` and `(ns, e)` so they cannot be re-attached |
| Grant wraps | `GrantManager.wrapRef` + gateway `POST /v1/grants/:id/wrap` | the gateway hosts only bytes whose `keccak256` equals the on-chain `wrapRef`; the sealed box opens only with the grantee's X25519 key, which the gateway never sees |
| Settlement + relay key (`RELAYER_PRIVATE_KEY`) | `apps/gateway` (`OnchainSettlement`, `Relay`) | pays gas for `RoyaltyRouter.settle` **and** for relayed calls to the four signature-authorised contracts — `PrincipalRegistry`, `PassportAnchors`, `GrantManager`, `Rescissions` — plus, where the USDC is the faucet double, a selector- and amount-capped `mint`. Nothing else: `to` is allow-listed, `value` must be zero, and every call is simulated first. It is not a user key, holds no user funds, and cannot sign a passport, a grant or a rescission — authorisation for those lives in the calldata as a P-256 signature (ADR-0009), which is why relaying them is safe. The buyer's EIP-3009 authorization names the router, not the relayer |

Limits: JavaScript cannot guarantee zeroization (engine copies, GC). `zeroize` is best effort;
WebAuthn PRF output is the only long-lived root and it is evaluated on demand, never stored.

**The one deliberate exception — deposit delegations.** README §12 says derived secrets never
leave the client; the MCP↔PWA handoff moves *three* of them between two of the user's own
devices, and says so. `KeyTree.delegate` emits `k_dep(ns,e)`, `k_nonce(ns,e)` and `k_ns,e` for one
namespace and one epoch, with the public scope (principal id, the epoch's sixteen deposit
addresses, chain, expiry), as an `fhd1.` code (`encodeDelegation`). Never `k_id`; never another
`(ns, e)`. `DelegatedKeys` refuses everything outside that scope with `FH_DELEGATION_SCOPE` —
so an agent holding the code can mint, anchor and publish passports into that namespace under the
human's principal until the epoch ends (as trusted as an importer), and cannot enrol, attest,
grant, rescind, read another namespace or outlive its epoch. The code is a bearer secret for that
scope: the app tells the user to paste it only into their own agent, records only the scope in its
journal, and the MCP takes it from `FIRSTHAND_DELEGATION`, logs the scope and never the code.
Pinned by `packages/crypto/src/delegation/delegation.test.ts`, `packages/sdk/src/delegation.test.ts`
and the browser tier (an agent with no passkey deposits into the page's locker; the same code
cannot rescind).

## 4. Rotation semantics

- Keys rotate **per epoch** (7 days) per namespace: `k_ns,e`, `k_dep(ns,e)`, `k_nonce(ns,e)`.
- A stolen deposit key exposes one `(ns, e)` of signing capability; deposit keys never hold funds
  (anchors are relayable, ADR-0006).
- A stolen passkey is catastrophic for future epochs; platform-authenticator protections apply.
  Guardian-threshold recovery is documented as roadmap (README §13); the demo uses a single passkey.
- Re-attestation each epoch is the liveness signal; a principal who stops re-attesting freezes their
  grants lazily after 2 epochs (no keepers). Re-attesting after a gap thaws one full epoch boundary
  later (`thawEpoch`, README §7.6, ADR-0012) so flapping attestation cannot oscillate consent; gap
  epochs can never be attested or anchored, so nothing from the frozen window is ever admitted.
- Enroll and attest are **relayable**: authorisation is the P-256 signature under the registry's own
  EIP-712 domain (ADR-0009), never `msg.sender`, so the paying wallet is unlinkable to the principal.
  Nonces are scoped per principal; a stranger cannot burn them.

## 5. Threat model (README §13) → where it is handled

| Threat | Code / test |
|---|---|
| Grantee front-runs rescission | `TxTransport` (btx vs public, path/transport consistency enforced), `Rescissions` commit store, S3 harness on chain (`experiments/src/scenarios/s3-rescission-race.ts`, findings in `experiments/README.md`) |
| Synthetic laundering through a real passkey | `AttestationClass` + `sourceTag` committed in every passport (`attest = hashAttestation(…)`) and carried in the open in the sidecar, verified at ingest; buyers filter (`?class=` on the listing, `firsthand_list_passports({ class })`) and the compliance file carries the class per asset (`ATTESTATION_MISMATCH` if relabelled); not prevented — see §6 |
| Witness transplanted between devices or lockers | class 3 (ADR-0015): `HardwareDeviceRegistry` verifies the attestation chain on chain through RIP-7212 and records the measured security level; the witness is signed over `origin ‖ h ‖ capturedAt ‖ nonce ‖ deviceClass`, so the same bytes under a second locker have a different digest and are refused (`FH_REFUSED_HARDWARE`). **Does not** establish that a sensor saw anything — see §6.3 |
| Class 3 not yet live on 10143 | **Status, stated rather than implied:** `HardwareDeviceRegistry` is written, at 100% line and branch coverage, and cross-checked against the TypeScript reader through a shared golden suite — but it is **not deployed to Monad testnet yet**, and the certificates it has been tested against are generated, not pulled off a handset. A gateway whose deployment names no registry refuses every class-3 deposit, which is the correct behaviour and the behaviour in production today |
| Attestation root above the pinned certificate | **Not verified on chain**, and measured rather than assumed: both roots Google publishes were fetched on 2026-10-03 and committed at `packages/test-vectors/recordings/google-attestation-roots.v1.json` — one RSA-4096/`sha256WithRSAEncryption`, one EC **secp384r1**/`ecdsa-with-SHA384`. RIP-7212 verifies `secp256r1` only, so neither top link is reachable on chain. `HardwareDeviceRegistry` therefore pins the highest P-256 certificate in the chain; the link above it is checked once, off chain, and the pin records that result. A test asserts both refusals through the real reader, so a future P-256 root would fail it loudly. Anchors are constructor arguments with no setter (README §22 forbids an upgradable anchor) |
| Passport replay / re-mint | deterministic nonce (ADR-0005) → structural dedup; `Batcher`, `PassportAnchors.DuplicateRoot`; S4 (`s4-refusal.ts`) |
| Stolen passkey | epoch rotation (§4) |
| Bulk scraping within a live grant | `rateLimit` middleware pre-filter; `ReceiptLedger` counters (chain is truth) |
| Sybil lockers | not prevented at protocol layer (stated) |
| Malicious MCP client | deposits valid only under the user's derived keys — `refuseUnlessProvable` |
| Chain reorg | manifests carry `anchorBlock`; verifier enforces `finalityDepth` |
| Protocol capture (us) | no admin keys, immutable contracts, open spec, self-hostable gateway |
| Poisoned gateway catalog | verified ingest (`Serving.ingestPassport`: signature, anchored root, owner, index, terms preimage) and `verifyPredicate` re-run against the chain on every serve — a bad catalog can refuse, never mis-serve (ADR-0011) |
| Payment authorization griefing | `receiptId = keccak(grantId, nonce)` binds payment to receipt; a replayed raw `transferWithAuthorization` moves funds into the router as dust, not to an attacker; `receiveWithAuthorization` is the hardening path (ADR-0011) |
| Serving a passport from another principal under a grant | `SCOPE_MISMATCH`: the anchor's `(principal, ns)` must equal the grant's, on chain (`Lens.verify`) and off (`verifyPredicate`) |

## 6. Honest limitations (README §14, verbatim in spirit)

1. Rescission governs **future** access and timestamps the end of consent; it cannot un-read
   delivered plaintext or un-train a model.
2. A buyer can cache and re-use delivered data; FIRSTHAND provides accountability (provable license
   breach via receipts), not prevention.
3. A passport proves origin key, attestation class, consent and integrity — **not** truth, quality,
   or one-human-one-passkey. Commodity capture attestation (class 2) is heuristic: nothing checks
   it. Hardware attestation (class 3, ADR-0015) is checked — a secure element's certificate chain
   is verified on chain — but it buys **transplantation resistance**, not sensor provenance:
   `setAttestationChallenge` attests the *key*, and the element signs a digest handed to it by app
   code. A camera pointed at a screen still produces a class-3 capture.
4. No injection/poisoning screening ships in core. The literature is real and not denied: Carlini
   et al., *Poisoning Web-Scale Training Datasets is Practical* (2023); Greshake et al., *Not what
   you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt
   Injection* (2023); Wallace et al., *Concealed Data Poisoning Attacks on NLP Models* (2021).
   Provenance tags are the shipped defence layer; screening is a buyer-side, opt-in concern.
5. BTX advantage holds only where BTX is live. The commit-reveal fallback does not narrow the race
   at all — S3 measured 1.00 extraction success against the public mempool's 0.98, because a bot that
   cannot attribute a commitment reacts to every commit. It removes *attribution* and dates the end
   of consent at the commit; that is the property, measured, not asserted.

Three more, found by auditing the spec against the code rather than promised anywhere:

6. **Prices are per passport, not per epoch.** README §7.6 says "prices can change per epoch
   only"; nothing enforces it — terms are committed per passport (`termsHash`), and a locker may
   mint under new terms mid-epoch. A grant is bound to one terms hash, so a buyer never pays more
   than it accepted; repricing simply means new passports under new terms.
7. **A rescinded grantee cannot be re-granted in the same epoch.** The grant id is
   `keccak(principal, card, ns, epochStart)` and a rescinded grant keeps its slot, so "a fresh grant"
   (README §7.6) needs a fresh epoch. Stricter than the spec; pinned by
   `test_rescindedGranteeCannotBeRegrantedInTheSameEpoch`.
8. **The ERC-8004 binding is verified off-chain by the venue.** Contracts store a card as
   `(owner, X25519 key)`; the agent ↔ card binding (`firsthand.card` metadata on the Identity
   Registry, owner equality) is checked by the gateway (`verifyCardBinding`) before it credits a
   paid query to the agent, and shown to the human. The chain does not gate grants on it.
9. **Freshness is a signal, not a rule.** `staleness = 1 − 2^(−t/τ)` per namespace (README §7.3)
   is computed by the gateway from the newest anchor's block time with a published half-life; a
   buyer prices on it; the protocol enforces nothing with it.

## 7. Rescission semantics

- Direct path (`GrantManager.rescind`): effective at inclusion. Over BTX the payload would be
  unreadable before inclusion. **BTX is not deployed on Monad testnet as of 2026-09**; the
  transport ships probe-gated and refuses rather than degrading to the public mempool
  (ADR-0006/0012). Commit-reveal is the fallback that ships today, and it is **not**
  un-front-runnable: S3 measured its extraction success at 1.00 against the public mempool's 0.98 —
  a bot that cannot map a commitment to a grant reacts to every commit and wins the same race. What
  it buys is a *timestamp*: the reveal back-dates the end of consent to the commit's block, so
  anything served in between is provably post-consent. Un-front-runnability needs BTX.
- Measured (S3, ADR-0012): on a fee-ordered 400 ms block, a public-mempool observer lands a
  4-query burst before the rescission in 98 % of trials; a bot with **no signal** still lands ~6
  continuously-paid queries in the rescission block. An encrypted mempool removes the signal, not
  same-block fee competition — the honest guarantee is bounded loss (one block of queries at the
  bot's own expense) plus a dated end of consent, not "the race never starts".
- Commit-reveal fallback: `Rescissions.commit(keccak(grantId ‖ salt))` by anyone (relayable, sender
  unlinkable), reveal (`GrantManager.revealRescind`, authority-signed) within `revealWindowBlocks`;
  **the effective end of consent is the commit block**.
- Both paths are authority-signed under GrantManager's own domain and nonce-scoped per principal;
  the next `RoyaltyRouter.settle` on a rescinded grant reverts (`GrantNotLive`) before any transfer.
- No transition ever re-releases a wrapped key; re-granting needs a fresh grant.

## 8. The hosted surface (Vercel, Monad testnet)

- **What the public gateway holds:** one secret, the relayer key (a dedicated key with a small
  MON float; never the deployer, never a user key) and the Blob store token. It holds no user key
  material and cannot: every relayed call carries the user's P-256 signature in calldata and no
  entry point reads `msg.sender` (ADR-0001/0009). Compromise of the relayer costs its float, not
  anyone's data or consent.
- **What bounds the float:** the relay accepts only the four authority contracts plus, on
  MockUSDC deployments, exactly `mint(address,uint256)` on the token (selector-scoped — a faucet
  double, never a real stablecoin); value must be zero; every call is simulated before gas is
  spent; the relay has its own per-IP token bucket (per instance — a pre-filter, not the
  guarantee). A determined party can still drain the float across IPs; the answer is a refill, and
  nothing on chain references the relayer, so it can be rotated at will.
- **What the Blob store contains:** ciphertext, wrapped DEKs and signed public sidecars — the same
  bytes `/v1/blobs` and `/v1/passports` serve to anyone. Objects are content-addressed and re-hashed
  on read (`ObjectBlobStore`); a tampered object is refused, not served.
- **What the browser holds:** the passkey credential id (not the key — the PRF output is derived
  on every unlock and zeroised), a local journal of public identifiers and transaction hashes,
  and — for the demo buyer on the Recall tab — a throwaway secp256k1/X25519 pair in localStorage.
  That pair is testnet demo material by design; an agent that buys for real keeps its keys in its
  own MCP process (`BUYER_PRIVATE_KEY`, `GRANTEE_SEED_HEX`).
- **What an access-request link carries:** a card id, an X25519 public key, a namespace and a
  label — all public. Approving it is a passkey-signed grant; a hostile link can only ask.
- **Exit (README §4 "keys + blobs walk away"):** a locker bundle (Locker → *Take your locker with
  you*, `firsthand_export_locker`) is the gateway's public objects for one principal — ciphertext,
  wrapped DEKs, signed sidecars, grant wraps — and nothing else: no plaintext, no key, nothing a
  passkey did not already publish. It can be carried by anyone and re-published on any conformant
  gateway (`?gateway=…` + *Re-publish here*, `firsthand_import_locker`), which verifies every
  sidecar against the chain and every wrap against the grant's on-chain `wrapRef` before hosting
  it; a bundle whose ciphertext does not hash to its references is refused before a request is
  made. The chain is the source of truth; a gateway is a cache you can leave. Proven by the
  browser tier: a second, empty gateway takes the bundle whole and serves the buyer's paid query
  under the grant it already held.
- **Upload bounds:** the function accepts bodies to `limits.maxUploadBytes` (4 MiB hosted;
  Vercel rejects larger bodies before the code runs) and the audit routes scan at most
  `LEDGER_MAX_SCAN_BLOCKS` per request inside a `LEDGER_SCAN_BUDGET_MS` wall-clock budget, so one
  caller cannot turn a request into unbounded RPC work; the response says what the scan covered.
- **What Monad's x402 facilitator sees, and what it cannot do:** the same signed EIP-3009
  authorization the buyer already sent in a public HTTP header — payer, recipient (the
  RoyaltyRouter), amount, validity window, nonce — plus the public payment requirements. No key, no
  plaintext, no passport, nothing about the seller beyond the address that is already on chain.
  Anyone who intercepts that authorization can at most submit it to the token themselves, which
  moves the buyer's USDC to the router as dust rather than to an attacker (ADR-0011), and consumes
  the nonce. The facilitator only ever *verifies* here: it is never asked to settle, so it never
  holds or moves FIRSTHAND funds (ADR-0014). If it answers that a payment is bad, that verdict is
  final — the local verifier is consulted only when the facilitator declines the *kind* of payment
  or cannot be reached, never to get a second opinion on a refusal.
- **What FIRSTHAND's own `/x402/verify` does for strangers:** verifies a signature, reads two public
  values from the chain, and answers. It writes nothing, spends no gas, and is rate-limited per IP;
  there is no `/settle`, because settling would spend this gateway's relayer float for someone else.
- **What the relay will pay for:** four authority contracts (signature in calldata), plus the
  faucet double's `mint` capped per call at `RELAY_FAUCET_MAX_UNITS` — the relay is a gas float
  for a demo, never a treasury. Errors name themselves: a decoded revert, a rate limit with
  `retry-after`, `FH_INSUFFICIENT_FUNDS` when the float is empty. None of them carries key
  material; the cause chain stays in the log.

## 9. Reporting

Email the maintainer with steps to reproduce. Expect an acknowledgement within 72 hours during the
build window.
