# Security policy

The full document lives at [`docs/SECURITY.md`](../docs/SECURITY.md) — the derivation tree, what the
repository mechanically enforces about key handling, and what FIRSTHAND explicitly does **not**
claim. This file exists so GitHub surfaces it.

## Reporting

Report privately to the maintainer (Kaushtubh — see the repository profile). **Please do not open a
public issue for a key-handling bug.** Use GitHub's *Report a vulnerability* button on the Security
tab, which opens a private advisory.

FIRSTHAND is a hackathon build (Monad Metropolis 2026) on **Monad testnet only** — there is no
mainnet deployment, no upgradability and no admin key. The contracts are immutable, so a contract
bug cannot be patched in place; it would need a redeploy.
