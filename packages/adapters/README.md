# @firsthand/adapters

Ports and adapters for everything external or Monad-specific (ADR-0006).

| | |
|---|---|
| Responsibility | `TxTransport` (btx / public / memory), `AnchorWriter` (paged / baseline / memory), `X402Facilitator` (Monad / memory), `Erc8004Registry`, `ConsentLedger` (Envio / memory), `BlobStore` (fs / ipfs / memory), viem chain wiring. |
| Holds secrets? | **No.** A `PublicMempoolTransport` signs with a *relayer* wallet, never with user keys. |
| Runtime deps | `core`, `runtime`, `contracts`, `viem`, `zod` |
| Browser use | import `@firsthand/adapters/memory` (pure); the root entry pulls Node `fs`. |

Every memory double extends `Recorder`: `calls`, `callsTo(method)`, `failNext(error)`.
`BtxTransport.send` throws `FH_BTX_UNAVAILABLE` until the RPC surface is confirmed (Phase 0 gate).
