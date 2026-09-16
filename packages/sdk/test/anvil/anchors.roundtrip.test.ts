import { readFileSync } from "node:fs";
import {
  anvil,
  createChainClients,
  MemoryBlobStore,
  monadTestnet,
  OnchainAnchorWriter,
  PublicMempoolTransport,
} from "@firsthand/adapters";
import {
  type Address,
  AttestationClass,
  ChainError,
  domainSeparator,
  LICENSE_FH_1_0,
  Scope,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { KeyTree, StaticPrfSource } from "@firsthand/crypto";
import type { Chain } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { Batcher } from "../../src/batch/Batcher.js";
import { Locker } from "../../src/locker/Locker.js";
import { exportManifest } from "../../src/manifest/export.js";
import { verifyManifest } from "../../src/manifest/verify.js";
import { planAttest, sendAttest } from "../../src/verbs/attest.js";
import { deposit } from "../../src/verbs/deposit.js";
import { planEnroll, sendEnroll } from "../../src/verbs/enroll.js";

/**
 * Phase 2 gate: deposit → batch → anchor on a live chain, for BOTH storage layouts, then prove
 * inclusion on-chain and verify a manifest against the chain's anchors. A foreign locker's anchor
 * is refused by the contract with a decoded reason.
 */
const RPC = process.env["ANVIL_RPC_URL"];
const DEPLOYMENTS = process.env["DEPLOYMENTS_FILE"];
const RELAYER = process.env["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;
const enabled = Boolean(RPC && DEPLOYMENTS && RELAYER);

interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  PassportAnchorsBaseline: Address;
  PassportAnchorsPaged: Address;
  genesis: number;
  epochLength: number;
}

describe.skipIf(!enabled)("Phase 2 gate: deposit → anchor → on-chain inclusion", () => {
  let deployment: Deployment;
  let clients: ReturnType<typeof createChainClients>;
  let transport: PublicMempoolTransport;

  beforeAll(async () => {
    deployment = JSON.parse(readFileSync(DEPLOYMENTS as string, "utf8")) as Deployment;
    const chain: Chain = deployment.chainId === 31337 ? anvil : monadTestnet;
    clients = createChainClients({
      rpcUrl: RPC as string,
      chain,
      privateKey: RELAYER as `0x${string}`,
    });
    if (!clients.walletClient) throw new Error("relayer wallet missing");
    const live = await clients.publicClient.getChainId();
    if (live !== deployment.chainId) {
      throw new Error(
        `RPC is chain ${live} but {DEPLOYMENTS_FILE} describes ${deployment.chainId}`,
      );
    }
    transport = new PublicMempoolTransport(clients.walletClient);
  });

  async function freshLocker(
    anchorsAddress: Address,
    writer: OnchainAnchorWriter,
  ): Promise<Locker> {
    StaticPrfSource.resetWarning();
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const keys = await KeyTree.fromSource(
      new StaticPrfSource(seed, { unsafeAcknowledged: true, warn: () => {} }),
    );
    const block = await clients.publicClient.getBlock();
    return new Locker({
      keys,
      domain: { chainId: BigInt(deployment.chainId), verifyingContract: anchorsAddress },
      epochs: { genesis: BigInt(deployment.genesis), length: BigInt(deployment.epochLength) },
      anchors: writer,
      blobs: new MemoryBlobStore(),
      clock: () => block.timestamp,
      namespaces: [{ ns: 0, label: "roundtrip" }],
    });
  }

  async function enrolAndAttest(locker: Locker): Promise<void> {
    const registry = deployment.PrincipalRegistry.toLowerCase() as Address;
    const e = await sendEnroll(locker, transport, planEnroll(locker, registry));
    await clients.publicClient.waitForTransactionReceipt({ hash: e.txHash });
    const a = await sendAttest(locker, transport, planAttest(locker, registry));
    await clients.publicClient.waitForTransactionReceipt({ hash: a.txHash });
  }

  const termsFor = (locker: Locker): Terms => ({
    price: 1n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 100,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  });
  const attestation = {
    class: AttestationClass.IMPORT,
    capturedAt: 0n,
    sourceTag: ZERO_HASH,
    deviceClass: ZERO_HASH,
    metaHash: ZERO_HASH,
  };

  for (const layout of ["baseline", "paged"] as const) {
    it(`${layout}: anchors two batches through the contract and proves inclusion on-chain`, async () => {
      const address = (
        layout === "paged" ? deployment.PassportAnchorsPaged : deployment.PassportAnchorsBaseline
      ).toLowerCase() as Address;
      if (!clients.walletClient) throw new Error("wallet");
      const writer = new OnchainAnchorWriter({
        address,
        layout,
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
      });
      expect(writer.canWrite).toBe(true);
      const locker = await freshLocker(address, writer);
      expect(await writer.domainSeparator()).toBe(domainSeparator(locker.domain));
      await enrolAndAttest(locker);

      const batcher = new Batcher(locker, writer, 2);
      const terms = termsFor(locker);
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          await deposit(locker, batcher, {
            ns: 0,
            datum: { kind: "bytes", bytes: new Uint8Array([layout.length, i]) },
            terms,
            attestation,
          }),
        );
      }
      expect(results[1]?.anchored).not.toBeNull(); // batch of 2 flushed automatically
      expect(results[1]?.anchored?.anchor.gasUsed).toBeGreaterThan(0n);
      const late = await batcher.flush(); // the third passport, anchored on its own
      expect(late).toHaveLength(1);
      expect(batcher.flushed()).toHaveLength(2);
      expect(batcher.flushed().map((b) => b.anchor.batchIndex)).toEqual([0, 1]);

      for (const r of results) {
        const found = batcher.proofFor(r.passportId);
        if (!found) throw new Error("missing proof");
        expect(await writer.isAnchored(found.batch.root)).toBe(true);
        expect(await writer.isIncluded(found.batch.root, r.passportId, found.proof)).toBe(true);
        expect(
          await writer.isIncluded(found.batch.root, r.passportId, {
            ...found.proof,
            index: (found.proof.index + 1) % 256,
          }),
        ).toBe(false);
      }
      const record = await writer.anchorOf(batcher.flushed()[0]?.root as `0x${string}`);
      expect(record?.principalId).toBe(locker.principalId);
      expect(record?.ns).toBe(0);

      // Offline manifest verification against the chain's anchors (H3 path, on-chain root source).
      const manifest = exportManifest({
        domain: locker.domain,
        principalId: locker.principalId,
        ns: 0,
        batches: batcher.flushed(),
        finalityDepth: 0,
      });
      const head = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
      const verdict = await verifyManifest(manifest, { anchors: writer, headBlock: head });
      expect(verdict.assets.map((a) => a.reason ?? "ok")).toEqual(["ok", "ok", "ok"]);
      expect(verdict.ok).toBe(true);
      expect(verdict.assets).toHaveLength(3);
    });
  }

  it("refuses a foreign locker's anchor with a decoded contract error (S4, on-chain half)", async () => {
    const address = deployment.PassportAnchorsBaseline.toLowerCase() as Address;
    if (!clients.walletClient) throw new Error("wallet");
    const writer = new OnchainAnchorWriter({
      address,
      layout: "baseline",
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
    });
    const intruder = await freshLocker(address, writer); // never enrolled/attested
    const batcher = new Batcher(intruder, writer, 1);
    const terms = termsFor(intruder);
    await expect(
      deposit(intruder, batcher, {
        ns: 0,
        datum: { kind: "bytes", bytes: new Uint8Array([9]) },
        terms,
        attestation,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.context["reason"] === "EpochNotAttested",
    );

    // Enrolled principal, but the anchor is signed by someone else's deposit key: the contract still refuses.
    const owner = await freshLocker(address, writer);
    await enrolAndAttest(owner);
    const forged = {
      principalId: owner.principalId,
      ns: 0,
      epoch: owner.currentEpoch(),
      batchRoot: `0x${"77".repeat(32)}` as const,
      termsHash: ZERO_HASH,
      nonce: `0x${"01".repeat(32)}` as const,
      depositKeys: owner.depositAddresses(),
      depositSig: (await import("@firsthand/crypto")).signPassportDigest(
        intruder.depositKey(0).privateKey,
        (await import("@firsthand/core")).authorityDigest(
          (await import("@firsthand/core")).anchorStructHash({
            principalId: owner.principalId,
            ns: 0,
            epoch: owner.currentEpoch(),
            batchRoot: `0x${"77".repeat(32)}`,
            termsHash: ZERO_HASH,
            nonce: `0x${"01".repeat(32)}`,
          }),
          owner.domain,
        ),
      ),
    };
    await expect(writer.anchor(forged)).rejects.toSatisfy(
      (e: unknown) => e instanceof ChainError && e.context["reason"] === "InvalidDepositSignature",
    );
    expect(await writer.isAnchored(forged.batchRoot)).toBe(false);
  });

  it("read-only writer refuses to write", async () => {
    const ro = new OnchainAnchorWriter({
      address: deployment.PassportAnchorsBaseline.toLowerCase() as Address,
      layout: "baseline",
      publicClient: clients.publicClient,
    });
    expect(ro.canWrite).toBe(false);
    await expect(ro.anchor({} as never)).rejects.toThrow(/read-only/);
  });
});
