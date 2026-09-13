# ADR-0001 — Monorepo layout and package boundaries

**Status:** accepted · **Date:** 2026-09-13

## Context

FIRSTHAND ships contracts, an SDK, an MCP server, a gateway, importers, a PWA and an experiment
harness (README §10, §22). Two properties must hold mechanically, not by convention: the serving
path never holds key material (README §4, §12), and every Monad-specific feature is swappable for a
fallback (README §8, §15).

## Decision

- pnpm workspaces + Turborepo + Biome. `packages/*` are libraries, `apps/*` are deployables nothing
  depends on, `contracts/` and `experiments/` are top-level as in README §10.
- **Secrets live in exactly one package.** `@firsthand/crypto` is the only package that touches PRF
  output, derived scalars, vault keys, DEKs or decryption. `@firsthand/core` is public-input math only.
- **`apps/gateway` never depends on `@firsthand/crypto`.** pnpm's isolated `node_modules` makes a
  stray import a build failure; `scripts/check-deps.mjs` asserts the entire allow-listed graph in CI;
  Biome's `noRestrictedImports` is belt-and-braces.
- The allowed runtime dependency graph is data in `scripts/check-deps.mjs` and is the source of truth.

## Consequences

- Adding a dependency edge is a reviewed change to one file.
- `@firsthand/adapters` exposes a browser-safe `./memory` subpath; the root entry is Node-only.
- Turbo forbids workspace cycles, so generators for golden vectors live in the package that defines
  the suite (`core/scripts`, `crypto/scripts`), not in `@firsthand/test-vectors`.
