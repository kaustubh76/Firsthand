# @firsthand/importers

ChatGPT / Claude data exports → normalised conversations → deposit inputs tagged `IMPORT`.

| | |
|---|---|
| Holds secrets? | **No.** Produces datum + attestation; terms and keys are chosen at deposit time. |
| Runtime deps | `core`, `zod` |
| CLI | `firsthand-import <chatgpt|claude> conversations.json` — dry run printing content hashes. |

Source tags (`chatgpt-export-v1`, `claude-export-v1`) are committed into each passport's
attestation so buyers can filter by provenance class (README §13).
