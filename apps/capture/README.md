# firsthand-capture

The three verbs from one link. **Capture:** a note, a photo/clip from the camera (bytes datum;
mime, size and name committed via `metaHash`), or a ChatGPT/Claude export (one passport per
conversation) — minted under the passkey, sealed client-side, anchored through the relay, published
to the gateway; plus the refusal (a passport signed by another locker's key → `FH_REFUSED_ORIGIN`).
**Locker:** activation (and re-attestation, with the chain's two-epoch grace honoured — grants stay
live through it, only new captures need a fresh root), deposits, grants with two ways to withdraw —
directly, or **privately** by commitment, where the reveal back-dates the end of consent to the
commit's block — the Consent Ledger (the gateway's event scan, bounded per request, with the window
stated on screen), and the Lineage Manifest exported and verified in-browser.
**Recall:** a demo buyer agent in the same browser — funds itself from the MockUSDC faucet double
through the selector-scoped relay, registers a card, accepts terms; you grant; it pays per query
over x402 (on-chain settlement, receipt, your USDC delta); you withdraw; the same query is refused.
**Evidence:** H1/H2/H3, S2 and S4 numbers read from `experiments/results` at build time — the
sign flip on H1, BTX marked not measurable, the H3 signature re-proof shown as the regression it is.
**Verify:** no locker needed, four cards. Paste a Lineage Manifest → verified against the chain
(origin signatures, Merkle inclusion, anchoring, finality, and each receipt against `ReceiptLedger`),
with `FirsthandLens` asked *in the present tense* beside it — the file proves the sale, the chain says
whether consent still stands. Look up a passport the gateway hosts. Look up a principal → what they
published, **and their Consent Ledger**, which is the auditor's view and needs no passkey. Look up an
ERC-8004 agent → its identity, card binding and reputation.
**Access requests:** an outside buyer (`firsthand_request_access` in the MCP) hands the human a
link `?grant=<card>&pub=<x25519>&ns=<n>&from=<label>`; the Locker shows it, one passkey tap grants.
**Exit:** Locker → *Take your locker with you* downloads everything the gateway holds for you
(ciphertext, sidecars, grant wraps — no plaintext, no key) as one file; *Re-publish here* takes
that file onto whatever gateway the app is pointed at (`?gateway=…`), which verifies each object
against the chain first (README §4 "keys + blobs walk away").
**Handoff:** Locker → *Let an agent deposit for you* issues a deposit code (`fhd1.…`) for one
namespace and this epoch — `firsthand-mcp` opens it as `FIRSTHAND_DELEGATION` and deposits into
this locker under this principal; it cannot grant, rescind or attest (SECURITY.md §3).
**Freshness and class:** the Verify tab's listing shows each passport's attestation class and each
namespace's staleness since its newest anchor (README §7.3, a market signal).
The Recall tab also exports the **buyer's** compliance file from the served query. A localStorage
journal keeps this browser's history (evidence is rebuilt from the gateway after a reload); the
status strip says when this epoch needs a fresh attestation and the Capture/Recall tabs offer the
activation right there; the Consent Ledger merges the gateway's window with the local journal;
every hash links to the explorer.

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

**The interface (21 Sep 2026).** Zero UI dependencies — hand-written tokens, inline SVG icons, the
system font stack. `src/styles/tokens.css` holds every colour, size and duration (dark default,
light under `prefers-color-scheme` or `<html data-theme>`, `--motion` zeroed under reduced motion);
`src/ui` are the primitives (Button with a pending state, Card, Pill, StatTile, Skeleton, Tabs,
Hash, Tx, Timeline, Notice, Sheet, Toast); `src/hooks` are what every screen shares —
`useAsyncActions` (one pending flag and one sentence per failure), `useToasts` + `useTx` (every
relayed transaction is a toast and an Activity row), `useJournal` (the localStorage journal as a
live store), `useJourney` (Readme §19's beats derived from the credential, the chain and the
journal), `useTheme`, `useInstallPrompt`, `useClipboard`. `src/shell` is the frame — header with
the status strip, the journey rail, the one `<nav>`, the settings sheet (gateway switcher on the
`?gateway=` mechanism, `/healthz` + discovery readout, theme, install, local resets). The screens
are `src/routes` (the Locker split into `routes/locker/*` cards). Deposits render as
`components/PassportCard` — the Data Passport as an object with a seal that moves as `land()`
reports phases.

**The browser tier is the UI's contract.** `e2e/capture.e2e.ts` clicks by role and name and reads
`data-testid`s; a redesign keeps: the `.status` element and its text order (`live · chain N · host`),
exactly one `<nav>` rendered only after unlock, no other button named with *capture* / *locker* /
*recall* (the test clicks nav buttons by those names unscoped), one `<h1>` per frame, the passport
id as the first `<code>` inside `[data-testid=landed]` and exactly one element there saying
"published", exact kind text in the Consent Ledger, one `.error` in the activation card, and
`scrollWidth ≤ 390` on every screen. `e2e/dark-tour.ts` is a visual tour (not a test) that
screenshots the built tree in dark mode at phone and laptop widths against a local chain.

**Browser tier:** `pnpm --filter firsthand-capture e2e` drives the committed `deploy/capture` tree
in headless Chromium with a virtual PRF passkey (local anvil by default, `E2E_TESTNET=1`, or
`E2E_GATEWAY_URL=`/`E2E_APP_URL=` for the hosted links).

**Order matters:** "Activate on chain" (enroll + attest) must happen before the first anchor.
`PassportAnchors.anchor` verifies the deposit-key signature against the root attested for that epoch,
so anchoring without it is refused.

Hosted captures are capped at 4 MiB (`limits.maxUploadBytes`, Vercel's request-body ceiling); a
self-hosted gateway takes 8 MiB. The status strip reads the gateway's `/healthz` every minute and
words the relayer float once it is low; an out-of-gas answer raises a banner instead of a failed
tap; discovery retries a cold-starting gateway and can be re-run from the strip.
