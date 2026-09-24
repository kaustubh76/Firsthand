# firsthand-demo

The whole protocol in one terminal run — ten steps, no keys, no faucet, no accounts.

```sh
pnpm demo                 # local: spawns anvil, deploys, runs the loop with published test keys
pnpm demo -- --testnet    # Monad testnet: needs a funded RELAYER_PRIVATE_KEY (see .env.example)
```

```
1.  Open a locker                 every key derives from one PRF output
2.  Enroll + attest on chain      relayable: the signature authorises it, not the sender
3.  Deposit a datum               sealed client-side, anchored in a Merkle batch
4.  An agent accepts the terms    the buyer signs; the relayer pays the gas
5.  The human grants              the vault key is sealed to the buyer's card
6.  The agent pays per query      x402 → EIP-3009 → receipt on chain
7.  Export the Lineage Manifest   the compliance file: origin, licence, payment
8.  The human withdraws consent
9.  The same query is now refused FH_GRANT_RESCINDED (HTTP 403) — no data, no charge
10. The Consent Ledger            enrolled · attested · granted · rescinded, with block numbers
```

**Step 9 is the point.** Nothing happened between 6 and 9 except one transaction: the gateway
re-runs the same `verify()` predicate on every request, and the grant is no longer live. The refusal
is not a policy the gateway chose — it is the predicate's answer.

## What it actually spins up

`src/env.ts` prepares the world so the loop can be about the protocol rather than about setup:

- **A chain.** Reuses anvil if one is already listening, otherwise starts one and stops it on exit.
  Enrolment verifies a P-256 signature through the RIP-7212 precompile; older Foundry hides that
  behind `--odyssey` and newer builds ship it by default, so the flag is *detected*, never assumed.
- **The contracts.** Runs `Deploy.s.sol` when `deployments/31337.json` is missing or names addresses
  this chain has no code at — a document left over from a previous anvil is not trusted.
- **A gateway**, in-process, configured for the chain it found: `X402_MODE=monad` on testnet (Monad's
  native facilitator), `local` on anvil (the gateway verifies EIP-3009 itself, since no facilitator
  serves chain 31337).

## Testnet

The buyer key needs **no** balance — it only ever signs, and the relayer submits and pays, which is
the same relay path the hosted gateway exposes. Transaction hashes print as explorer links.
Addresses, floats and measured gas: [`deployments/NOTES.md`](../../deployments/NOTES.md).
