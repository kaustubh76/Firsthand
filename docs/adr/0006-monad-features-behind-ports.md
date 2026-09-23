# ADR-0006 — Monad-specific and unconfirmed features live behind ports

**Status:** accepted · **Date:** 2026-09-13

## Context

README §8 rests on BTX (encrypted mempool), MIP-8 storage pages, the native P-256 precompile, the
x402 facilitator and ERC-8004. Two of these are unconfirmed for testnet at Phase 0 (README §16).

## Decision

Every such feature is a port in `@firsthand/adapters` with a real adapter, a fallback, and an
in-memory double; experiment arms (README §15) are adapter selections, never code forks.

| Feature | Port | Real | Fallback | Double |
|---|---|---|---|---|
| BTX | `TxTransport` | `BtxTransport` (typed shell, `probe()`) | `PublicMempoolTransport` + commit-reveal | `MemoryTransport` |
| MIP-8 anchors | `AnchorWriter` | `OnchainAnchorWriter(layout: paged)` | `layout: baseline` | `MemoryAnchorWriter` |
| P-256 precompile | `P256.sol` | RIP-7212 at `0x100` | — (etched daimo verifier in tests) | `P256Double` |
| x402 | `X402Facilitator` | `MonadFacilitatorClient` (live: Monad's facilitator, x402 v2) | `LocalFacilitator` (real EIP-3009 verification, no third party) | `MemoryFacilitator` |
| ERC-8004 | `Erc8004Registry` / `Erc8004Writer` | `OnchainErc8004Registry` — **live against the reference registries on Monad testnet (2026-09-20)**: agent view, card binding, registration, paid-query feedback | the card carries the X25519 key (decision #12 resolved: agents bind a card in metadata; no ECIES fallback needed) | `MemoryErc8004Registry` |
| Envio | `ConsentLedger` | `EnvioConsentLedger` (shell) | `LogsConsentLedger` (ADR-0013) | `MemoryConsentLedger` |

- `BtxTransport.send` fails with `FH_BTX_UNAVAILABLE` until the node knows the method (probe-gated;
  BTX is not on Monad testnet as of 2026-09, ADR-0012) — callers must choose commit-reveal
  explicitly; nothing degrades silently to the public mempool.
- On-chain, BTX is a transport property, not a contract API: `GrantManager.rescind` is the same call
  on both arms; `Rescissions` is a pure commit store anyone may post to (relayable, unlinkable sender).
