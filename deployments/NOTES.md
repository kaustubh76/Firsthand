# Monad testnet deployment (chainId 10143)

Deployed **2026-09-16**. Explorer: <https://testnet.monadexplorer.com>.
Addresses are in `deployments/10143.json`; the full transaction list is in
`contracts/broadcast/Deploy.s.sol/10143/run-latest.json`.

## Addresses

| Contract | Address |
|---|---|
| `PrincipalRegistry` | `0x71912cBa992909B883Ab8D4C86d0a6805e8457B7` |
| `PassportAnchorsBaseline` (bound as `PassportAnchors`) | `0x86c955BA48DD65f2FAbc20525D707bE157FC928B` |
| `PassportAnchorsPaged` (H1 arm) | `0x8Ff1e510636744CC7226f9E77E1DE9E3516feB1C` |
| `GrantManager` | `0xD6684e07F4A18390B4A48dcbC357E5108A1fd521` |
| `Rescissions` | `0x7F4F2Df90605bFCaF6BE09B31A324E5fa9eD89E5` |
| `ReceiptLedger` | `0x353FCb60862a95458F54603d7b84433906736E42` |
| `RoyaltyRouter` | `0x6f35aF16B75586057e941874E36E463c6B6299a6` |
| `FirsthandLens` | `0x06B2Ae48a954e3fbEB00cA165b53a83Ce127c960` |
| `MockUSDC` (faucet double — **not** real USDC) | `0xD27582210629348ED8eaCfd5796ee4Ecdb4ED4f5` |

Parameters: `genesis = 1789257600` (Mon 2026-09-14 00:00 UTC), `epochLength = 604800` (7 d),
`revealWindowBlocks = 1512000` (~1 epoch at 0.4 s), `anchorsLayout = "baseline"`.
First deploy tx: `0x41985bd7d388d1f700d3453f6064c533c01d06b3eb877b8b9d9cc7b1c2ae026e` (PrincipalRegistry).

## External registries used (not deployed by us)

| Registry | Address (Monad testnet, CREATE2 — same on every testnet) |
|---|---|
| ERC-8004 IdentityRegistry (v2.0.0) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Buyer agents register there with their FIRSTHAND card bound in metadata (`firsthand.card`); the
gateway's relayer gives `firsthand/paid-query` feedback per settled query. Verified 2026-09-20:
agent #1903 registered by the browser tier, one paid query credited (`getSummary` count 1, client =
the relayer).

## Accounts

| Role | Address | Funding |
|---|---|---|
| Deployer **and** relayer | `0x5a6472782a098230e04A891a78BeEE1b7d48E90c` | testnet MON (faucet) |
| Buyer | `0xE73b48c4d667aAe87cEf56624F5EDB7ba9A1CcD5` | **none** — it only signs; the relayer submits |
| Hosted relayer (public gateway only) | `0x0DbDFcAa601F7C8EC642C2E475e8C8129aD15A8C` | small float (~1 MON); refill from the faucet |

The hosted relayer is deliberately a separate key with a small float: the public relay spends its
gas on request, so a stranger looping on it can only ever drain that float, never the deployer.
Rotate by setting a new `RELAYER_PRIVATE_KEY` on the Vercel project — nothing on chain names it.

The buyer holds no native balance by design: `registerCard` and `acceptTerms` are relayable and the
payment itself is an EIP-3009 signature, so the demand side never needs gas. Its MockUSDC is minted
by the gates.

## Hosted surfaces

| Surface | URL | Source tree |
|---|---|---|
| Capture PWA | <https://firsthand-capture.vercel.app> | `deploy/capture` |
| Gateway | <https://firsthand-gateway.vercel.app> | `deploy/gateway` |

Live since **2026-09-17**; all three verbs since **2026-09-18**. Proven with the browser tier
against the live URLs on Monad testnet: passkey → enroll + attest through the hosted relay → note,
photo and import passports anchored and published → refusal → demo buyer funded from the faucet
double, card, terms → grant (`0xa2870bdd39…86ff097b5d`) → paid query settled on chain
(`0x510b5d9365…f84ffc54c3`, 0.001 USDC to the deposit key) → rescission (`0xd68e2b1c4e…bec5d81471`)
→ the same query refused `FH_GRANT_RESCINDED` → ledger and manifest verified. Sidecars survive
redeploys (Vercel Blob). Redeploy with `pnpm deploy:hosted` (`docs/DEPLOY.md`). One full script
≈ 0.08 MON of relayer gas.

## Caveats a reviewer should know

1. **Deployer == relayer on this deployment.** Convenient for a single faucet key, but it means this
   deployment does *not* demonstrate the sender-unlinkability property of ADR-0009 (authorisation is
   the P-256 signature, never `msg.sender`; a stranger can relay). Use two keys to show that.
2. **`MockUSDC` is a faucet double, not a stablecoin.** `mint` is permissionless and there is no
   issuer. It carries USDC's EIP-712 domain (`"USD Coin"`, version `"2"`) so x402 payloads signed for
   real USDC verify unchanged — which is exactly why it is safe to swap for a real EIP-3009 USDC
   later (`USDC_ADDRESS=… DEPLOY_MOCK_USDC=false`). No canonical Monad-testnet USDC with EIP-3009
   could be confirmed at deploy time.
3. **Contracts are immutable.** No proxies, no admin keys, no upgrade path — re-deploy to change
   anything. Re-running a gate is always safe: every run enrols a fresh principal, so
   `AlreadyEnrolled` / `AlreadyAttested` / `DuplicateRoot` / `GrantExists` cannot be hit.
4. **Sources are not verified on the explorer.** `foundry.toml` sets `bytecode_hash = "none"` and
   `cbor_metadata = false`, so verification needs an explicit verifier config; not done yet.

## Cost of the whole run

Deploy 10,677,551 gas ≈ **1.10 MON**. Deploy + all four phase gates + S1 (both layouts, 2560
passports) + S2 (25 paid queries) + S4 (200 injections): **8.80 → 5.62 MON, so ≈ 3.18 MON total.**

## Reproducing

```sh
set -a; source .env; set +a            # DEPLOYER_/RELAYER_/BUYER_PRIVATE_KEY, MONAD_RPC_URL
export ANVIL_RPC_URL="$MONAD_RPC_URL" DEPLOYMENTS_FILE="$PWD/deployments/10143.json"
pnpm test:anvil                                                     # Phase 1-4 gates on testnet
pnpm --filter @firsthand/experiments s1 -- --arm anchors-baseline --n 2560
pnpm --filter @firsthand/experiments s1 -- --arm anchors-paged --n 2560
```

Every gate asserts `eth_chainId` matches this file, so a stale local node cannot masquerade as testnet.
