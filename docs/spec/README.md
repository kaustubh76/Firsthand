# FIRSTHAND — normative specification (v0.1)

The mechanism is frozen in the repository README (§7 core mechanism, §9 contracts, §11 state,
§12 security properties). This document adds the byte-level appendices the code implements.
Where the README and this file disagree, this file wins for encodings and the README for intent.

## A. Encodings

- **Passport / Terms / Attestation / authority structs:** EIP-712 type strings in
  `packages/core/src/passport/typed.ts` and `packages/core/src/authority/digests.ts`; Solidity twins
  in `contracts/src/libraries/PassportLib.sol` and `AuthorityDigests.sol`. Domain
  `{ "FIRSTHAND", "1", chainId, PassportAnchors }`. (ADR-0002)
- **Content hash:** `keccak256(bytes)` for raw data; `keccak256(utf8(JCS(value)))` (RFC 8785) for JSON.
- **Nonce:** `HMAC-SHA256(k_nonce(ns,e), h)`. (ADR-0005)
- **Merkle:** depth 8, batch 256, `0x00`/`0x01` prefixes, ordered pairs, zero-subtree padding. (ADR-0004)
- **Signatures:** secp256k1 `r‖s‖v` 65 bytes, low-s, `v ∈ {27,28}`; P-256 `r‖s` 64 bytes, low-s,
  precompile input `hash‖r‖s‖x‖y`.
- **Key tree:** HKDF-SHA256, salt `"FIRSTHAND/kdf/v1"`, NUL-terminated labels, 48-byte scalar
  derivation reduced mod `n−1` plus one. (ADR-0005)
- **Envelope:** `"FH1E"‖0x01‖nonce24‖ct‖tag16`, XChaCha20-Poly1305; wrap = X25519 sealed box, 104 bytes. (ADR-0007)
- **Royalty split:** floor per recipient, residual → dust pool; `1 ≤ n ≤ 16`, `Σw = 1e18`, `price ≤ 2^96−1`. (ADR-0003)
- **Epochs:** `(t − genesis) / 604800`; `ns: uint32 ∈ [0,16)`. (ADR-0008)

## B. Error codes

`FH_VALIDATION FH_CONFIG FH_NOT_IMPLEMENTED FH_REFUSED_ORIGIN FH_REFUSED_DUPLICATE FH_MERKLE_INVALID
FH_SIG_INVALID FH_GRANT_NOT_LIVE FH_GRANT_RESCINDED FH_GRANT_FROZEN FH_GRANT_EXPIRED FH_RATE_LIMITED
FH_PAYMENT_REQUIRED FH_PAYMENT_INVALID FH_NOT_FOUND FH_TRANSPORT FH_BTX_UNAVAILABLE FH_CIRCUIT_OPEN
FH_CHAIN FH_CRYPTO`
— `packages/core/src/errors.ts`; HTTP mapping via `toProblemDetails` (RFC 9457). Solidity custom
errors share names (`RefusedOrigin`, `DuplicateRoot`, `GrantNotLive`, …).

`verify()` reason codes: `SIG_INVALID MERKLE_INVALID ROOT_UNKNOWN TERMS_MISMATCH EPOCH_OUT_OF_GRANT
GRANT_NOT_LIVE GRANT_RESCINDED GRANT_EXPIRED GRANT_FROZEN SCOPE_MISMATCH` — identical in
`packages/core/src/grant/verify.ts` and `contracts/src/types/Structs.sol`, checked in the same
order on and off chain (ADR-0011). `SCOPE_MISMATCH`: the anchored root belongs to a different
`(principal, ns)` than the grant.

## C. Port contracts

See `packages/adapters/src/ports/*.ts` and ADR-0006. Each port has a memory double with call
recording and `failNext()` fault injection; conformance tests live in `packages/adapters/src/adapters.test.ts`
and `demand.test.ts`.

| Port | Supply / demand | Live implementation |
|---|---|---|
| `AnchorWriter` (`anchor`, `isAnchored`, `isIncluded`, `anchorOf`) | supply | `OnchainAnchorWriter` (viem) |
| `TxTransport` | supply | `PublicMempoolTransport`; BTX in Phase 4 |
| `BlobStore` | supply | memory / fs |
| `PassportCatalog` (`put`, `get` public sidecars) | gateway | `FsPassportCatalog` |
| `GrantReader` (`grantState`, `effectiveStatus`, `cardOf`, `termsOf`, `wrapRefOf`, `principalLastAttested`, `currentEpoch`, `chainTime`) | demand | `OnchainGrantReader` |
| `Settlement` (`settle(grantId, terms, payment) → receipt`) | demand | `OnchainSettlement` → `RoyaltyRouter.settle` |
| `PaymentFacilitator` | demand | memory; Monad x402 facilitator in Phase 5 |
| `ConsentLedger` | audit | `EnvioConsentLedger` (Phase 5) |

## D. The verification predicate

```
verify(P, sig, proof, root, G, principal, e_now) =
  SigOK(P, sig, domain)
∧ rootAnchored(root)
∧ MerkleOK(root, hashLeaf(id(P)), proof)
∧ anchorOf(root).(principalId, ns) == (G.principalId, G.ns)   // SCOPE_MISMATCH
∧ P.termsHash == G.termsHash
∧ status(G, principal, e_now) == ACTIVE        // RESCINDED > EXPIRED > FROZEN > ACTIVE
∧ G.epochStart ≤ P.epoch ≤ e_now               // no future-epoch admission
```
