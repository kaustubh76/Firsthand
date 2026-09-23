# integrations

Templates and PR drafts for partner teams building on the primitive (README §16 Phase 6: two
external integrations — ERC-8004 and the x402 facilitator are both live). Each integration
documents which verb it consumes, which adapter it needs, and the discovery document
(`/.well-known/firsthand.json`) fields it relies on.

| Integration | Status | Where |
| --- | --- | --- |
| **ERC-8004 Trustless Agents** — buyers are carded agents; the gateway feeds paid-query reputation | **live on Monad testnet** against the reference registries (`0x8004A818…` / `0x8004B663…`); proven by the browser tier | `packages/adapters/src/erc8004`, gateway `/v1/agents/:id`, MCP `firsthand_register_agent`, app request card |
| **buyer-agent** — the partner template: discover → request → pay → audit | runnable against any gateway | [`buyer-agent/`](buyer-agent/README.md) |
| **Monad x402 facilitator** — every paid query is verified by Monad's native facilitator | **live on Monad testnet** at `x402-facilitator.molandak.org` (x402 v2); measured in `packages/adapters/test/testnet` — it verified a FIRSTHAND payment for FIRSTHAND's own USDC. Settlement stays in `RoyaltyRouter` (ADR-0014); the gateway also verifies x402 payments *for* others at `/x402/verify` | `packages/adapters/src/x402/`, gateway `X402_MODE=monad`, discovery `x402.verification` |
| Envio Consent Ledger | deferred; the logs-backed ledger serves the demo (ADR-0013) | `packages/adapters/src/ledger/EnvioConsentLedger.ts` (shell) |
| BTX encrypted mempool | not deployed on Monad testnet (2026-09); transport ships probe-gated | ADR-0012 |
