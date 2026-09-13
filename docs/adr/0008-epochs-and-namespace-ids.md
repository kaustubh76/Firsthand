# ADR-0008 — Epochs and namespace identifiers

**Status:** accepted · **Date:** 2026-09-13

## Decision

- `epoch(t) = (t − genesis) / 604800`; `genesis` is an immutable constructor parameter aligned to a
  Monday 00:00 UTC (`Deploy.s.sol` default). Mirrored exactly by `EpochLib.sol` and `core/epoch`.
- Liveness grace 2 epochs; max grant term 8 epochs; both immutable per deployment (README §7.5).
- `ns` is a `uint32` index `0..15` per principal (max 16 namespaces); human labels stay off-chain in
  the locker. Global identity of a namespace is `(principalId, ns)`.
- Rate-limit counters live in `ReceiptLedger` keyed by `(grantId, epoch)`; `GrantState` drops
  `queriesThisEpoch` (resolves README §9 vs §11).
- Receipt id = `keccak256(abi.encode(grantId, queryNonce))` with `queryNonce` = the EIP-3009
  authorization nonce, so payment dedup and receipt dedup coincide.
