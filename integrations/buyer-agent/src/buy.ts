import { generatePrivateKey } from "viem/accounts";
import {
  approvalLink,
  awaitGrant,
  buy,
  complianceFile,
  discover,
  fetchSidecar,
  listPassports,
  openBuyer,
  prepare,
  registerAgent,
  reputation,
} from "./lib.js";

/**
 * A buyer agent, end to end, against any FIRSTHAND gateway:
 *
 *   GATEWAY_URL=https://firsthand-gateway.vercel.app \
 *   BUYER_PRIVATE_KEY=0x…  (any key; funded with a little MON only if you pass --erc8004) \
 *   pnpm --filter @firsthand/buyer-agent buy -- --principal 0x…   (or --passport 0x…) [--erc8004] [--label "My agent"]
 *
 * Prints the approval link for the human; waits for the grant; pays per query; writes the
 * compliance file to ./buyer-lineage-<grant>.json.
 */
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i] as string;
  if (a.startsWith("--"))
    args.set(
      a.slice(2),
      process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"),
    );
}
const gatewayUrl = (process.env["GATEWAY_URL"] ?? "https://firsthand-gateway.vercel.app").replace(
  /\/+$/,
  "",
);
const key = (process.env["BUYER_PRIVATE_KEY"] as `0x${string}` | undefined) ?? generatePrivateKey();
const label = args.get("label") ?? "buyer-agent template";

const say = (m: string) => console.log(m);

const disco = await discover(gatewayUrl);
say(
  `gateway ${gatewayUrl} · chain ${disco.chainId} · relay ${disco.relay.enabled} · erc8004 ${disco.erc8004 ? "yes" : "no"}`,
);
const buyer = openBuyer(gatewayUrl, disco, key, crypto.getRandomValues(new Uint8Array(32)));
say(`buyer ${buyer.address} · card ${buyer.cardId}`);

let passportId = args.get("passport") as `0x${string}` | undefined;
if (!passportId) {
  const principal = args.get("principal") as `0x${string}` | undefined;
  if (!principal)
    throw new Error("pass --principal <id> (from the human's locker link) or --passport <id>");
  const listed = await listPassports(gatewayUrl, principal);
  say(`principal ${principal} published ${listed.length} passport(s)`);
  for (const p of listed)
    say(`  ${p.passportId} · ns ${p.ns} · epoch ${p.epoch} · ${p.price} units/query`);
  passportId = listed[0]?.passportId;
  if (!passportId) throw new Error("nothing to buy");
}
const sidecar = await fetchSidecar(gatewayUrl, passportId);
say(
  `passport ${passportId} · principal ${sidecar.principalId} · ns ${sidecar.ns} · price ${sidecar.terms.price} units`,
);

const prep = await prepare(buyer, disco, sidecar);
say(
  `card ${prep.registerCardTx} · terms ${prep.acceptTermsTx}${prep.fundedTx ? ` · funded ${prep.fundedTx}` : ""}`,
);

let agentId: bigint | undefined;
if (args.get("erc8004") === "true") {
  const reg = await registerAgent(
    buyer,
    disco,
    gatewayUrl,
    label,
    "FIRSTHAND buyer-agent template",
  );
  agentId = reg.agentId;
  say(`ERC-8004 agent #${agentId} registered — ${reg.txHash}`);
}

const link = approvalLink(
  disco.app ?? "https://firsthand-capture.vercel.app",
  buyer,
  sidecar.ns,
  label,
  agentId,
);
say(`\nSend this to the human and wait for their passkey tap:\n  ${link}\n`);

const grantId = await awaitGrant(buyer, disco, sidecar.principalId, sidecar.ns);
say(`granted: ${grantId}`);

const served = await buy(buyer, gatewayUrl, disco, grantId, passportId, agentId);
const text = new TextDecoder().decode(served.plaintext);
say(
  `paid ${served.result.paid.requirements.maxAmountRequired} units · receipt ${served.result.receipt.receiptId} · opened ${served.plaintext.length} bytes`,
);
say(/^[\x20-\x7e\s]*$/.test(text) ? `  “${text.slice(0, 200)}”` : "  (binary)");

const { manifest, verdict } = await complianceFile(buyer, disco, [served.result]);
const { writeFileSync } = await import("node:fs");
const file = `buyer-lineage-${grantId.slice(2, 10)}.json`;
writeFileSync(
  file,
  JSON.stringify(manifest, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
);
say(
  `compliance file ${file}: ${verdict.ok ? "verifies" : "FAILS"} (${verdict.assets.length} asset, ${verdict.hashesPerAsset} hashes/asset)`,
);

if (agentId !== undefined) {
  await new Promise((r) => setTimeout(r, 5_000)); // the venue's feedback lands a block or two later
  const rep = await reputation(gatewayUrl, agentId);
  say(
    `reputation of agent #${agentId}: ${rep?.paidQueriesHere ?? "?"} paid quer${rep?.paidQueriesHere === "1" ? "y" : "ies"} credited by this gateway`,
  );
}
