import { readFileSync } from "node:fs";
import {
  anvil,
  createChainClients,
  MemoryAnchorWriter,
  MemoryBlobStore,
  monadTestnet,
  PublicMempoolTransport,
} from "@firsthand/adapters";
import { PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import { type Address, type Bytes32, depositKeysRoot, PrincipalStatus } from "@firsthand/core";
import { KeyTree, StaticPrfSource } from "@firsthand/crypto";
import { type Chain, decodeErrorResult } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { ContractReaders } from "../../src/contracts/readers.js";
import { Locker } from "../../src/locker/Locker.js";
import { planAttest, sendAttest } from "../../src/verbs/attest.js";
import { planEnroll, sendEnroll } from "../../src/verbs/enroll.js";

/**
 * Phase 1 gate (README §16): ceremony → on-chain enroll round-trip through the real contract path,
 * with the P-256 signature verified by the chain's precompile rather than a test double.
 *
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 DEPLOYMENTS_FILE=deployments/31337.json \
 *   RELAYER_PRIVATE_KEY=0x… pnpm --filter @firsthand/sdk test:anvil
 */
const RPC = process.env["ANVIL_RPC_URL"];
const DEPLOYMENTS = process.env["DEPLOYMENTS_FILE"];
const RELAYER = process.env["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;
const enabled = Boolean(RPC && DEPLOYMENTS && RELAYER);

interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  GrantManager: Address;
  Rescissions: Address;
  PassportAnchors: Address;
  FirsthandLens: Address;
  genesis: number;
  epochLength: number;
}

describe.skipIf(!enabled)("Phase 1 gate: enroll → attest round-trip on a live chain", () => {
  let deployment: Deployment;
  let clients: ReturnType<typeof createChainClients>;
  let readers: ContractReaders;
  let transport: PublicMempoolTransport;
  let locker: Locker;
  let registry: Address;

  beforeAll(async () => {
    deployment = JSON.parse(readFileSync(DEPLOYMENTS as string, "utf8")) as Deployment;
    const chain: Chain = deployment.chainId === 31337 ? anvil : monadTestnet;
    clients = createChainClients({
      rpcUrl: RPC as string,
      chain,
      privateKey: RELAYER as `0x${string}`,
    });
    if (!clients.walletClient) throw new Error("relayer wallet missing");
    transport = new PublicMempoolTransport(clients.walletClient);
    registry = deployment.PrincipalRegistry.toLowerCase() as Address;
    readers = new ContractReaders(clients.publicClient, {
      principalRegistry: registry,
      grantManager: deployment.GrantManager.toLowerCase() as Address,
      firsthandLens: deployment.FirsthandLens.toLowerCase() as Address,
      passportAnchors: deployment.PassportAnchors.toLowerCase() as Address,
      rescissions: deployment.Rescissions.toLowerCase() as Address,
    });

    // A fresh, unique principal per run: demo PRF from the relayer nonce + time (never a passkey).
    StaticPrfSource.resetWarning();
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const keys = await KeyTree.fromSource(
      new StaticPrfSource(seed, { unsafeAcknowledged: true, warn: () => {} }),
    );
    const block = await clients.publicClient.getBlock();
    locker = new Locker({
      keys,
      domain: {
        chainId: BigInt(deployment.chainId),
        verifyingContract: deployment.PassportAnchors.toLowerCase() as Address,
      },
      epochs: { genesis: BigInt(deployment.genesis), length: BigInt(deployment.epochLength) },
      anchors: new MemoryAnchorWriter(),
      blobs: new MemoryBlobStore(),
      clock: () => block.timestamp,
    });
  });

  it("agrees with the chain on epoch and domain before signing anything", async () => {
    expect(await readers.registryEpoch()).toBe(locker.currentEpoch());
    const onChain = await readers.registryDomainSeparator();
    // core's domainSeparator over the registry address must equal what the contract computes.
    const { domainSeparator } = await import("@firsthand/core");
    expect(domainSeparator(locker.authorityDomain(registry))).toBe(onChain);
  });

  it("enrolls: the precompile verifies the passkey-derived authority signature", async () => {
    expect(await readers.principalStatus(locker.principalId)).toBe(PrincipalStatus.NONE);
    const plan = planEnroll(locker, registry);
    const sent = await sendEnroll(locker, transport, plan);
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
    expect(receipt.status).toBe("success");

    const p = await readers.principal(locker.principalId);
    expect(p.p256KeyCommit).toBe(locker.principalId);
    expect(p.lastAttestedEpoch).toBe(plan.epoch);
    expect(await readers.isLive(locker.principalId)).toBe(true);
    expect(await readers.principalStatus(locker.principalId)).toBe(PrincipalStatus.ACTIVE);
  });

  it("attests: publishes the 16 deposit addresses as one commitment", async () => {
    const plan = planAttest(locker, registry);
    const sent = await sendAttest(locker, transport, plan);
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
    expect(receipt.status).toBe("success");
    expect(await readers.depositKeysRoot(locker.principalId, plan.epoch)).toBe(
      plan.depositKeysRoot,
    );
    expect(plan.depositKeysRoot).toBe(depositKeysRoot(locker.depositAddresses(plan.epoch)));
  });

  it("refuses a second enrolment and a replayed attestation with the documented errors", async () => {
    const again = planEnroll(locker, registry);
    await expect(
      clients.publicClient.call({ to: again.tx.to, data: again.tx.data }),
    ).rejects.toSatisfy((error: unknown) => {
      const data = extractRevertData(error);
      if (!data) return false;
      const decoded = decodeErrorResult({ abi: PrincipalRegistryAbi, data });
      return (
        decoded.errorName === "AlreadyEnrolled" &&
        (decoded.args as readonly Bytes32[])[0] === locker.principalId
      );
    });
    const attestAgain = planAttest(locker, registry);
    await expect(
      clients.publicClient.call({ to: attestAgain.tx.to, data: attestAgain.tx.data }),
    ).rejects.toSatisfy((error: unknown) => {
      const data = extractRevertData(error);
      return (
        data !== null &&
        decodeErrorResult({ abi: PrincipalRegistryAbi, data }).errorName === "AlreadyAttested"
      );
    });
  });
});

function extractRevertData(error: unknown): `0x${string}` | null {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth++) {
    const data = (cursor as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length > 10)
      return data as `0x${string}`;
    const raw = (cursor as { raw?: unknown }).raw;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length > 10)
      return raw as `0x${string}`;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}
