# @firsthand/indexer

Envio HyperIndex project for the **Consent Ledger** — the timeline that shows the timestamped end of
consent in the demo (README §19) and feeds `EnvioConsentLedger` in `@firsthand/adapters`.

Not part of the default `turbo build`: it depends on `envio codegen`, which needs the contract
addresses from `deployments/<chainId>.json` after the Phase 1–4 deployments. Until then
`config.yaml` and `schema.graphql` are the specification.

```sh
pnpm --filter @firsthand/indexer add envio   # deliberately not installed until Phase 5
pnpm --filter @firsthand/indexer codegen
pnpm --filter @firsthand/indexer dev
```
