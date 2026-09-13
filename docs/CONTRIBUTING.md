# Contributing

Solo project by design (README §18); these rules replace peer review.

## Doctrine (README footer)

claim only what ships · cite the field · cut before quality · make the honest sentence the
impressive one · freeze the mechanism before the first commit.

## Phase gate checklist (self-review, every phase)

- [ ] `pnpm check:all` green; `FOUNDRY_PROFILE=ci forge test` green.
- [ ] Coverage on math libraries ≥ 95 % (TS core/crypto, Solidity `src/libraries`).
- [ ] Invariant/fuzz suites for `SplitMath` and `MerkleLib` unchanged or strengthened.
- [ ] Golden vectors regenerated and reviewed; hand cases untouched or re-derived independently.
- [ ] Any new dependency edge added to `scripts/check-deps.mjs` deliberately.
- [ ] No new `expose(` call sites in `@firsthand/crypto` consumers without a comment.
- [ ] ADR written for any decision that changes an encoding, a port, or a protocol parameter.
- [ ] SECURITY.md updated if the threat model or limitations moved.
- [ ] Experiment results (if any) committed as raw JSON under `experiments/results`.

## Style

Biome is the formatter and linter for TS/JSON; `forge fmt` for Solidity. No `any`, no non-null
assertions outside tests, `import type` for types, explicit error classes with codes.

## ADR process

Number sequentially in `docs/adr/`, state Context / Decision / Consequences, link the README section
that motivated it. Superseding an ADR: add a new one and mark the old `superseded by`.
