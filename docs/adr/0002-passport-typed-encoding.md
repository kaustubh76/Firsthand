# ADR-0002 — Passports are EIP-712 typed structs, not JSON

**Status:** accepted · **Date:** 2026-09-13

## Context

README §7.1 defines `P = { h, origin, attest, terms, sig }` and requires the chain to verify the
origin signature and Merkle membership in one call. Solidity and TypeScript must hash identically.

## Decision

- `Passport`, `Terms`, `Attestation` are EIP-712 structs with normative type strings
  (`packages/core/src/passport/typed.ts`, `contracts/src/libraries/PassportLib.sol`).
- `passportId = structHash(Passport)`; the Merkle leaf is `keccak256(0x00 ‖ passportId)`.
- The signed digest is `keccak256(0x1901 ‖ domainSeparator ‖ passportId)` with domain
  `{ "FIRSTHAND", "1", chainId, PassportAnchors }` — binding every passport to one deployment.
- `origin` is the secp256k1 **address** of `pk_agent(ns, e)`; verification is `ecrecover`, low-s only.
- RFC 8785 JCS is used *only* to derive `h` for structured data (`contentHash`); contracts never see it.

## Consequences

- Manifests carry the domain so verifiers are explicit about which deployment they check.
- Type strings are pinned by `cast keccak` values in the golden vectors; changing a field is a
  protocol version bump.
