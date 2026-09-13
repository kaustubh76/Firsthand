# ADR-0004 — Fixed-depth (8), ordered, index-addressed batch Merkle trees

**Status:** accepted · **Date:** 2026-09-13

## Decision

- Batch size 256, depth 8; partial batches are padded with zero subtrees, so **every proof is exactly
  8 siblings** (H3: ≤ 8 hashes per asset; gas-predictable on-chain).
- Domain separation: `hashLeaf(id) = keccak256(0x00 ‖ id)`, `hashNode(l, r) = keccak256(0x01 ‖ l ‖ r)`.
- Ordered pairs (not sorted): the leaf index picks the side at each level, so a proof also proves the
  asset's position `(batch, index)` — what a Lineage Manifest cites.
- Padding value `Z0 = bytes32(0)` is not `keccak256(0x00 ‖ x)` for any known `x`, so padding slots can
  never be proved as passports (fuzz-tested on both sides).
- `ZERO_HASHES[0..8]` are hardcoded in `MerkleLib.sol` and cross-checked against `cast keccak`.

## Consequences

- Multiproofs are out of scope; a 10k-asset manifest is ≈ 12 MB of JSON (measured, S1).
