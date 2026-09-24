# buyer-agent — the partner template

An AI buyer that discovers, requests, pays for and audits provenance-checked data through **any**
FIRSTHAND gateway. Everything it does is an SDK call or one endpoint from the gateway's discovery
document; nothing is specific to the hosted deployment. The browser tier's "outside buyer" runs
these exact functions (`src/lib.ts`), so the template cannot drift from what is proven.

```sh
GATEWAY_URL=https://firsthand-gateway.vercel.app \
BUYER_PRIVATE_KEY=0x…  \
pnpm --filter @firsthand/buyer-agent buy -- --principal 0x<from the human's locker link> [--erc8004] [--label "My agent"]
```

`--principal <id>` lists what that human has published and buys the first passport; `--passport <id>`
skips the listing and buys exactly that one — which is what you want once you know which datum you
are after, or when a gateway hosts more than one seller. One of the two is required. `--erc8004`
registers the agent on the Identity Registry first (it pays its own gas, ~0.07 MON), so the venue
can credit its paid queries; `--label` is the name that registration and the human's approval link
carry.

| Step (`src/lib.ts`) | What it uses | Gas? |
| --- | --- | --- |
| `discover` | `GET /.well-known/firsthand.json` — chain, contracts, relay, x402 asset, ERC-8004 registries, app URL | — |
| `listPassports` | `GET /v1/principals/:id/passports` — what the human published: ns, epoch, price | — |
| `fetchSidecar` | `GET /v1/passports/:id` — the public sidecar: principal, terms, batch root, proof | — |
| `openBuyer` | `BuyerSession` over `HttpRelayTransport` — an EVM key that pays, an X25519 key vaults wrap to | — |
| `prepare` | `registerCard`, `acceptTerms` (relayed; the signature authorises, not the sender); MockUSDC `mint` through the relay where the gateway lists it | none |
| `registerAgent` (`--erc8004`) | `IdentityRegistry.register(agentURI, [{firsthand.card: cardId}])` — a `data:` registration file, the card bound in metadata | **the agent's own** (~0.07 MON on Monad testnet; the registry is `msg.sender`-authorised) |
| `approvalLink` | `<app>/?grant=<card>&pub=<x25519>&ns=<n>&from=<label>&agent=<id>` — the human approves with a passkey | — |
| `awaitGrant` | `grantIdOf(principal, card, ns, epoch)` is deterministic; poll `GrantManager.effectiveStatus` until ACTIVE — no callback from the human needed | — |
| `buy` | `queryAndOpen` — GET → 402 → EIP-3009 signature → served ciphertext + receipt → opened with the wrap; `?agent=` so the gateway credits the query | none (settlement gas is the gateway's) |
| `complianceFile` | `manifestFromQueries` + `verifyManifest` — the buyer's Lineage Manifest, checked against the chain | — |
| `reputation` | `GET /v1/agents/:id` — paid queries the venue credited to the agent on the ERC-8004 Reputation Registry | — |

## Tests

`pnpm --filter @firsthand/buyer-agent test` covers everything that needs no chain: the HTTP surface
above and `resilientFetch`, which is why this template survives a serverless host — it repeats a read
through a dropped keep-alive socket, waits out the gateway's `503 + retry-after` when its chain RPC
is rate-limiting, and refuses to repeat a write that may already have been sent.

The chain-bound half (`openBuyer`, `prepare`, `registerAgent`, `awaitGrant`, `buy`, `complianceFile`)
is covered by the browser tier instead: `apps/capture/e2e/capture.e2e.ts` imports these exact
functions for its outside buyer and drives them against the live links on Monad testnet, so the
template cannot drift from what is proven. `src/buy.ts` is the CLI wrapper and is excluded from the
coverage gate for the same reason `@firsthand/importers` excludes its own.

What a partner changes: the key management (`BUYER_PRIVATE_KEY` → your signer), how the approval
link reaches the human (chat, email, a marketplace inbox), and what you do with the plaintext. The
manifest is the file your compliance team keeps.

Refusals you will meet, by design: `FH_GRANT_RESCINDED` (HTTP 403) once the human withdraws —
no data, no charge; `FH_REFUSED_ORIGIN` never reaches you, it stops unprovable data at the seller.
