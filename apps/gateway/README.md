# firsthand-gateway

Self-hostable serving path (README §4, §11). **Holds no key material** — enforced by
`scripts/check-deps.mjs` and Biome.

Routes: `GET /healthz`, `GET /.well-known/firsthand.json` (discovery), `GET /v1/query/:grantId/:passportId`
(x402-gated; Phase 3 fills `Serving.serve`), `GET /v1/blobs/:id` (ciphertext), `GET /v1/anchors/:root`.

```sh
cp .env.example .env
pnpm --filter firsthand-gateway dev     # X402_MODE=memory needs no network
```
Errors are RFC 9457 problem+json with FIRSTHAND codes; rate limiting is a pre-filter only.
