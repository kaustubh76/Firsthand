# firsthand-capture

The three verbs from one link. **Capture:** a note, a photo/clip from the camera (bytes datum;
mime, size and name committed via `metaHash`), or a ChatGPT/Claude export (one passport per
conversation) — minted under the passkey, sealed client-side, anchored through the relay, published
to the gateway; plus the refusal (a passport signed by another locker's key → `FH_REFUSED_ORIGIN`).
**Locker:** activation, deposits, grants with one-tap direct rescission, the Consent Ledger (gateway
timeline since the enrol block), the Lineage Manifest exported and verified in-browser.
**Recall:** a demo buyer agent in the same browser — funds itself from the MockUSDC faucet double
through the selector-scoped relay, registers a card, accepts terms; you grant; it pays per query
over x402 (on-chain settlement, receipt, your USDC delta); you withdraw; the same query is refused.
**Verify:** no locker needed — paste a Lineage Manifest and it is verified against the chain
(origin signatures, Merkle inclusion, anchoring, finality), or look up a passport the gateway hosts.
**Access requests:** an outside buyer (`firsthand_request_access` in the MCP) hands the human a
link `?grant=<card>&pub=<x25519>&ns=<n>&from=<label>`; the Locker shows it, one passkey tap grants.
The Recall tab also exports the **buyer's** compliance file from the served query. A localStorage
journal keeps this browser's history (evidence is rebuilt from the gateway after a reload); the
status strip says when this epoch needs a fresh attestation; every hash links to the explorer.

**Hosted:** <https://firsthand-capture.vercel.app> (against <https://firsthand-gateway.vercel.app>).
`?gateway=https://…` points the same build at another gateway and is remembered; `?gateway=`
forgets. Redeploy with `pnpm deploy:capture` (`docs/DEPLOY.md`).

**Live against a deployment, without holding a key.** Addresses, epoch parameters and the anchors
layout come from the gateway's `/.well-known/firsthand.json` — the browser's substitute for
`deployments/<chainId>.json`, which it cannot read. Reads go through a key-less viem client; writes
go through the gateway's relay (`POST /v1/relay`), which is safe because every authority-signed entry
point authorises by the signature inside the calldata, never `msg.sender` (ADR-0009). The browser
therefore needs no key and no gas.

```sh
cp .env.example .env          # set VITE_GATEWAY_URL (and VITE_RPC_URL if not published by the gateway)
pnpm --filter firsthand-capture dev      # WebAuthn needs localhost or HTTPS
```

The gateway must run with `RELAY_ENABLED=true` for anchoring to work. Without a reachable relay the
app falls back to memory adapters so `pnpm dev` still works offline — the status strip on every
screen says `offline · <why>`, since nothing captured that way can ever be recalled.

**Browser tier:** `pnpm --filter firsthand-capture e2e` drives the committed `deploy/capture` tree
in headless Chromium with a virtual PRF passkey (local anvil by default, `E2E_TESTNET=1`, or
`E2E_GATEWAY_URL=`/`E2E_APP_URL=` for the hosted links).

**Order matters:** "Activate on chain" (enroll + attest) must happen before the first anchor.
`PassportAnchors.anchor` verifies the deposit-key signature against the root attested for that epoch,
so anchoring without it is refused.

Known gap: capture is text only. The README's demo scene wants a photo or short clip; the provenance
path is identical for any payload, so this is UI work, not protocol work.
