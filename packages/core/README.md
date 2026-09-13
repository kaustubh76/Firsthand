# @firsthand/core

Pure protocol math over **public inputs only**. Browser-safe, no I/O, no secrets.

| | |
|---|---|
| Responsibility | SplitMath, Merkle batches, EIP-712 passport/authority hashing, JCS content hashing, signature *verification* (secp256k1 recover, P-256), epoch math, grant state machine, `verifyPredicate`, error model, wire schemas. |
| Holds secrets? | **No.** Signing lives in `@firsthand/crypto`. |
| Runtime deps | `@noble/hashes`, `@noble/curves`, `zod` |
| Solidity twins | `contracts/src/libraries/{SplitMath,MerkleLib,PassportLib,AuthorityDigests,EpochLib,P256}.sol` |

Subpaths: `.`, `./split`, `./merkle`, `./passport`, `./authority`, `./epoch`, `./grant`, `./errors`, `./schemas`.

`scripts/gen-vectors.ts` writes the `split-math`, `merkle` and `passport` golden suites; hand cases
come from `cast keccak` / `cast wallet sign`. Coverage gate: 95 %.
