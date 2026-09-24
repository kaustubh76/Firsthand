# @firsthand/adapters

Ports and adapters for everything external or Monad-specific (ADR-0006).

| | |
|---|---|
| Responsibility | `TxTransport` (btx / public / http-relay / memory), `AnchorWriter` (onchain / memory), `X402Facilitator` (Monad / local / fallback / memory), `Erc8004Registry` (onchain / memory), `ConsentLedger` (`LogsConsentLedger` live, Envio shell deferred — ADR-0013), `BlobStore` (fs / ipfs / object / memory), `PassportCatalog` (fs / object / memory), `ObjectStore`, `GrantReader`, `Settlement`, viem chain wiring. |
| Holds secrets? | **No.** `PublicMempoolTransport` / `BtxTransport` sign with a *relayer* wallet, never with user keys. |
| Runtime deps | `core`, `runtime`, `contracts`, `viem`, `zod` |
| Browser use | import `@firsthand/adapters/memory` (pure) or `@firsthand/adapters/x402` (payment codec + typed data); the root entry pulls Node `fs`. |

The three x402 verifiers are one decision, not three (ADR-0014): `MonadFacilitatorClient` asks
Monad's native facilitator, which speaks x402 v2 and — measured, not read — accepts the envelope from
Monad's own guide and refuses the one in the x402 specification; `LocalFacilitator` recovers the
EIP-3009 signature itself and checks the window, the authorization state and the balance, so a
self-hoster needs no third party; `FallbackFacilitator` falls back from the first to the second only
on a transport failure or a declared capability gap, never on a verdict — a forged payment cannot
shop for a second opinion. Every verdict names its source in `verifiedBy`.

Every memory double extends `Recorder`: `calls`, `callsTo(method)`, `failNext(error)`.
`BtxTransport` signs → `seal`s (identity until Monad ships the scheme) → posts via a configurable
JSON-RPC method, and throws `FH_BTX_UNAVAILABLE` while its probe says the node does not know it —
BTX is not deployed on Monad testnet as of 2026-09 (ADR-0012). `GrantReader.principalLiveness`
carries the §7.6 `thawEpoch`.
