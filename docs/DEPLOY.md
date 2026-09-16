# Deploying the public surfaces

Two Vercel projects, both served straight from committed deploy trees so the builder never has to
build the monorepo (it needs Foundry and Node 26, which Vercel's builders lack):

| Project             | Root directory    | What it is                                                           |
| ------------------- | ----------------- | -------------------------------------------------------------------- |
| `firsthand-gateway` | `deploy/gateway`  | One Node function (`api/index.js`) fronting the whole Hono gateway    |
| `firsthand-capture` | `deploy/capture`  | The capture PWA, static                                              |

Regenerate the trees after any change to `apps/gateway`, `apps/capture` or a package they depend on:

```bash
pnpm build                                        # workspace packages first
pnpm --filter firsthand-gateway bundle:vercel     # → deploy/gateway
FH_HOSTED_GATEWAY_URL=https://<gateway-host> pnpm --filter firsthand-capture bundle:vercel   # → deploy/capture
git add deploy && git commit -m "build: regenerate deploy trees" && git push
```

Every push to `main` redeploys both projects.

## One-time setup (dashboard — the API cannot create projects or set secrets)

1. **Gateway project.** Vercel → *Add New → Project → Import* `kaustubh76/Firsthand`.
   Project name `firsthand-gateway`, **Root Directory `deploy/gateway`**, framework *Other*, leave
   build/output empty. Deploy. It boots *degraded* (`/healthz` shows `memory`) until step 3.
2. **Blob store.** Project → *Storage → Create → Blob*, connect it to the project (this injects
   `BLOB_READ_WRITE_TOKEN`). Durable blobs and passports across cold starts.
3. **Relayer key.** Project → *Settings → Environment Variables*: `RELAYER_PRIVATE_KEY` = the
   value of `HOSTED_RELAYER_PRIVATE_KEY` in the repo-root `.env` (generated with `cast wallet new`;
   never the deployer). Fund its address with ~1 MON from the Monad faucet. Redeploy.
4. **Capture project.** Import the same repo again: name `firsthand-capture`, **Root Directory
   `deploy/capture`**, framework *Other*. If the gateway's production host is not
   `firsthand-gateway.vercel.app`, rebuild `deploy/capture` with `FH_HOSTED_GATEWAY_URL` (or open
   the PWA with `?gateway=https://<host>` — it remembers).
5. **Deployment protection.** Both projects → *Settings → Deployment Protection → Off* for
   production, or visitors are asked to log in to Vercel.

Everything else — chain id, the deployment document, `RELAY_ENABLED`, the vercel stores, on-chain
settlement, rate limits, `PUBLIC_URL` — is defaulted in `apps/gateway/src/vercel.ts` and yields to
an explicit environment variable.

## Verify

```bash
GW=https://firsthand-gateway.vercel.app
curl -s $GW/healthz                       # {"ok":true,"settlement":"onchain","blobs":"vercel"}
curl -s $GW/.well-known/firsthand.json    # relay.enabled true, contracts of deployments/10143.json
curl -s $GW/v1/relay/capabilities         # 200 with the four allow-listed contracts
```

Then from the PWA: enrol → activate on chain → capture → the anchor transaction appears on
`testnet.monadexplorer.com`, and `GET $GW/v1/passports/<id>` returns the sidecar — also after the
function has gone cold, which is what the Blob store is for.

## Operating the public relay

- The relay spends the relayer's gas on request. It is allow-listed to the four authority contracts,
  refuses non-zero value, simulates first, and the hosted defaults rate-limit to 20 requests with a
  0.2/s refill per IP (per warm instance — the chain-side counters remain the source of truth).
- Refill: send MON to the relayer address in `deployments/NOTES.md`. Rotate by setting a new
  `RELAYER_PRIVATE_KEY` and redeploying; nothing on chain references the relayer.
- The relayer key is the only secret on the public surface. It cannot sign as any user: every
  relayed call carries the user's P-256 signature in calldata (ADR-0001).
