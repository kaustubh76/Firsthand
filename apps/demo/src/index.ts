#!/usr/bin/env node
import {
  createChainClients,
  MemoryBlobStore,
  OnchainAnchorWriter,
  OnchainGrantReader,
  PublicMempoolTransport,
} from "@firsthand/adapters";
import { loadDeployment } from "@firsthand/contracts/deployments";
import {
  type Address,
  AttestationClass,
  type Bytes32,
  LICENSE_FH_1_0,
  Scope,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { loadDotenv } from "@firsthand/runtime/node";
import {
  Batcher,
  BuyerSession,
  createBuyerKeys,
  deposit,
  exportManifest,
  Locker,
  planAttest,
  planDirectRescind,
  planEnroll,
  planGrant,
  publishDeposit,
  publishWrap,
  sendAttest,
  sendEnroll,
  sendGrant,
  sendRescind,
  verifyManifest,
} from "@firsthand/sdk";
import { type Chain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { repoRoot, resolveEnv, startGateway } from "./env.js";

/**
 * The first recall, end to end, as a runnable program: a human deposits data nobody else can prove
 * they own, an agent pays per query to read it, and the human withdraws consent — after which the
 * same query is refused. Everything here is the real path; the gateway is the real gateway and the
 * contracts are the deployed ones. Lifted from the Phase 3 gate so the demo cannot drift from the test.
 */
const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const done = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const note = (msg: string) => console.log(`   \x1b[2m${msg}\x1b[0m`);

async function main(): Promise<void> {
  loadDotenv();
  const env = await resolveEnv(process.argv.slice(2));
  const d = loadDeployment(env.deploymentsFile);
  const explorer = (hash: string) =>
    d.chainId === 10143 ? `https://testnet.monadexplorer.com/tx/${hash}` : hash;

  console.log(`\x1b[1mFIRSTHAND — first recall\x1b[0m  (chain ${d.chainId}, ${env.rpcUrl})`);

  const relayer = createChainClients({
    rpcUrl: env.rpcUrl,
    chain: env.chain as Chain,
    privateKey: env.relayerKey,
  });
  if (!relayer.walletClient) throw new Error("relayer wallet missing");
  const live = await relayer.publicClient.getChainId();
  if (live !== d.chainId) {
    throw new Error(`RPC is chain ${live} but the deployment file describes ${d.chainId}`);
  }

  // A real gateway process, talked to over HTTP exactly as a buyer would.
  const gateway = await startGateway(env, repoRoot(), d.chainId);
  const gatewayUrl = gateway.url;
  // The passport EIP-712 domain: the anchors contract is the verifyingContract (ADR-0002/0009).
  const domain = { chainId: BigInt(d.chainId), verifyingContract: d.PassportAnchors as Address };

  const transport = new PublicMempoolTransport(relayer.walletClient);
  const anchors = new OnchainAnchorWriter({
    address: d.PassportAnchors as Address,
    layout: d.anchorsLayout,
    publicClient: relayer.publicClient,
    walletClient: relayer.walletClient,
  });
  const wait = (hash: Bytes32) => relayer.publicClient.waitForTransactionReceipt({ hash });
  const block = await relayer.publicClient.getBlock();

  // ── 1. a human, rooted in one passkey ───────────────────────────────────────────────────────
  step(1, "Open a locker");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const locker = await Locker.open(
    { kind: "demo", evaluate: async () => new Uint8Array(seed) },
    {
      domain,
      epochs: { genesis: BigInt(d.genesis), length: BigInt(d.epochLength) },
      anchors,
      blobs: new MemoryBlobStore(),
      clock: () => block.timestamp,
      namespaces: [{ ns: 0, label: "demo" }],
    },
  );
  note("every key below derives from one PRF output; nothing is stored but the passkey");
  done(`principal ${locker.principalId}`);

  step(2, "Enroll + attest on chain");
  const registry = d.PrincipalRegistry as Address;
  const enrolled = await sendEnroll(locker, transport, planEnroll(locker, registry));
  await wait(enrolled.txHash);
  const attested = await sendAttest(locker, transport, planAttest(locker, registry));
  await wait(attested.txHash);
  note("relayable: the P-256 signature authorises it, not the sender — the relayer is unlinkable");
  done(`enrolled ${explorer(enrolled.txHash)}`);

  // ── 3. deposit ──────────────────────────────────────────────────────────────────────────────
  step(3, "Deposit a datum");
  const terms: Terms = {
    price: 1_000n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 3,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  };
  const batcher = new Batcher(locker, anchors, 1);
  const secret = "the long tail of human data, licensed per query";
  const r = await deposit(locker, batcher, {
    ns: 0,
    datum: { kind: "bytes", bytes: new TextEncoder().encode(secret) },
    terms,
    attestation: {
      class: AttestationClass.IMPORT,
      capturedAt: 0n,
      sourceTag: ZERO_HASH,
      deviceClass: ZERO_HASH,
      metaHash: ZERO_HASH,
    },
  });
  await publishDeposit({ gatewayUrl }, locker, batcher, r, terms);
  note("sealed client-side; the gateway only ever holds ciphertext and public proofs");
  done(`passport ${r.passportId}`);
  done(`anchored ${explorer(r.anchored?.anchor.txHash ?? "")}`);

  // ── 4. the buyer ────────────────────────────────────────────────────────────────────────────
  step(4, "An agent accepts the terms");
  const buyerAccount = privateKeyToAccount(env.buyerKey);
  const buyer = new BuyerSession({
    keys: createBuyerKeys(
      new Uint8Array(Buffer.from(env.buyerKey.slice(2), "hex")),
      buyerAccount,
      crypto.getRandomValues(new Uint8Array(32)),
    ),
    grantManager: d.GrantManager as Address,
    chainId: BigInt(d.chainId),
    transport,
  });
  await wait(
    await relayer.walletClient.writeContract({
      address: d.USDC as Address,
      abi: usdcAbi,
      functionName: "mint",
      args: [buyerAccount.address, 10_000n],
    }),
  );
  await wait((await buyer.registerCard()).txHash);
  const accept = buyer.acceptTerms(locker.principalId, terms);
  await wait((await accept.send()).txHash);
  note("the buyer signs; the relayer submits — the buyer holds no native balance");
  done(`card ${buyer.cardId}`);

  step(5, "The human grants");
  const plan = planGrant(locker, d.GrantManager as Address, {
    granteeCard: buyer.cardId,
    granteeEncryptionPubKey: buyer.encryptionPubKey,
    ns: 0,
    termsHash: accept.plan.termsHash,
    term: 4n,
  });
  const granted = await sendGrant(locker, transport, plan);
  await wait(granted.txHash);
  await publishWrap({ gatewayUrl }, plan.grantId, plan.wrap);
  note("the vault key is sealed to the buyer's card — the gateway cannot read it");
  done(`grant ${explorer(granted.txHash)}`);

  // ── 6. paid queries ─────────────────────────────────────────────────────────────────────────
  step(6, "The agent pays per query");
  const balanceOf = (who: Address) =>
    relayer.publicClient.readContract({
      address: d.USDC as Address,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [who],
    });
  const payeeBefore = await balanceOf(locker.depositKey(0).address);
  const results = [];
  for (let i = 0; i < 2; i++) {
    const { result, plaintext } = await buyer.queryAndOpen(
      { gatewayUrl, grantId: plan.grantId, passportId: r.passportId },
      domain,
    );
    const opened = new TextDecoder().decode(plaintext);
    if (opened !== secret) throw new Error("demo: the served plaintext did not match");
    results.push(result);
    done(`query ${i + 1}: "${opened}" — receipt ${result.receipt.receiptId.slice(0, 18)}…`);
  }
  const earned = (await balanceOf(locker.depositKey(0).address)) - payeeBefore;
  done(`the human earned ${earned} USDC base units, split on chain`);

  // ── 7. the audit file ───────────────────────────────────────────────────────────────────────
  step(7, "Export the Lineage Manifest");
  const reader = new OnchainGrantReader({
    publicClient: relayer.publicClient,
    grantManager: d.GrantManager as Address,
    principalRegistry: registry,
    receiptLedger: d.ReceiptLedger as Address,
  });
  const epoch = await reader.currentEpoch();
  const last = results[results.length - 1];
  const manifest = exportManifest({
    domain,
    principalId: locker.principalId,
    ns: 0,
    batches: batcher.flushed(),
    finalityDepth: 0,
    ...(last
      ? {
          receipts: new Map([
            [
              r.passportId,
              {
                receiptId: last.receipt.receiptId,
                grantId: plan.grantId,
                payer: buyer.owner,
                ns: 0,
                termsHash: accept.plan.termsHash,
                epoch,
                blockNumber: last.receipt.blockNumber ?? 0n,
                txHash: last.receipt.txHash ?? ZERO_HASH,
              },
            ],
          ]),
        }
      : {}),
  });
  const verdict = await verifyManifest(manifest, {
    anchors,
    headBlock: await relayer.publicClient.getBlockNumber({ cacheTime: 0 }),
  });
  if (!verdict.ok) throw new Error("demo: the manifest failed to verify");
  note("this one file answers per-asset diligence: proof of origin, licence and payment");
  done(`manifest verifies: ${manifest.assets.length} asset(s), ${verdict.ms.toFixed(0)} ms`);

  // ── 8. withdraw consent ─────────────────────────────────────────────────────────────────────
  step(8, "The human withdraws consent");
  const rescinded = await sendRescind(
    locker,
    transport,
    planDirectRescind(
      locker,
      "public",
      {
        grantManager: d.GrantManager as Address,
        rescissions: d.Rescissions as Address,
      },
      plan.grantId,
    ),
  );
  const receipt = await wait(rescinded.txHash);
  done(`rescinded at block ${receipt.blockNumber} — ${explorer(rescinded.txHash)}`);

  step(9, "The same query is now refused");
  const refused = await buyer
    .query({ gatewayUrl, grantId: plan.grantId, passportId: r.passportId })
    .then(() => null)
    .catch((e: { context?: { code?: string; status?: number } }) => e.context ?? {});
  if (refused === null) throw new Error("demo: a rescinded grant still served data");
  done(`refused with ${refused.code} (HTTP ${refused.status}) — no data, no charge`);

  // ── 10. the ledger remembers ────────────────────────────────────────────────────────────────
  step(10, "The Consent Ledger dates the end of consent");
  const res = await fetch(`${gatewayUrl}/v1/principals/${locker.principalId}/timeline`);
  if (!res.ok) throw new Error(`timeline failed (${res.status}): ${await res.text()}`);
  const timeline = (await res.json()) as {
    events: { kind: string; blockNumber: string; grantId: string | null }[];
  };
  for (const e of timeline.events) {
    console.log(`   ${e.kind.padEnd(10)} block ${e.blockNumber}`);
  }
  console.log(
    "\n\x1b[32m\x1b[1mFirst recall complete.\x1b[0m Data was licensed, paid for per query, and the licence ended on chain.\n",
  );
  await gateway.stop();
  await env.cleanup?.();
}

main().catch(async (error: unknown) => {
  console.error("\n\x1b[31mdemo failed\x1b[0m:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
