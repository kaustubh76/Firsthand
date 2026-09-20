# firsthand-gateway

Self-hostable serving path (README §4, §11). **Holds no key material** — enforced by
`scripts/check-deps.mjs` and Biome.

Routes: `GET /healthz`, `GET /.well-known/firsthand.json` (discovery),
`GET /v1/query/:grantId/:passportId` (402 priced from the sidecar's terms → `X-PAYMENT` → `verify()`
→ settle → `{sidecar, blob, wrappedDek, receipt}`), `GET /v1/passports/:id` (public sidecar),
`GET /v1/blobs/:id` (ciphertext), `GET /v1/grants/:id/wrap`, `GET /v1/anchors/:root`;
`POST /v1/relay` + `GET /v1/relay/capabilities` (opt-in: submits signature-authorised calls for
clients holding no key — allow-listed targets, zero value, simulated first); ingest
`POST /v1/passports` (accepted only if the signature verifies, the root is anchored to the same
owner and the terms preimage matches), `POST /v1/blobs` (content-addressed), `POST /v1/grants/:id/wrap`
(only if `keccak256 == wrapRef` on chain). Verified ingest, verified serve — ADR-0011.

```sh
cp .env.example .env
pnpm --filter firsthand-gateway dev     # memory mode: no network, in-process grants + settlement
# chain mode: DEPLOYMENTS_FILE=…/31337.json SETTLEMENT_MODE=onchain RELAYER_PRIVATE_KEY=0x…
pnpm --filter firsthand-gateway test:anvil   # Phase 3 gate against anvil --odyssey + MockUSDC
```
Errors are RFC 9457 problem+json with FIRSTHAND codes (`FH_GRANT_RESCINDED` 403, `FH_RATE_LIMITED`
429 with `retry-after`, `FH_PAYMENT_INVALID` 402, `FH_NOT_FOUND` 404, `FH_INSUFFICIENT_FUNDS` 503
when the relayer float is empty, `FH_CHAIN` 502 with the decoded revert reason in `detail`); rate
limiting is a pre-filter only — the `ReceiptLedger` is the truth. The relayer key pays gas for
`RoyaltyRouter.settle`, the relay and ERC-8004 feedback, and for nothing a user authorises.
