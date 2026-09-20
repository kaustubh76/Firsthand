# integrations

Templates and PR drafts for partner teams building on the primitive (README §16 Phase 6: two
external integrations). Each integration documents which verb it consumes, which adapter it needs,
and the discovery document (`/.well-known/firsthand.json`) fields it relies on.

| Integration | Status | Where |
| --- | --- | --- |
| **ERC-8004 Trustless Agents** — buyers are carded agents; the gateway feeds paid-query reputation | **live on Monad testnet** against the reference registries (`0x8004A818…` / `0x8004B663…`); proven by the browser tier | `packages/adapters/src/erc8004`, gateway `/v1/agents/:id`, MCP `firsthand_register_agent`, app request card |
| **buyer-agent** — the partner template: discover → request → pay → audit | runnable against any gateway | [`buyer-agent/`](buyer-agent/README.md) |
| Envio Consent Ledger | deferred; the logs-backed ledger serves the demo (ADR-0013) | `packages/adapters/src/ledger/EnvioConsentLedger.ts` (shell) |
| Monad x402 facilitator | deferred; memory verification + on-chain settlement is what runs | `packages/adapters/src/x402/MonadFacilitatorClient.ts` |
| BTX encrypted mempool | not deployed on Monad testnet (2026-09); transport ships probe-gated | ADR-0012 |
