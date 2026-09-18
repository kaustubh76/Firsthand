# firsthand-mcp

MCP server exposing `firsthand_enroll`, `firsthand_attest`, `firsthand_deposit`, `firsthand_import`, `firsthand_grant`, `firsthand_register_card`, `firsthand_accept_terms`, `firsthand_request_access`, `firsthand_query`, `firsthand_export_manifest`, `firsthand_rescind`, `firsthand_status`
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

1. The human stamps something at <https://firsthand-capture.vercel.app> and shares the passport id
   (it is public — the gateway serves the sidecar to anyone).
2. `firsthand_request_access({ passportId })` reads the sidecar (principal, namespace, price),
   registers the agent's card, accepts those exact terms on chain, and returns an **approval link**.
3. The human opens the link: the Locker shows "*label* asks for namespace *n*" → *Approve with
   passkey*. One grant transaction; the wrap is published for the gateway.
4. `firsthand_query({ gatewayUrl, grantId, passportId })` pays 0.001 USDC over x402 and opens the
   plaintext (the grant id is listed under Locker → Grants; the buyer can also compute it —
   `keccak(principalId, cardId, ns, epochStart)`).
5. `firsthand_export_manifest({ gatewayUrl, grantId, passportIds })` queries and returns the buyer's
   Lineage Manifest — origin signature, Merkle proof, anchor and receipt per asset — verified
   against the chain before it is handed back.

The buyer needs MockUSDC for step 4: on testnet the token is the faucet double and the gateway
relays its `mint` (selector-scoped, published in discovery), so `firsthand_request_access` funds
the agent with a hundred queries' worth itself and reports `funding.txHash` — or says why it could
not (a real stablecoin deployment does not relay `mint`).

If the human withdraws consent, step 4 answers `FH_GRANT_RESCINDED` (HTTP 403): no data, no charge.
