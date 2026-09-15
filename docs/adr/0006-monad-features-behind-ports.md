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
| x402 | `X402Facilitator` | `MonadFacilitatorClient` | — | `MemoryFacilitator` |
| ERC-8004 | `Erc8004Registry` | `OnchainErc8004Registry` (shell) | ECIES over card key if no X25519 field | `MemoryErc8004Registry` |
| Envio | `ConsentLedger` | `EnvioConsentLedger` (shell) | — | `MemoryConsentLedger` |

- `BtxTransport.send` fails with `FH_BTX_UNAVAILABLE` until the node knows the method (probe-gated;
  BTX is not on Monad testnet as of 2026-09, ADR-0012) — callers must choose commit-reveal
  explicitly; nothing degrades silently to the public mempool.
- On-chain, BTX is a transport property, not a contract API: `GrantManager.rescind` is the same call
  on both arms; `Rescissions` is a pure commit store anyone may post to (relayable, unlinkable sender).
