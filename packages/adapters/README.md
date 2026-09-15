# @firsthand/adapters

Ports and adapters for everything external or Monad-specific (ADR-0006).

| | |
|---|---|
| Responsibility | `TxTransport` (btx / public / memory), `AnchorWriter` (paged / baseline / memory), `X402Facilitator` (Monad / memory), `Erc8004Registry`, `ConsentLedger` (Envio / memory), `BlobStore` (fs / ipfs / memory), viem chain wiring. |
| Holds secrets? | **No.** `PublicMempoolTransport` / `BtxTransport` sign with a *relayer* wallet, never with user keys. |
| Runtime deps | `core`, `runtime`, `contracts`, `viem`, `zod` |
| Browser use | import `@firsthand/adapters/memory` (pure) or `@firsthand/adapters/x402` (payment codec + typed data); the root entry pulls Node `fs`. |

Every memory double extends `Recorder`: `calls`, `callsTo(method)`, `failNext(error)`.
`BtxTransport` signs → `seal`s (identity until Monad ships the scheme) → posts via a configurable
JSON-RPC method, and throws `FH_BTX_UNAVAILABLE` while its probe says the node does not know it —
BTX is not deployed on Monad testnet as of 2026-09 (ADR-0012). `GrantReader.principalLiveness`
carries the §7.6 `thawEpoch`.
