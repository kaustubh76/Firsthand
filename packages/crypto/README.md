# @firsthand/crypto — the privacy boundary

The only package that touches PRF output, derived keys, DEKs, or plaintext.

| | |
|---|---|
| Responsibility | `PrfSource` port, HKDF key tree (`KeyTree`), P-256 / secp256k1 signing, envelope encryption, grant wraps, `SecretBytes` lifetimes, CSPRNG helpers. |
| Holds secrets? | **Yes.** `apps/gateway` is forbidden from depending on it (ADR-0001). |
| Runtime deps | `@firsthand/core`, `@noble/{hashes,curves,ciphers}` |
| Audit surface | `src/**` (≈ 12 files). Every raw-bytes accessor is `SecretBytes.expose()` — grep it. |

`StaticPrfSource` exists for tests/demos and requires `{ unsafeAcknowledged: true }`.
`scripts/gen-vectors.ts` writes the `keys`, `envelope` and `p256-signatures` suites; hand cases
come from OpenSSL 3 (`openssl kdf HKDF`, `openssl pkeyutl -sign`). Coverage gate: 95 %.
