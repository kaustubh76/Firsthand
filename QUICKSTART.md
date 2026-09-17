# Quickstart — your first recall

FIRSTHAND gives every piece of human-created data a passkey-signed passport of origin, price and
consent. AI buyers pay **per query** over x402, every read leaves an on-chain receipt, and the human
can withdraw consent — after which the same query is refused.

This page gets you from `git clone` to watching that happen. Target: **under 10 minutes.**

> **No install needed — open the live app:** <https://firsthand-capture.vercel.app>
> Create a passkey, *Activate on chain*, stamp a note: it is anchored on Monad testnet through the
> hosted gateway <https://firsthand-gateway.vercel.app> (discovery at
> [`/.well-known/firsthand.json`](https://firsthand-gateway.vercel.app/.well-known/firsthand.json)).
> The browser holds no key and pays no gas. Needs a passkey-capable browser (Chrome, Safari,
> Android/iOS) — the PRF extension is what derives every key.

## Prerequisites

| | Why | Check |
|---|---|---|
| **Node 26+** | the repo sets `engine-strict`, so older Node makes `pnpm install` **abort**, not warn | `node -v` |
| **pnpm 10+** | workspace + catalog | `pnpm -v` |
| **Foundry** | the demo deploys contracts to a local chain | `forge --version` |

Node: `nvm install 26 && nvm use 26` (the repo pins it in `.nvmrc`).
Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

## Run it

```sh
git clone --recurse-submodules https://github.com/kaustubh76/Firsthand.git
cd Firsthand
pnpm install
pnpm build
pnpm demo
```

`--recurse-submodules` matters: `contracts/lib/` is empty without it and the contracts will not
build. If you already cloned, run `git submodule update --init --recursive`.

**No keys, no faucet, no accounts.** `pnpm demo` spawns a local chain, deploys the ten contracts,
and runs the whole loop with anvil's published test keys.

## What you should see

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

The interesting line is **9**. Nothing special happened between 6 and 9 except a transaction: the
gateway re-runs the same `verify()` predicate on every request, and the grant is no longer live.

## Against the real deployment

The contracts are live on Monad testnet (chain 10143 — addresses and costs in
[`deployments/NOTES.md`](deployments/NOTES.md)). To run the demo there you need a funded relayer:

```sh
cp .env.example .env          # then fill in RELAYER_PRIVATE_KEY and BUYER_PRIVATE_KEY
pnpm demo -- --testnet
```

Get testnet MON from the Monad faucet. The buyer key needs **no** balance — it only ever signs;
the relayer submits and pays. Transaction hashes print as explorer links.

## Where to go next

| You want to… | Go to |
|---|---|
| understand the mechanism | [`Readme.md`](Readme.md) — the frozen spec |
| see the whole system at once | [`docs/diagrams/firsthand-product.excalidraw`](docs/diagrams/firsthand-product.excalidraw) |
| read the measurements | [`experiments/README.md`](experiments/README.md) — including the two hypotheses that failed |
| run it as a service | [`apps/gateway/README.md`](apps/gateway/README.md) |
| drive it from an agent | [`apps/mcp/README.md`](apps/mcp/README.md) — seven MCP tools |
| know what is not built | [`docs/PROGRESS.md`](docs/PROGRESS.md) |

## If something breaks

- **`pnpm install` aborts with an engine error** — you are not on Node 26. `nvm use 26`.
- **`forge: command not found`** — install Foundry (above), then reopen your shell.
- **`anvil did not start`** — something else may be on port 8545: `pkill anvil` and retry.
- **contracts fail to build** — submodules: `git submodule update --init --recursive`.
- **the capture app shows "offline · …"** — the status strip says why (gateway unreachable, relay
  off, memory mode). Open it with `?gateway=http://127.0.0.1:8402` to point at a local gateway
  started with `RELAY_ENABLED=true` and a `DEPLOYMENTS_FILE`.
