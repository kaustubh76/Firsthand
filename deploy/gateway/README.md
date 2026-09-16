# Hosted gateway (generated)

Deploy tree for the public FIRSTHAND gateway on Vercel. **Do not edit by hand** — regenerate with
`pnpm --filter firsthand-gateway bundle:vercel` after changing `apps/gateway` or any workspace
package it depends on, then commit. `api/index.js` bundles every `@firsthand/*` package; the four
registry dependencies are pinned to the pnpm catalog. Entry: `apps/gateway/src/vercel.ts`.
