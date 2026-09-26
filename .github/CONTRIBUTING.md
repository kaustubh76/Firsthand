# Contributing

The full document lives at [`docs/CONTRIBUTING.md`](../docs/CONTRIBUTING.md) — the doctrine, the
per-phase self-review checklist and the commit conventions. This file exists so GitHub surfaces it.

This is a solo project by design (`Readme.md` §18), so those rules stand in for peer review. If you
want to *use* it rather than change it, start at [`QUICKSTART.md`](../QUICKSTART.md) (`pnpm demo`
runs the whole loop on a local chain, no keys) or at
[`integrations/buyer-agent/README.md`](../integrations/buyer-agent/README.md), which is the partner
template for buying provenance-checked data through any FIRSTHAND gateway.

Before opening a PR: `pnpm check:all` and `FOUNDRY_PROFILE=ci forge test` both green.
