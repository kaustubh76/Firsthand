# ADR-0014 — x402 v2 on the wire; Monad's facilitator verifies, the RoyaltyRouter settles

**Status:** accepted · **Date:** 2026-09-23 (Phase 6)

## Context

README §8 claim 4 is one of the four reasons the project says it needs Monad: *"Native x402
facilitator + ERC-8004 → the buyer side exists."* §5 lists x402 as *"the settlement rail for
per-query pricing; Monad runs a native facilitator."* Until now the repo shipped
`MonadFacilitatorClient` — a complete HTTP client that had never been pointed at anything — and ran
`MemoryFacilitator` everywhere. `docs/PROGRESS.md` recorded the reason as *"the blocker is an
endpoint, not code."*

Both halves of that were wrong, and a probe settled it:

- **The endpoint is live.** `GET https://x402-facilitator.molandak.org/supported` (no auth) lists
  `{"network":"eip155:10143","scheme":"exact","x402Version":2}` for Monad testnet and mainnet, plus
  the `upto` scheme, and publishes the address it settles from.
- **Nothing here could have reached it.** Monad's guide states the facilitator *"only supports x402
  version 2 and above"*. FIRSTHAND spoke v1 throughout: `PaymentPayloadSchema` pinned
  `x402Version: 1`, the client posted `{x402Version: 1, …}`, the 402 named `monad-testnet` and
  `maxAmountRequired`, and the header was `X-PAYMENT`. x402 v2 (Dec 2025) renamed all four.

Two further facts, both measured against the live endpoint
(`packages/adapters/test/testnet/x402-facilitator.interop.test.ts`, outside `check:all`):

- **The two published request envelopes disagree, and only one works.** The x402 specification keeps
  v1's `{paymentPayload, paymentRequirements}`; Monad's own guide shows `{payload, resource,
  accepted}`. The specification's envelope comes back `unsupported_scheme`; the guide's is
  understood — it reads the asset and checks the payer's balance on chain.
- **It answers verdicts with failure status codes.** `insufficient_funds` arrives as HTTP 400, and a
  forged signature as HTTP 500 with *"execution reverted"* — the facilitator verifies by simulating
  `transferWithAuthorization`. A client that treats a status code as an outage retries three times
  to reach the same "no".

And one thing this work exposed at home: **`MemoryFacilitator` never checked a signature.** Its own
docstring said so — *"that is the real facilitator's job"* — which meant the gate in front of every
paid query was decorative, relying on `RoyaltyRouter.settle` to revert later. Safe for money, wrong
as a gate.

## Decision

1. **v2 is a wire projection, not a rewrite.** The canonical in-memory `PaymentRequirements` stays
   v1-shaped; `x402/wire.ts` projects it to v2 (`amount`, CAIP-2 `network`, the `resource` object)
   and back. Nothing that reads `maxAmountRequired` moved. CAIP-2 helpers live in `@firsthand/core`
   (`caip.ts`) because the gateway, the SDK buyer and the browser all need them and none may depend
   on another (ADR-0001). `X402_NETWORK` accepts either spelling.
2. **Serve both versions.** The 402 body carries the price twice — v1's spelling and v2's — plus the
   v2 `PAYMENT-REQUIRED` header, and a payment is read from `PAYMENT-SIGNATURE` or `X-PAYMENT`. A
   standard x402 v2 agent can pay FIRSTHAND; every buyer built against v1 keeps working. The SDK
   picks the entry it can pay rather than trusting the order.
3. **The facilitator verifies; the RoyaltyRouter settles.** `facilitator.settle()` would call
   `transferWithAuthorization` directly: the USDC would move and there would be **no receipt, no
   royalty split and no per-grant rate-limit counter**. Receipts are the product (§1, §7.3, §11), so
   settlement stays `RoyaltyRouter.settle` and `/.well-known/firsthand.json` says which half is
   which instead of leaving a reader to assume. `LocalFacilitator.settle()` returns
   `settlement_not_supported` with that reason rather than pretending.
4. **A real local verifier, as the fallback ADR-0006 lacked.** `LocalFacilitator` checks the EIP-3009
   signature against the asset's own EIP-712 domain, the validity window, `to`/`value`, replay via
   `authorizationState(from, nonce)` and the payer's balance. `FallbackFacilitator` consults it when
   the facilitator is unreachable or declines the *kind* of payment (`unsupported_asset`,
   `unsupported_network`, …) — **never** on a verdict about the payment itself. Falling back on
   `invalid signature` would be a bypass wearing resilience's clothes; the capability list is
   configurable (`X402_FALLBACK_REASONS`) precisely so that distinction stays explicit.
5. **Offer the verifier.** `GET /x402/supported` and `POST /x402/verify` are free and read-only, so
   another Monad team can use FIRSTHAND as an x402 `exact` verifier. There is deliberately **no**
   `/settle`: settling means spending this gateway's relayer gas, and a stranger's payment is not
   ours to pay for.
6. **Pin the envelope to the measured one.** `MONAD_FACILITATOR_ENVELOPE = "monad-doc"`, with
   `"spec"` available for a facilitator that follows the written specification and `null` to
   discover it. The interop test asks both every run, so the day Monad's facilitator changes its
   mind, a test says so rather than a judge's paid query.

## Consequences

- **The claim is now measured.** The facilitator returned `{"isValid": true, "payer": "0xf288…"}` for
  a payment built by FIRSTHAND, for FIRSTHAND's own MockUSDC, under FIRSTHAND's EIP-712 domain
  (2026-09-23; raw run in `experiments/results/x402-facilitator.json`). The hosted gateway runs
  `X402_MODE=monad`.
- **A third party is on the serving path, bounded.** Every paid query now costs one round trip to
  the facilitator (~0.5 s). If it is slow, the query is slow; if it is down, the local verifier
  answers and `/healthz` and discovery report `verification.lastVerifiedBy: "local"`. It can never
  cause an *unverified* payment to be served — that is the one thing the fallback will not do.
- **MockUSDC was the risk and it did not bite.** The faucet double uses USDC's exact EIP-712 domain
  ("USD Coin", version "2") on purpose, and the facilitator verified against it without an
  allow-list. Had it refused, the fallback and the discovery field were already the answer.
- Monad's facilitator would also *settle*, paying the gas itself. Taking that offer would mean
  giving up the receipt ledger, so it stays unused — noted here so the omission reads as a choice.
