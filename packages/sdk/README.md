# @firsthand/sdk

The three verbs and the one verification call, assembled over injected adapters.

| | |
|---|---|
| Responsibility | `Locker` (user-side key tree + namespaces), `Batcher` (≤ 256 passports per anchor, signed anchor requests), `deposit` / `acceptSigned` with the **refusal gate**, `query` (Phase 3), `rescind` planning + sending, `verify()`, Lineage Manifest export / offline verify, WebAuthn PRF ceremony (`./browser`), contract readers. |
| Holds secrets? | **Yes, transiently** — it drives `@firsthand/crypto` on the user's machine. Never run it inside the gateway. |
| Runtime deps | `core`, `crypto`, `adapters` (types + memory), `runtime`, `contracts`, `viem`, `zod` |

Coverage excludes `src/webauthn/**` (browser-only) and `src/contracts/**` (RPC-backed) — exercised
by the capture PWA and `test:testnet`. `verifyManifest` has explicit signature modes (`"all"` default,
`"none"`, or a sample size) and reports Merkle vs signature time separately; see S1 results.
