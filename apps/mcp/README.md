# firsthand-mcp

MCP server exposing `firsthand_enroll`, `firsthand_attest`, `firsthand_deposit`, `firsthand_query`, `firsthand_rescind`, `firsthand_status`
over stdio. Runs on the **user's** machine and may derive keys (README §22, §13 "malicious MCP client":
a hostile client can only pollute its own user's locker — deposits are valid only under derived keys).

```sh
FIRSTHAND_STATIC_PRF_HEX=0x<64 hex> pnpm --filter firsthand-mcp dev   # demo/dev PRF only
# add RPC_URL + RELAYER_PRIVATE_KEY (+ PRINCIPAL_REGISTRY) to broadcast enroll/attest; otherwise the
# tools return signed calldata for out-of-band submission.
```
Claude Desktop / Cursor: point the MCP config at `apps/mcp/dist/index.js` after `pnpm build`.
