import { readFileSync } from "node:fs";
import {
  anvil,
  BtxTransport,
  createChainClients,
  MemoryBlobStore,
  monadTestnet,
  OnchainAnchorWriter,
  OnchainGrantReader,
  PublicMempoolTransport,
} from "@firsthand/adapters";
import { GrantManagerAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  type Bytes32,
  GrantStatus,
  LICENSE_FH_1_0,
  Scope,
  type Terms,
  WAD,
} from "@firsthand/core";
import { KeyTree, StaticPrfSource } from "@firsthand/crypto";
import { type Chain, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { BuyerSession, createBuyerKeys } from "../../src/client/BuyerSession.js";
import { Locker } from "../../src/locker/Locker.js";
import { planAttest, sendAttest } from "../../src/verbs/attest.js";
import { planEnroll, sendEnroll } from "../../src/verbs/enroll.js";
import { planGrant, sendGrant } from "../../src/verbs/grant.js";
import {
  planCommit,
  planDirectRescind,
  planRevealRescind,
  sendRescind,
} from "../../src/verbs/rescind.js";

/**
 * Phase 4 gate (SDK half): the BTX transport's sign → seal → post path is exercised end to end by
 * pointing it at the plain node with `eth_sendRawTransaction` as the method — the contract cannot
 * tell the difference, which is the point (BTX is a transport property, ADR-0006). With the default
 * (unconfirmed) method the same transport refuses, and a mismatched plan is refused before any send.
 * Commit-reveal is proven as the fallback that works on every node.
 */
const RPC = process.env["ANVIL_RPC_URL"];
const DEPLOYMENTS = process.env["DEPLOYMENTS_FILE"];
const RELAYER = process.env["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;
const enabled = Boolean(RPC && DEPLOYMENTS && RELAYER);
const BUYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const; // anvil #2

interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  PassportAnchorsBaseline: Address;
  GrantManager: Address;
  Rescissions: Address;
  ReceiptLedger: Address;
  genesis: number;
  epochLength: number;
  revealWindowBlocks: number;
}

describe.skipIf(!enabled)(
  "Phase 4 gate: rescission over BTX-shaped and commit-reveal paths",
  () => {
    let d: Deployment;
    let clients: ReturnType<typeof createChainClients>;
    let chain: Chain;
    let publicTransport: PublicMempoolTransport;
    let locker: Locker;
    let addresses: { grantManager: Address; rescissions: Address; principalRegistry: Address };
    let reader: OnchainGrantReader;
    let terms: Terms;
    let termsHash: Bytes32;
    let buyer: BuyerSession;
    const wait = (hash: Bytes32) => clients.publicClient.waitForTransactionReceipt({ hash });

    beforeAll(async () => {
      d = JSON.parse(readFileSync(DEPLOYMENTS as string, "utf8")) as Deployment;
      chain = d.chainId === 31337 ? anvil : monadTestnet;
      clients = createChainClients({
        rpcUrl: RPC as string,
        chain,
        privateKey: RELAYER as `0x${string}`,
      });
      if (!clients.walletClient) throw new Error("relayer wallet missing");
      publicTransport = new PublicMempoolTransport(clients.walletClient);
      addresses = {
        grantManager: d.GrantManager.toLowerCase() as Address,
        rescissions: d.Rescissions.toLowerCase() as Address,
        principalRegistry: d.PrincipalRegistry.toLowerCase() as Address,
      };
      reader = new OnchainGrantReader({
        publicClient: clients.publicClient,
        grantManager: addresses.grantManager,
        principalRegistry: addresses.principalRegistry,
        receiptLedger: d.ReceiptLedger.toLowerCase() as Address,
      });

      StaticPrfSource.resetWarning();
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const keys = await KeyTree.fromSource(
        new StaticPrfSource(seed, { unsafeAcknowledged: true, warn: () => {} }),
      );
      const block = await clients.publicClient.getBlock();
      const anchorsAddress = d.PassportAnchorsBaseline.toLowerCase() as Address;
      locker = new Locker({
        keys,
        domain: { chainId: BigInt(d.chainId), verifyingContract: anchorsAddress },
        epochs: { genesis: BigInt(d.genesis), length: BigInt(d.epochLength) },
        anchors: new OnchainAnchorWriter({
          address: anchorsAddress,
          layout: "baseline",
          publicClient: clients.publicClient,
          walletClient: clients.walletClient,
        }),
        blobs: new MemoryBlobStore(),
        clock: () => block.timestamp,
        namespaces: [
          { ns: 0, label: "rescind" },
          { ns: 1, label: "rescind-commit-reveal" },
        ],
      });
      await wait(
        (await sendEnroll(locker, publicTransport, planEnroll(locker, addresses.principalRegistry)))
          .txHash,
      );
      await wait(
        (await sendAttest(locker, publicTransport, planAttest(locker, addresses.principalRegistry)))
          .txHash,
      );

      terms = {
        price: 1_000n,
        licenseId: LICENSE_FH_1_0,
        scope: Scope.TRAIN,
        ns: 0,
        rateLimit: 0,
        payees: [locker.depositKey(0).address],
        weights: [WAD],
      };
      const buyerClients = createChainClients({
        rpcUrl: RPC as string,
        chain,
        privateKey: BUYER_KEY,
      });
      if (!buyerClients.walletClient) throw new Error("buyer wallet");
      buyer = new BuyerSession({
        keys: createBuyerKeys(
          new Uint8Array(Buffer.from(BUYER_KEY.slice(2), "hex")),
          privateKeyToAccount(BUYER_KEY),
          crypto.getRandomValues(new Uint8Array(32)),
        ),
        grantManager: addresses.grantManager,
        chainId: BigInt(d.chainId),
        transport: new PublicMempoolTransport(buyerClients.walletClient),
      });
      await wait((await buyer.registerCard()).txHash);
      const accept = buyer.acceptTerms(locker.principalId, terms);
      await wait((await accept.send()).txHash);
      termsHash = accept.plan.termsHash;
    });

    /** A fresh grant per case: grantId = keccak(principal, card, ns, epochStart), so vary the namespace. */
    async function freshGrant(ns: 0 | 1): Promise<Bytes32> {
      let hash = termsHash;
      if (ns !== 0) {
        // The buyer accepts the same terms under another namespace so a second grant id exists this epoch.
        const accept = buyer.acceptTerms(locker.principalId, { ...terms, ns });
        await wait((await accept.send()).txHash);
        hash = accept.plan.termsHash;
      }
      const plan = planGrant(locker, addresses.grantManager, {
        granteeCard: buyer.cardId,
        granteeEncryptionPubKey: buyer.encryptionPubKey,
        ns,
        termsHash: hash,
        term: 4n,
      });
      await wait((await sendGrant(locker, publicTransport, plan)).txHash);
      expect(await reader.effectiveStatus(plan.grantId)).toBe(GrantStatus.ACTIVE);
      return plan.grantId;
    }

    it("a btx plan travels the BTX transport (sign → seal → post) and the contract records the rescission", async () => {
      if (!clients.walletClient) throw new Error("relayer wallet missing");
      const grantId = await freshGrant(0);
      const sealed: string[] = [];
      // Method override: the plain node accepts the sealed (identity) raw tx as an ordinary submission.
      const btx = new BtxTransport({
        rpcUrl: RPC as string,
        wallet: clients.walletClient,
        method: "eth_sendRawTransaction",
        seal: async (raw) => {
          sealed.push(raw);
          return raw;
        },
      });
      expect((await btx.capabilities()).encryptedMempool).toBe(true);

      // A public plan cannot ride it, and nothing is sent.
      await expect(
        sendRescind(locker, btx, planDirectRescind(locker, "public", addresses, grantId)),
      ).rejects.toMatchObject({ code: "FH_VALIDATION" });
      expect(sealed).toHaveLength(0);

      const sent = await sendRescind(
        locker,
        btx,
        planDirectRescind(locker, "btx", addresses, grantId),
      );
      expect(sent.encryptedMempool).toBe(true);
      expect(sealed).toHaveLength(1);
      const receipt = await wait(sent.txHash);
      expect(receipt.status).toBe("success");
      const rescinded = receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: GrantManagerAbi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "GrantRescinded");
      expect(rescinded?.args).toMatchObject({ grantId, viaCommitReveal: false });
      expect((rescinded?.args as { effectiveBlock?: bigint } | undefined)?.effectiveBlock).toBe(
        receipt.blockNumber,
      );
      expect(await reader.effectiveStatus(grantId)).toBe(GrantStatus.RESCINDED);
    });

    it("the default (unconfirmed) BTX method is refused by the probe — no silent downgrade", async () => {
      if (!clients.walletClient) throw new Error("relayer wallet missing");
      const btx = new BtxTransport({ rpcUrl: RPC as string, wallet: clients.walletClient });
      const caps = await btx.capabilities();
      expect(caps.encryptedMempool).toBe(false);
      expect(caps.detail).toContain("not supported");
      await expect(
        sendRescind(
          locker,
          btx,
          planDirectRescind(locker, "btx", addresses, `0x${"ee".repeat(32)}`),
        ),
      ).rejects.toMatchObject({ code: "FH_BTX_UNAVAILABLE" });
    });

    it("commit-reveal works on any node: commit over the public mempool, reveal within the window, effective at the commit block", async () => {
      const grantId = await freshGrant(1);
      const commit = planCommit(addresses, grantId);
      const committed = await sendRescind(locker, publicTransport, commit);
      const commitReceipt = await wait(committed.txHash);
      // The grant is still ACTIVE on chain between commit and reveal (the ledger dates consent's end to the commit).
      expect(await reader.effectiveStatus(grantId)).toBe(GrantStatus.ACTIVE);
      if (!commit.salt) throw new Error("salt");
      const revealed = await sendRescind(
        locker,
        publicTransport,
        planRevealRescind(locker, addresses, grantId, commit.salt),
      );
      const revealReceipt = await wait(revealed.txHash);
      expect(revealReceipt.status).toBe("success");
      const event = revealReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: GrantManagerAbi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "GrantRescinded");
      expect(event?.args).toMatchObject({ grantId, viaCommitReveal: true });
      expect((event?.args as { effectiveBlock?: bigint } | undefined)?.effectiveBlock).toBe(
        commitReceipt.blockNumber,
      );
      expect(revealReceipt.blockNumber - commitReceipt.blockNumber).toBeLessThanOrEqual(
        BigInt(d.revealWindowBlocks),
      );
      expect(await reader.effectiveStatus(grantId)).toBe(GrantStatus.RESCINDED);
    });
  },
);
