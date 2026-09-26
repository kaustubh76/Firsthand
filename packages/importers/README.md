# @firsthand/importers

ChatGPT / Claude data exports → normalised conversations → deposit inputs tagged `IMPORT`.

| | |
|---|---|
| Holds secrets? | **No.** Produces datum + attestation; terms and keys are chosen at deposit time. |
| Runtime deps | `core`, `zod` |
| CLI | `firsthand-import <chatgpt\|claude> conversations.json` — dry run printing content hashes. Add `--deposit` to mint and publish one passport per conversation, through a **deposit delegation** (`FIRSTHAND_DELEGATION`, the `fhd1.` code the capture app issues): scoped to one namespace and one epoch, cannot grant or rescind, and gas is the gateway relay's — so importing a decade of history never needs the passkey that ends consent. Also needs `GATEWAY_URL`, `DEPLOYMENTS_FILE`, `MONAD_RPC_URL`. The MCP tool `firsthand_import` is the same parser from an agent. |

Source tags (`chatgpt-export-v1`, `claude-export-v1`) are committed into each passport's
attestation so buyers can filter by provenance class (README §13).

## The library stays pure

The `.` entry point is parsing only — `@firsthand/core` and `zod`, nothing else — so anything that
just wants conversations out of an export pays for nothing more. The `firsthand-import` bin is what
pulls `@firsthand/sdk`, because depositing is what it does; `scripts/check-deps.mjs` pins both
lists. The boundary ADR-0001 actually enforces is `firsthand-gateway` ⇏ `@firsthand/crypto`, and it
is untouched: a CLI holding a deposit delegation is supposed to reach keys, a serving gateway is not.
