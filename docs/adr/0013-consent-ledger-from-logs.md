# ADR-0013 — The Consent Ledger reads logs first, Envio second

**Status:** accepted · **Date:** 2026-09-16 (Phase 5)

## Context

README §19's demo turns on one screen: *"the Consent Ledger shows the timestamped end of consent."*
§22 lists "Envio Consent Ledger" as MVP. The `ConsentLedger` port has existed since Phase 0 with a
memory double and an `EnvioConsentLedger` shell whose three methods throw `NotImplementedError`.

Two things were true when Phase 5 started. First, **nothing consumed the port on any user-facing
path** — no gateway route, no SDK call, no UI; it was written to by `MemorySettlement` and read by
tests. A port with no consumer is a guess about an interface, not a contract. Second, the Envio path
costs more than it looks: `packages/indexer` is four files with an empty handler module, the `envio`
package is not installed, the handler API is documented nowhere in this repo, and running it means
Postgres + Hasura under Docker plus somewhere to host the GraphQL endpoint for judges.

ADR-0006 also records something awkward: of the Monad-specific features behind ports, Envio is the
only one with **no fallback**. BTX degrades to commit-reveal, MIP-8 degrades to the baseline layout.
If the indexer is down or unbuilt, the audit surface simply does not exist.

## Decision

1. **Implement the port from contract logs.** `LogsConsentLedger` (`packages/adapters/src/ledger/`)
   answers all three methods with viem `getLogs` against the deployment, using event signatures
   parsed from the interfaces in `contracts/src/interfaces/`. It needs an RPC and nothing else, so
   the audit surface is live the moment the contracts are deployed. This is also the fallback
   ADR-0006 noted was missing.
2. **Make the port load-bearing.** The gateway exposes `GET /v1/grants/:grantId/receipts`,
   `/v1/principals/:principalId/anchors` and `/v1/principals/:principalId/timeline`, backed by the
   logs ledger in chain mode and the memory double otherwise. The interface is now exercised by a
   real consumer, which is what makes swapping in Envio later a safe change rather than a rewrite.
3. **A rescission is timestamped by its *effective* block, not its log.** `GrantRescinded` carries
   `effectiveBlock`, which on the commit-reveal path is the **commit** block — earlier than the
   reveal that emitted the event. The timeline reports the effective block, because that is when
   consent ended; reporting the log's own block would overstate how long access lasted, in the
   protocol's own favour.
4. **FROZEN and EXPIRED stay derived.** They are not events and no contract emits them; they follow
   from liveness and the grant's term, exactly as `effectiveStatus` computes them on chain. The
   ledger does not invent log entries for them.
5. **Envio remains the scale-up path**, unimplemented and honest about it. Logs are O(range) per
   query against an RPC; an indexed read model is the right answer at scale and for rich queries.
   When it lands it implements the same port, and the conformance expectations are already written
   down by the memory double's semantics.

## Consequences

- The demo's evidence scene works on testnet today with no extra infrastructure.
- `packages/indexer` stays a spec (config + schema) with `envio` uninstalled; `docs/spec/README.md`
  now lists two live implementations for the port instead of one shell.
- Log scanning needs a sane `fromBlock` — `LEDGER_FROM_BLOCK` on the gateway; scanning from genesis
  on a chain at block 63M is pointless. Getting it wrong is slow, not wrong.
