# firsthand-mcp

MCP server exposing `firsthand_enroll`, `firsthand_attest`, `firsthand_deposit`, `firsthand_import`, `firsthand_grant`, `firsthand_register_card`, `firsthand_register_agent`, `firsthand_agent_reputation`, `firsthand_accept_terms`, `firsthand_list_passports`, `firsthand_request_access`, `firsthand_query`, `firsthand_export_manifest`, `firsthand_export_locker`, `firsthand_import_locker`, `firsthand_rescind`, `firsthand_status`
over stdio. Runs on the **user's** machine and may derive keys (README §22, §13 "malicious MCP client":
a hostile client can only pollute its own user's locker — deposits are valid only under derived keys).

```sh
FIRSTHAND_STATIC_PRF_HEX=0x<64 hex> pnpm --filter firsthand-mcp dev   # demo/dev PRF only
# add RPC_URL + RELAYER_PRIVATE_KEY (+ PRINCIPAL_REGISTRY) to broadcast enroll/attest/grant/rescind;
# otherwise the tools return signed calldata for out-of-band submission.
# BTX_RPC_URL (+ BTX_METHOD) routes rescissions over the encrypted mempool once Monad ships it;
# until then firsthand_rescind defaults to `public` and `commit-reveal` is the un-front-runnable path.
# firsthand_query is the buyer side: needs BUYER_PRIVATE_KEY (pays over x402) + GRANTEE_SEED_HEX
# (X25519 key the grant wrap is sealed to); it opens the plaintext locally.
```
Claude Desktop / Cursor: point the MCP config at `apps/mcp/dist/index.js` after `pnpm build`.

## An agent buys from a phone — against the live gateway, with no gas

The demand side of README §1, from any MCP-capable agent. No relayer key: with `GATEWAY_URL` set
and no `RELAYER_PRIVATE_KEY`, every transaction (card, terms, even anchoring) rides the gateway's
relay, so the agent needs no MON at all.

```sh
# a throwaway buyer identity (testnet only)
BUYER_PRIVATE_KEY=0x<64 hex>  GRANTEE_SEED_HEX=0x<64 hex>
GATEWAY_URL=https://firsthand-gateway.vercel.app
RPC_URL=https://testnet-rpc.monad.xyz  DEPLOYMENTS_FILE=$PWD/deployments/10143.json
```

1. The human stamps something at <https://firsthand-capture.vercel.app> and shares their locker
   link (Locker → *Share your locker*: `?principal=<id>`) — or a passport id; both are public.
2. `firsthand_list_passports({ principalId })` shows what they published (namespace, epoch, price);
   `firsthand_request_access({ principalId })` (or `{ passportId }`) reads the sidecar, registers
   the agent's card, accepts those exact terms on chain, funds the agent from the faucet double where
   the gateway relays it, and returns an **approval link**.
3. The human opens the link: the Locker shows "*label* asks for namespace *n*" → *Approve with
   passkey*. One grant transaction; the wrap is published for the gateway.
4. `firsthand_query({ gatewayUrl, grantId, passportId })` pays 0.001 USDC over x402 and opens the
   plaintext (the grant id is listed under Locker → Grants; the buyer can also compute it —
   `keccak(principalId, cardId, ns, epochStart)`).
5. `firsthand_export_manifest({ gatewayUrl, grantId, passportIds })` queries and returns the buyer's
   Lineage Manifest — origin signature, Merkle proof, anchor and receipt per asset — verified
   against the chain before it is handed back.

**Be an ERC-8004 agent (recommended).** `firsthand_register_agent({ name })` mints the agent's
identity on the reference Identity Registry (Monad testnet `0x8004A818…`) with a `data:`
registration file and this buyer's card bound in metadata — the one transaction the buyer signs
with its own key (≈0.07 MON; the registry is `msg.sender`-authorised, so it cannot be relayed).
Set the returned id as `BUYER_AGENT_ID`: approval links then carry `agent=`, the human sees
*ERC-8004 agent #N · binding verified ✓*, and every paid query becomes one unit of
`firsthand/paid-query` feedback from the gateway on the Reputation Registry —
`firsthand_agent_reputation` reads it back.

The buyer needs MockUSDC for step 4: on testnet the token is the faucet double and the gateway
relays its `mint` (selector-scoped, published in discovery), so `firsthand_request_access` funds
the agent with a hundred queries' worth itself and reports `funding.txHash` — or says why it could
not (a real stablecoin deployment does not relay `mint`).

If the human withdraws consent, step 4 answers `FH_GRANT_RESCINDED` (HTTP 403): no data, no charge.

`firsthand_list_passports` also returns each passport's attestation class (filter with
`class: "device_capture"`) and each namespace's freshness — staleness since its newest anchor,
README §7.3 — so an agent prices continuing access on something measured.

## Exit — a locker moves between gateways

`firsthand_export_locker({ path })` writes everything a gateway holds for a principal (ciphertext,
sidecars, grant wraps; never plaintext, never a key) to one file; `firsthand_import_locker({
gatewayUrl, path })` re-publishes it on another gateway, which verifies every object against the
chain before hosting it (README §4 "exit = keys + blobs walk away"). Pass `principalId` to carry
someone else's public objects — a bundle needs no trust in its carrier.
