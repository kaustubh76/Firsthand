# @firsthand/test-vectors

Golden vectors that bind the Solidity and TypeScript implementations together.

| | |
|---|---|
| Responsibility | Store `vectors/*.v1.json`, validate their envelope, and expose a typed loader. |
| Holds secrets? | **No.** Key-derivation vectors use fixed test PRF values that are public by construction. |
| Runtime deps | `zod` only. No workspace dependencies — generators live in the package that *defines* each suite. |

## Who writes which suite

| Suite | Generator | Consumed by |
|---|---|---|
| `split-math`, `merkle`, `passport` | `packages/core/scripts/gen-vectors.ts` | `@firsthand/core` tests, `contracts/test/unit/*.t.sol` |
| `keys`, `envelope`, `p256-signatures` | `packages/crypto/scripts/gen-vectors.ts` | `@firsthand/crypto` tests, `contracts/test/unit/P256.t.sol` |

Regenerate everything with `pnpm vectors:gen`; CI runs `pnpm vectors:check` and fails if the
committed files differ from a fresh generation.

## File format

See `src/schema.ts`. Every case has a stable `name`; cases marked `"hand": true` have their
`expected` values derived by an independent route (manual arithmetic, `cast keccak`, RFC test
vectors) so that both implementations cannot be wrong together. Each suite must carry at least
three such cases.
