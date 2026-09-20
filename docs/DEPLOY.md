# Deploying the public surfaces

| Surface | Live URL | Vercel project | Source tree |
| --- | --- | --- | --- |
| Capture PWA | <https://firsthand-capture.vercel.app> | `firsthand-capture` | `deploy/capture` (static) |
| Gateway | <https://firsthand-gateway.vercel.app> | `firsthand-gateway` | `deploy/gateway` (one Node function) |

Both are served from **committed, prebuilt deploy trees**. The builder never builds the monorepo
(that needs Foundry and Node 26, which Vercel's builders lack): the gateway tree is a four-dependency
npm project whose `api/index.js` bundles every `@firsthand/*` package; the capture tree is Vite output.

## Redeploy (one command)

```bash
pnpm build                 # workspace packages first
pnpm deploy:hosted         # gateway, then capture built against the gateway URL
git add deploy && git commit -m "build: regenerate deploy trees" && git push
```

`pnpm deploy:gateway` / `pnpm deploy:capture` ship one side. The script uses `npx vercel@59`; run
`npx vercel@59 login` once on a new machine. Each `deploy/*` directory keeps its project link in a
git-ignored `.vercel/`; on a fresh clone the script re-links by project name.

## How it was set up (reproducible from the CLI, no dashboard)

```bash
cd deploy/gateway
npx vercel@59 link --yes --project firsthand-gateway --scope <team>
npx vercel@59 blob create-store firsthand-gateway --access public --yes   # injects BLOB_READ_WRITE_TOKEN
printf %s "$HOSTED_RELAYER_PRIVATE_KEY" | npx vercel@59 env add RELAYER_PRIVATE_KEY production --sensitive
npx vercel@59 deploy --prod --yes

cd ../capture   # built with FH_HOSTED_GATEWAY_URL=https://firsthand-gateway.vercel.app
npx vercel@59 link --yes --project firsthand-capture --scope <team>
npx vercel@59 deploy --prod --yes
```

Deployment protection was switched off on both projects (`PATCH /v9/projects/:id`
`{"ssoProtection":null}`) so deployment URLs open without a Vercel login.

Everything else — chain id, the deployment document, `RELAY_ENABLED`, `RELAY_FAUCET_MINT` (the
MockUSDC faucet double's `mint` rides the relay, selector-scoped, so a keyless demo buyer can fund
itself, capped at `RELAY_FAUCET_MAX_UNITS` = 1 USDC per call), `LEDGER_MAX_SCAN_BLOCKS` (12 000)
with `LEDGER_SCAN_BUDGET_MS` (40 s — the walk is newest-first and answers `scan.partial` instead of
timing out), `MAX_UPLOAD_BYTES` (4 MiB — Vercel rejects bodies above ~4.5 MB before the function
runs; measured 5 MB → 413; discovery publishes `limits.maxUploadBytes` and the PWA sizes captures
under it), the vercel stores, on-chain settlement, rate limits (60 burst / 0.5 per s per IP; the
relay has its own bucket), `PUBLIC_URL` — is defaulted in `apps/gateway/src/vercel.ts` and yields
to an explicit environment variable. Secrets on the public surface: exactly two, `RELAYER_PRIVATE_KEY`
(the dedicated hosted relayer `0x0DbDFcAa601F7C8EC642C2E475e8C8129aD15A8C`, small float) and
`BLOB_READ_WRITE_TOKEN` (injected by the store connection).

## Verify

```bash
GW=https://firsthand-gateway.vercel.app
curl -s $GW/healthz                       # {"ok":true,"settlement":"onchain","blobs":"vercel"}
curl -s $GW/.well-known/firsthand.json    # relay.enabled true, contracts of deployments/10143.json
curl -s $GW/v1/relay/capabilities         # 200, relayer 0x0DbD…, the four allow-listed contracts

# The browser proof against the live links — the whole judge script, real transactions on Monad testnet:
E2E_GATEWAY_URL=$GW E2E_APP_URL=https://firsthand-capture.vercel.app pnpm --filter firsthand-capture e2e
```

Published passports and ciphertext live in Vercel Blob (`firsthand/blobs/…`, `firsthand/passports/…`,
the same layout as the fs adapters), so `GET /v1/passports/:id` answers after any cold start or
redeploy — verified by redeploying and re-fetching.

## Operating the public relay

- The relay spends the relayer's gas on request. It is allow-listed to the four authority contracts,
  refuses non-zero value, simulates first, and the hosted defaults rate-limit to 60 requests with a
  0.5/s refill per IP (per warm instance — the chain-side counters remain the source of truth; a
  judging room behind one NAT runs the script more than once). A simulated revert comes back
  decoded (`relay: transaction would revert: EpochNotAttested(…)`); an empty float is
  `FH_INSUFFICIENT_FUNDS` (503) naming the relayer, and the PWA shows it as a banner.
- One key, several senders, several serverless instances: the paying account uses viem's nonce
  manager and every sender retries a nonce collision with a fresh pending nonce
  (`sendWithNonceRetry`), so two judges at once do not cost one of them a transaction.
- `/healthz` reports the float (`relayer.balanceMon`, `low` below `RELAYER_LOW_WATERMARK_MON`);
  the PWA's status strip reads it every minute and words it once it is low.
- The full judge script (enrol, attest, three anchors, faucet mint, card, terms, grant, settle,
  rescind — 12 relayed transactions) costs ≈ 0.08 MON; a capture alone ≈ 0.05 MON.
  Refill: send testnet MON to the relayer address above. Rotate: `npx vercel@59 env rm
  RELAYER_PRIVATE_KEY production` then `env add` a new one and redeploy — nothing on chain
  references the relayer.
- The relayer key cannot sign as any user: every relayed call carries the user's P-256 signature
  in calldata (ADR-0001).
