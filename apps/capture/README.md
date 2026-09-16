# firsthand-capture

Minimal PWA: enrol a passkey with the WebAuthn `prf` extension, tap to unlock the locker, stamp a
capture with a `DEVICE_CAPTURE` passport, anchor batches on chain, post a rescission.

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

The gateway must run with `RELAY_ENABLED=true` for anchoring to work. Without `VITE_GATEWAY_URL` the
app falls back to memory adapters so `pnpm dev` still works offline — it will say so on screen, since
nothing captured that way can ever be recalled.

**Order matters:** "Activate on chain" (enroll + attest) must happen before the first anchor.
`PassportAnchors.anchor` verifies the deposit-key signature against the root attested for that epoch,
so anchoring without it is refused.

Known gap: capture is text only. The README's demo scene wants a photo or short clip; the provenance
path is identical for any payload, so this is UI work, not protocol work.
