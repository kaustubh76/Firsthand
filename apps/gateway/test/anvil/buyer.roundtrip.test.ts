import { readFileSync } from "node:fs";
import {
  anvil,
  createChainClients,
  MemoryBlobStore,
  monadTestnet,
  OnchainAnchorWriter,
  OnchainGrantReader,
  PublicMempoolTransport,
} from "@firsthand/adapters";
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
import { noopLogger } from "@firsthand/runtime";
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
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createGateway } from "../../src/server.js";

/**
 * Phase 3 gate (README §16 / S2 in miniature): on a live chain, a principal enrols, attests,
 * deposits and publishes; a buyer registers a card, accepts terms, receives a grant, pays three
 * queries through the real gateway (x402 → RoyaltyRouter.settle → ReceiptLedger), opens the
 * plaintext, and exports a manifest carrying the receipts; the fourth query trips the on-chain
 * rate limit and, after rescission, the next attempt is refused.
 */
const RPC = process.env["ANVIL_RPC_URL"];
const DEPLOYMENTS = process.env["DEPLOYMENTS_FILE"];
const RELAYER = process.env["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;
const BUYER_KEY = (process.env["BUYER_PRIVATE_KEY"] ??
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as `0x${string}`; // anvil #2
const enabled = Boolean(RPC && DEPLOYMENTS && RELAYER);

interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  PassportAnchors: Address;
  GrantManager: Address;
  ReceiptLedger: Address;
  RoyaltyRouter: Address;
  Rescissions: Address;
  USDC: Address;
  genesis: number;
  epochLength: number;
}

const usdcAbi = parseAbi([
  "function mint(address to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);

describe.skipIf(!enabled)("Phase 3 gate: paid queries through the gateway on a live chain", () => {
  let d: Deployment;
  let chain: Chain;

  beforeAll(() => {
    d = JSON.parse(readFileSync(DEPLOYMENTS as string, "utf8")) as Deployment;
    chain = d.chainId === 31337 ? anvil : monadTestnet;
  });

  it("grant → 3 paid queries → receipts → manifest; rate limit; rescission", async () => {
    // Gateway in chain mode with an on-chain settlement relayer.
    const gw = createGateway(
      loadConfig({
        DEPLOYMENTS_FILE: DEPLOYMENTS,
        CHAIN_ID: String(d.chainId),
        MONAD_RPC_URL: RPC,
        SETTLEMENT_MODE: "onchain",
        RELAYER_PRIVATE_KEY: RELAYER,
        RATE_LIMIT_CAPACITY: "1000",
        PUBLIC_URL: "http://gw",
      }),
      { logger: noopLogger },
    );
    const fetchApp = ((input: string | URL | Request, init?: RequestInit) =>
      gw.app.request(String(input).replace("http://gw", ""), init)) as unknown as typeof fetch;

    // Principal side: relayer pays gas for enrol/attest/anchor/grant (all relayable by design).
    const relayer = createChainClients({
      rpcUrl: RPC as string,
      chain,
      privateKey: RELAYER as `0x${string}`,
    });
    if (!relayer.walletClient) throw new Error("relayer wallet");
    const live = await relayer.publicClient.getChainId();
    if (live !== d.chainId) {
      throw new Error(`RPC is chain ${live} but {DEPLOYMENTS_FILE} describes ${d.chainId}`);
    }
    const transport = new PublicMempoolTransport(relayer.walletClient);
    const anchors = new OnchainAnchorWriter({
      address: d.PassportAnchors.toLowerCase() as Address,
      layout: "baseline",
      publicClient: relayer.publicClient,
      walletClient: relayer.walletClient,
    });
    const block = await relayer.publicClient.getBlock();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const locker = await Locker.open(
      { kind: "test", evaluate: async () => new Uint8Array(seed) },
      {
        domain: gw.domain,
        epochs: { genesis: BigInt(d.genesis), length: BigInt(d.epochLength) },
        anchors,
        blobs: new MemoryBlobStore(),
        clock: () => block.timestamp,
        namespaces: [{ ns: 0, label: "gate" }],
      },
    );
    const registry = d.PrincipalRegistry.toLowerCase() as Address;
    const grantManager = d.GrantManager.toLowerCase() as Address;
    const wait = (hash: Bytes32) => relayer.publicClient.waitForTransactionReceipt({ hash });
    await wait((await sendEnroll(locker, transport, planEnroll(locker, registry))).txHash);
    await wait((await sendAttest(locker, transport, planAttest(locker, registry))).txHash);

    const terms: Terms = {
      price: 1_000n,
      licenseId: LICENSE_FH_1_0,
      scope: Scope.TRAIN,
      ns: 0,
      rateLimit: 3,
      payees: [locker.depositKey(0).address],
      weights: [WAD],
    };
    const attestation = {
      class: AttestationClass.IMPORT,
      capturedAt: 0n,
      sourceTag: ZERO_HASH,
      deviceClass: ZERO_HASH,
      metaHash: ZERO_HASH,
    };
    const batcher = new Batcher(locker, anchors, 1);
    const plaintext = new TextEncoder().encode("bought on-chain");
    const r = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: plaintext },
      terms,
      attestation,
    });
    expect(r.anchored?.anchor.txHash).toBeTruthy();
    await publishDeposit({ gatewayUrl: "http://gw", fetch: fetchApp }, locker, batcher, r, terms);

    // Buyer side: it signs (card, terms, EIP-3009) and the relayer submits, since registerCard and
    // acceptTerms are relayable — so the buyer key holds no native balance. Only MockUSDC is minted to it.
    const buyerAccount = privateKeyToAccount(BUYER_KEY);
    const buyer = new BuyerSession({
      keys: createBuyerKeys(
        new Uint8Array(Buffer.from(BUYER_KEY.slice(2), "hex")),
        buyerAccount,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      grantManager,
      chainId: BigInt(d.chainId),
      transport,
      fetch: fetchApp,
    });
    const balanceOf = (who: Address) =>
      relayer.publicClient.readContract({
        address: d.USDC.toLowerCase() as Address,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [who],
      });
    const mintHash = await relayer.walletClient.writeContract({
      address: d.USDC.toLowerCase() as Address,
      abi: usdcAbi,
      functionName: "mint",
      args: [buyerAccount.address, 10_000n],
    });
    await wait(mintHash);
    // Deltas, not absolutes: the buyer account (anvil #2) is shared with the S2 harness on a long-lived node.
    const buyerBefore = await balanceOf(buyerAccount.address);
    const payeeBefore = await balanceOf(locker.depositKey(0).address);
    await wait((await buyer.registerCard()).txHash);
    const accept = buyer.acceptTerms(locker.principalId, terms);
    await wait((await accept.send()).txHash);

    // Grant + wrap publication.
    const plan = planGrant(locker, grantManager, {
      granteeCard: buyer.cardId,
      granteeEncryptionPubKey: buyer.encryptionPubKey,
      ns: 0,
      termsHash: accept.plan.termsHash,
      term: 4n,
    });
    await wait((await sendGrant(locker, transport, plan)).txHash);
    await publishWrap({ gatewayUrl: "http://gw", fetch: fetchApp }, plan.grantId, plan.wrap);

    // Three paid queries.
    const reader = new OnchainGrantReader({
      publicClient: relayer.publicClient,
      grantManager,
      principalRegistry: registry,
      receiptLedger: d.ReceiptLedger.toLowerCase() as Address,
    });
    const receipts = [];
    for (let i = 0; i < 3; i++) {
      const { result, plaintext: opened } = await buyer.queryAndOpen(
        { gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId },
        gw.domain,
      );
      expect(new TextDecoder().decode(opened)).toBe("bought on-chain");
      expect(result.receipt.txHash).toMatch(/^0x/);
      receipts.push(result);
    }
    const epoch = await reader.currentEpoch();
    expect(await reader.queriesThisEpoch(plan.grantId, epoch)).toBe(3);
    expect(buyerBefore - (await balanceOf(buyerAccount.address))).toBe(3_000n);
    expect((await balanceOf(locker.depositKey(0).address)) - payeeBefore).toBe(3_000n);

    // The manifest now carries receipts and verifies against the chain's anchors.
    const last = receipts[2];
    if (!last) throw new Error("receipt");
    const manifest = exportManifest({
      domain: gw.domain,
      principalId: locker.principalId,
      ns: 0,
      batches: batcher.flushed(),
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
      finalityDepth: 0,
    });
    expect(manifest.assets[0]?.receipt?.receiptId).toBe(last.receipt.receiptId);
    const verdict = await verifyManifest(manifest, {
      anchors,
      headBlock: await relayer.publicClient.getBlockNumber({ cacheTime: 0 }),
    });
    expect(verdict.ok).toBe(true);

    // Fourth query: the on-chain rate limit (3 per epoch) refuses settlement — no receipt, no charge.
    await expect(
      buyer.query({ gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId }),
    ).rejects.toMatchObject({ context: { status: 502 } });
    expect(await reader.queriesThisEpoch(plan.grantId, epoch)).toBe(3);

    // Rescind (direct path over the public transport here; BTX is Phase 4) → refused before payment.
    await wait(
      (
        await sendRescind(
          locker,
          transport,
          planDirectRescind(
            locker,
            "public",
            { grantManager, rescissions: d.Rescissions.toLowerCase() as Address },
            plan.grantId,
          ),
        )
      ).txHash,
    );
    await expect(
      buyer.query({ gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId }),
    ).rejects.toMatchObject({ context: { code: "FH_GRANT_RESCINDED", status: 403 } });
    buyer.close();
    locker.dispose();
  });
});
