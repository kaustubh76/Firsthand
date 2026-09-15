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
| Settlement relayer key (`RELAYER_PRIVATE_KEY`) | `apps/gateway` (`OnchainSettlement`) | pays gas for `RoyaltyRouter.settle` only; it is not a user key, holds no user funds, cannot sign passports, grants or rescissions, and the buyer's EIP-3009 authorization names the router, not the relayer |

Limits: JavaScript cannot guarantee zeroization (engine copies, GC). `zeroize` is best effort;
WebAuthn PRF output is the only long-lived root and it is evaluated on demand, never stored.

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
| Synthetic laundering through a real passkey | `AttestationClass` + `sourceTag` in every passport; buyers filter; not prevented — see §6 |
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
   or one-human-one-passkey. Commodity capture attestation is heuristic; hardware attestation is roadmap.
4. No injection/poisoning screening ships in core.
5. BTX advantage holds only where BTX is live; the commit-reveal fallback narrows but does not
   eliminate the race — measured, not asserted.

## 7. Rescission semantics

- Direct path (`GrantManager.rescind`): effective at inclusion. Over BTX the payload would be
  unreadable before inclusion. **BTX is not deployed on Monad testnet as of 2026-09**; the
  transport ships probe-gated and refuses rather than degrading to the public mempool
  (ADR-0006/0012). Commit-reveal is the un-front-runnable path available today.
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

## 8. Reporting

Email the maintainer with steps to reproduce. Expect an acknowledgement within 72 hours during the
build window.
