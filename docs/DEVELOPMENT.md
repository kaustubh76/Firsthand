# Development

## Toolchain

- Node 26 (`.nvmrc`), pnpm 10 (`packageManager`), Foundry ≥ 1.1 (`forge`, `cast`, `anvil`).
- One-time: `pnpm install` and `cd contracts && forge install` (submodules are already declared).

## Everyday commands

| Command | What |
|---|---|
| `pnpm build` | Turbo build of every package (contracts: `forge build` + ABI export + tsup) |
| `pnpm test` | vitest across packages + `forge test` |
| `pnpm typecheck` / `pnpm lint` | tsc project-by-project / Biome |
| `pnpm coverage` | per-package coverage; core/crypto ≥ 95 %, contract libraries ≥ 95 % |
| `pnpm vectors:gen` / `pnpm vectors:check` | regenerate / verify golden vectors |
| `pnpm check:deps` | assert the dependency graph (ADR-0001) |
| `pnpm check:all` | lint, dependency rules, `.env.example` drift, build, typecheck, coverage, golden vectors, and the Solidity gate when Foundry is installed (skipped with a printed reason otherwise). Everything here also runs in CI, but **CI is stricter**: it adds `forge build --sizes`, runs `forge test` under `FOUNDRY_PROFILE=ci` (10 000 fuzz runs, not 256), gates `src/libraries/` coverage at 95 %, does a deploy dry-run, and runs the anvil round-trips and the experiments' on-chain arms. Passing this locally is necessary, not sufficient — see `.github/workflows/ci.yml` |
| `pnpm --filter @firsthand/experiments s1 -- --n 10000` | run a scenario; `report` renders results |

## Start here

New to the repo? [`QUICKSTART.md`](../QUICKSTART.md) — `pnpm demo` runs a complete first recall
(deposit → paid query → rescission → refusal) on a local chain in about 15 seconds, no keys needed.
`pnpm demo -- --testnet` does the same against the live Monad deployment.

## Reading the system

`docs/diagrams/firsthand-product.excalidraw` is the one-canvas map of the whole product — every
component in the README's design with its build status as a badge, and the three verbs drawn as
colour-coded flows. Open it at excalidraw.com before touching a lane you have not worked in.

## Test tiers

- `test:unit` — pure, offline, memory adapters. Runs everywhere.
- `test:anvil` — the SDK and the gateway against a live local chain (`anvil --odyssey`, which ships
  the RIP-7212 P-256 precompile). Needs `ANVIL_RPC_URL`, `DEPLOYMENTS_FILE`, `RELAYER_PRIVATE_KEY`;
  skipped otherwise. Runs serialised (`turbo --concurrency=1`, `fileParallelism: false`) because
  every file shares the relayer's nonce. Kill stale nodes with `pkill -f anvil` before restarting —
  a leftover node keeps the old deployment and the round-trips fail on `EpochNotAttested`.
- `test:testnet` — needs `MONAD_RPC_URL` (and `DEPLOYER_PRIVATE_KEY` for scripts). Skipped otherwise.
- Foundry: `forge test` (default profile), `FOUNDRY_PROFILE=ci forge test` (10k fuzz runs).
- `pnpm --filter firsthand-capture e2e` — **the browser tier.** Everything above runs in Node; a
  blank page, a wrong asset path or a browser-only API difference passes all of it. This serves the
  committed `deploy/capture` tree in headless Chromium (Playwright, browsers already cached in
  `~/Library/Caches/ms-playwright`; otherwise `pnpm exec playwright install chromium`), drives it with
  a virtual passkey that speaks PRF, and runs enrol → activate → capture → anchor → publish against
  a spawned anvil + gateway. `E2E_TESTNET=1` uses Monad testnet with the `.env` keys;
  `E2E_GATEWAY_URL=` / `E2E_APP_URL=` test the hosted surfaces. It found the `this.#fetch` "Illegal
  invocation" bug that made the relay unreachable from every browser — run it after touching
  anything the PWA imports.

### Phase 1 gate locally (enroll → attest round-trip)

```sh
anvil --odyssey --silent &
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0
export USDC_ADDRESS=0x0000000000000000000000000000000000000dc0
(cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast)
ANVIL_RPC_URL=http://127.0.0.1:8545 DEPLOYMENTS_FILE=$PWD/deployments/31337.json \
RELAYER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
pnpm test:anvil
```

### Phase 2 gate locally (deposit → anchor → on-chain inclusion) and H1 arms

With anvil, the deployment and the env from the recipe above:

```sh
pnpm test:anvil                                                     # both gates, both layouts
pnpm --filter @firsthand/experiments s1 -- --arm anchors-baseline --n 2560
pnpm --filter @firsthand/experiments s1 -- --arm anchors-paged --n 2560
pnpm --filter @firsthand/experiments s4 -- --arm anchors-baseline --n 200
pnpm --filter @firsthand/experiments report
```

### Phase 3 gate locally (grant → paid queries → receipts → rescission) and S2

`pnpm test:anvil` also runs `apps/gateway/test/anvil/buyer.roundtrip.test.ts`: the real gateway app
in `SETTLEMENT_MODE=onchain` against anvil's `MockUSDC` (deployed by default on 31337) — a buyer
registers a card, accepts terms, the principal grants and publishes the wrap, three paid queries
settle through `RoyaltyRouter.settle` (receipts on chain, plaintext opened client-side), the fourth
hits the rate limit (429), and after rescission the next query is refused (403) with no settlement.
S2 measures the same loop without HTTP:

```sh
pnpm --filter @firsthand/experiments s2 -- --n 100                          # memory arm
pnpm --filter @firsthand/experiments s2 -- --arm anchors-baseline --n 100   # settle gas per query
```

### Phase 4 gate locally (rescission paths, race harness)

`pnpm test:anvil` also runs `packages/sdk/test/anvil/rescind.roundtrip.test.ts`: a `btx` plan
through `BtxTransport` (method overridden to `eth_sendRawTransaction` so the plain node accepts the
sealed bytes), the default method refused by the probe, a mismatched plan refused before sending,
and commit-reveal with the commit block as effective end. S3 then races a real observer bot:

```sh
pnpm --filter @firsthand/experiments s3 -- --arm B2-public-mempool --n 50
pnpm --filter @firsthand/experiments s3 -- --arm commit-reveal --n 50
pnpm --filter @firsthand/experiments s3 -- --arm btx-blind --n 50        # no-signal bound, not BTX
BTX_RPC_URL=… pnpm --filter @firsthand/experiments s3 -- --arm btx        # skipped without an endpoint
```

S3 turns automine off on the shared anvil and mines every 400 ms for the race window, restoring
automine afterwards (and asserting it did); do not run it concurrently with the anvil test tier.
`LOG_LEVEL=debug` prints one line per trial.

To drive the gateway by hand: `DEPLOYMENTS_FILE=$PWD/deployments/31337.json SETTLEMENT_MODE=onchain
RELAYER_PRIVATE_KEY=… pnpm --filter firsthand-gateway dev`, then `firsthand_query` from the MCP
server with `BUYER_PRIVATE_KEY` / `GRANTEE_SEED_HEX` set (`apps/mcp/.env.example`).

### Monad testnet runbook (README §16 Phase 1 gate on the real precompile)

1. Fund a deployer and a relayer with testnet MON; put `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY`,
   `USDC_ADDRESS` (testnet USDC with EIP-3009) in `.env` — never in chat or commits.
2. Deploy: `set -a; source .env; set +a` then
   `(cd contracts && forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast)`.
   Writes `deployments/10143.json` — commit it, along with `contracts/broadcast/**/10143/`.
   Do **not** use the `deploy:testnet` script as-is: it appends `--verify` and no verifier is
   configured in `foundry.toml` (which also sets `bytecode_hash = "none"`).
3. `pnpm --filter @firsthand/contracts test:testnet` — fork test enrolls a throw-away key through the
   native precompile.
4. `ANVIL_RPC_URL=$MONAD_RPC_URL DEPLOYMENTS_FILE=$PWD/deployments/10143.json RELAYER_PRIVATE_KEY=… pnpm test:anvil`
   — the same SDK round-trips, now on testnet. Record the tx hashes in `deployments/NOTES.md`.
5. Same env, run the H1 arms: `… s1 -- --arm anchors-baseline --n 2560` and `--arm anchors-paged`;
   commit `experiments/results/s1.json`. This is the only place MIP-8's page pricing can show.

## Golden vectors

`packages/test-vectors/vectors/*.v1.json` are generated by `packages/core/scripts/gen-vectors.ts`
and `packages/crypto/scripts/gen-vectors.ts` and consumed by vitest **and** forge. Every suite has
hand-derived cases (from `cast` / OpenSSL). If you change an encoding: update the implementation,
run `pnpm vectors:gen`, review the diff, and update the hand constants only with a new independent
derivation.

## Adding a package

1. Copy the `package.json` shape from a sibling (exports map, scripts, `catalog:` versions).
2. Extend `tooling/tsconfig.lib.json` / `tsconfig.app.json`; use `makeTsupConfig` / `makeVitestConfig`.
3. Add its allowed dependencies to `scripts/check-deps.mjs`.
4. Write its README with the "holds secrets?" line.

## Local chain

```sh
anvil &                                   # 31337
export DEPLOYER_PRIVATE_KEY=0xac09…ff80    # anvil account 0
export USDC_ADDRESS=0x0000000000000000000000000000000000000dc0
pnpm --filter @firsthand/contracts deploy:anvil
```
