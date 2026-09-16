# firsthand-mcp

MCP server exposing `firsthand_enroll`, `firsthand_attest`, `firsthand_deposit`, `firsthand_import`, `firsthand_grant`, `firsthand_register_card`, `firsthand_accept_terms`, `firsthand_query`, `firsthand_rescind`, `firsthand_status`
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
