# Recordings

Bytes that came from somewhere real, committed verbatim.

They live here rather than in [`../vectors`](../vectors) because that directory belongs to
`packages/core/scripts/gen-vectors.ts`: `pnpm vectors:check` regenerates every suite it owns and
fails on any difference. A recording cannot be regenerated — the whole point is that a device or a
public endpoint produced it on a date — so it would be permanently "dirty" there.

Every recording carries its own provenance inline: where it came from, the exact command, the date,
and what was measured from it. A test asserts the measurement rather than trusting the note, because
a comment that drifts from its bytes is worse than no comment.

| File | What it is |
|---|---|
| `google-attestation-roots.v1.json` | Google's two published Android key-attestation roots, fetched 2026-10-03. Neither is P-256 — one is RSA-4096, the other P-384 — which is *why* `HardwareDeviceRegistry` pins the highest P-256 certificate in a chain instead of the root (ADR-0015, SECURITY.md §5). |

**Nothing here is private.** A key-attestation chain is public data, and an attestation root is
published by its issuer. Device identifiers are a different matter: `setDevicePropertiesAttestationIncluded`
is never requested, and any recording of a device chain must ship with a test asserting that
KeyDescription tags 710–717 and 723 are absent and `uniqueId` is empty. This repository is public;
assert it, do not eyeball it.
