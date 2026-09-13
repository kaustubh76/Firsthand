# ADR-0003 — Royalty split: floor is normative, banker's rounding is off-chain only

**Status:** accepted (user decision) · **Date:** 2026-09-13

## Context

README §7.3 states both `pay_i = floor(p·w_i / 1e18)` with the residual going to a dust pool, and
"banker's rounding on the final conversion". Both cannot apply to the same operation.

## Decision

- On-chain and in `@firsthand/core/split`: **floor per recipient**, `residual = price − Σ pay_i`
  goes to the protocol dust pool. Invariants: `Σ pay + residual == price`, `residual ≤ n − 1`.
- Banker's rounding (round-half-to-even) exists only in `quoteToUnits(decimalQuote, decimals)`, the
  off-chain conversion of a human-readable USDC quote into 6-decimal base units, *before* the split.
- Bounds: 1–16 recipients, weights sum to exactly `1e18`, `price ≤ 2^96 − 1`.

## Consequences

- The residual is provable and visible; the dust pool sweep (README §7.5) is permissionless.
- Zero weights and a zero price are allowed by the library; `GrantManager` enforces the price floor.
