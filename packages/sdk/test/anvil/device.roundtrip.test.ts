import { readFileSync } from "node:fs";
import {
  anvil,
  createChainClients,
  MemoryAnchorWriter,
  MemoryBlobStore,
  monadTestnet,
  OnchainDeviceRegistryReader,
  PublicMempoolTransport,
} from "@firsthand/adapters";
import { HardwareDeviceRegistryAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  type Bytes32,
  type Hex,
  hardwareCaptureDigest,
  hexToBytes,
  type P256PublicKey,
  PrincipalStatus,
  SecurityLevel,
  VerifiedBootState,
} from "@firsthand/core";
import {
  type AuthorityKey,
  type KeyProvider,
  KeyTree,
  SecretBytes,
  signAuthorityDigest,
} from "@firsthand/crypto";
import { loadVectors } from "@firsthand/test-vectors";
import { type Chain, decodeErrorResult, encodeFunctionData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ContractReaders } from "../../src/contracts/readers.js";
import { Locker } from "../../src/locker/Locker.js";
import {
  planRegisterDevice,
  planRevokeDevice,
  sendRegisterDevice,
  sendRevokeDevice,
} from "../../src/verbs/device.js";
import { planEnroll, sendEnroll } from "../../src/verbs/enroll.js";

/**
 * ADR-0015 on a chain: register a secure element, have the **contract** verify a capture witness,
 * replay that witness under a second locker and watch the contract refuse it, then revoke and
 * watch it refuse the genuine one too.
 *
 * The three contracts are at 100% line and branch coverage in Foundry, and that proves they parse
 * DER — it does not prove the RIP-7212 precompile verifies this chain, that the relay carries the
 * calldata, or that `OnchainDeviceRegistryReader` reads back what was written. Those are the four
 * seams between a library and a product, and they only exist on a chain.
 *
 * `Deploy.s.sol:108-114` anchors the local registry to the golden suite's `extra.anchorCommitment`
 * precisely so this can run. The certificates are generated, not pulled off a handset — what is
 * being proved here is the plumbing and the precompile, not the device.
 *
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 DEPLOYMENTS_FILE=deployments/31337.json \
 *   RELAYER_PRIVATE_KEY=0x… pnpm --filter @firsthand/sdk test:anvil
 */
const RPC = process.env["ANVIL_RPC_URL"];
const DEPLOYMENTS = process.env["DEPLOYMENTS_FILE"];
const RELAYER = process.env["RELAYER_PRIVATE_KEY"] as `0x${string}` | undefined;

const vectors = loadVectors("android-attestation", {
  input: z.object({ certificate: z.string() }),
  expected: z.record(z.string(), z.unknown()),
  extra: z.object({
    anchorCommitment: z.string(),
    authorityScalar: z.string(),
    authorityX: z.string(),
    authorityY: z.string(),
    chain: z.array(z.string()),
    deviceCommitment: z.string(),
    deviceScalar: z.string(),
    deviceX: z.string(),
    deviceY: z.string(),
    nonce: z.string(),
    principalId: z.string(),
  }),
});
const E = vectors.extra;

interface Deployment {
  chainId: number;
  PrincipalRegistry: Address;
  GrantManager: Address;
  Rescissions: Address;
  PassportAnchors: Address;
  FirsthandLens: Address;
  HardwareDeviceRegistry?: Address;
  genesis: number;
  epochLength: number;
}

const deploymentDoc: Deployment | null = DEPLOYMENTS
  ? (JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployment)
  : null;
// An older deployment document names no registry, and a suite that silently passed against one
// would be the sort of green this repository keeps catching itself on.
const enabled = Boolean(RPC && deploymentDoc?.HardwareDeviceRegistry && RELAYER);

/**
 * A real key tree with one substitution: the authority key the fixture's certificate names.
 *
 * The challenge is baked into a signed certificate that cannot be reissued, so the locker has to
 * come to the chain rather than the other way round — a freshly seeded principal could never
 * register this device. The same shape as the unit tier's helper in `sdk.test.ts`; both are
 * pinned by the vector file, so they fail together if it changes.
 */
class VectorKeys implements KeyProvider {
  readonly #inner = KeyTree.fromPrf(new Uint8Array(32).fill(5));
  readonly #authority: AuthorityKey;
  constructor() {
    const publicKey: P256PublicKey = { x: E.authorityX as Bytes32, y: E.authorityY as Bytes32 };
    this.#authority = {
      scalar: new SecretBytes(hexToBytes(E.authorityScalar as Hex), "k_id"),
      publicKey,
      commitment: E.principalId as Bytes32,
    };
  }
  authorityKey() {
    return this.#authority;
  }
  vaultKey(ns: number, epoch: bigint) {
    return this.#inner.vaultKey(ns, epoch);
  }
  depositKey(ns: number, epoch: bigint) {
    return this.#inner.depositKey(ns, epoch);
  }
  nonceKey(ns: number, epoch: bigint) {
    return this.#inner.nonceKey(ns, epoch);
  }
  passportNonce(ns: number, epoch: bigint, h: Bytes32) {
    return this.#inner.passportNonce(ns, epoch, h);
  }
  dispose() {
    this.#inner.dispose();
  }
}

describe.skipIf(!enabled)(
  "ADR-0015: register → witness → transplant → revoke, on a live chain",
  () => {
    const deployment = deploymentDoc as Deployment;
    const chain: Chain = deployment?.chainId === 31337 ? anvil : monadTestnet;
    const registryAddress = (deployment?.HardwareDeviceRegistry?.toLowerCase() ?? "0x") as Address;
    const principals = (deployment?.PrincipalRegistry?.toLowerCase() ?? "0x") as Address;
    const nonce = E.nonce as Bytes32;
    const keyCommitment = E.deviceCommitment as Bytes32;
    const certChain = E.chain.map((hex) => hexToBytes(hex as Hex));

    let snapshot: `0x${string}` | null = null;
    let clients: ReturnType<typeof createChainClients>;
    let readers: ContractReaders;
    let reader: OnchainDeviceRegistryReader;
    let transport: PublicMempoolTransport;
    let locker: Locker;

    /** A genuine witness: the attested key signing a capture made under this locker's origin. */
    const capture = (origin: Address, captureNonce: Bytes32) =>
      hardwareCaptureDigest({
        chainId: BigInt(deployment.chainId),
        origin,
        contentHash: `0x${"c0".repeat(32)}`,
        capturedAt: 1_790_000_000n,
        nonce: captureNonce,
        deviceClass: keyCommitment,
      });

    /**
     * `registerDevice` calldata built without the client's local pass, so a test can reach a revert
     * the client would refuse to produce. The signature is a placeholder: every error asserted
     * against this sits *before* the signature check in the contract's order.
     */
    const register = (withNonce: Bytes32): Hex =>
      encodeFunctionData({
        abi: HardwareDeviceRegistryAbi,
        functionName: "registerDevice",
        args: [locker.principalId, E.chain as Hex[], withNonce, `0x${"00".repeat(64)}`],
      });

    const verifyOnChain = (digest: Bytes32, signature: Hex): Promise<boolean> =>
      clients.publicClient.readContract({
        address: registryAddress,
        abi: HardwareDeviceRegistryAbi,
        functionName: "verifyCapture",
        args: [keyCommitment, digest, signature],
      });

    beforeAll(async () => {
      clients = createChainClients({
        rpcUrl: RPC as string,
        chain,
        privateKey: RELAYER as `0x${string}`,
      });
      if (!clients.walletClient) throw new Error("relayer wallet missing");
      const live = await clients.publicClient.getChainId();
      if (live !== deployment.chainId) {
        throw new Error(
          `RPC is chain ${live} but DEPLOYMENTS_FILE describes ${deployment.chainId}`,
        );
      }
      transport = new PublicMempoolTransport(clients.walletClient);
      reader = new OnchainDeviceRegistryReader({
        publicClient: clients.publicClient,
        hardwareDeviceRegistry: registryAddress,
      });
      readers = new ContractReaders(clients.publicClient, {
        principalRegistry: principals,
        grantManager: deployment.GrantManager.toLowerCase() as Address,
        firsthandLens: deployment.FirsthandLens.toLowerCase() as Address,
        passportAnchors: deployment.PassportAnchors.toLowerCase() as Address,
        rescissions: deployment.Rescissions.toLowerCase() as Address,
      });

      // Every other suite here sidesteps replay by seeding a fresh principal per run. This one
      // cannot: the principal is named inside a signed certificate that cannot be reissued, so a
      // second run against a persistent anvil would find its one device already registered and
      // revoked. Rewind the chain afterwards rather than teaching the assertions to look away.
      snapshot = await devRpc("evm_snapshot");

      const block = await clients.publicClient.getBlock();
      locker = new Locker({
        keys: new VectorKeys(),
        domain: {
          chainId: BigInt(deployment.chainId),
          verifyingContract: deployment.PassportAnchors.toLowerCase() as Address,
        },
        epochs: { genesis: BigInt(deployment.genesis), length: BigInt(deployment.epochLength) },
        anchors: new MemoryAnchorWriter(),
        blobs: new MemoryBlobStore(),
        clock: () => block.timestamp,
      });

      // The fixture principal is fixed by the certificate, so a re-run against a persistent anvil
      // finds it already enrolled. That is not a failure — registration is what this suite is about.
      if ((await readers.principalStatus(locker.principalId)) === PrincipalStatus.NONE) {
        const sent = await sendEnroll(locker, transport, planEnroll(locker, principals));
        await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
      }
    });

    afterAll(async () => {
      if (snapshot === null) return;
      await devRpc("evm_revert", [snapshot]);
      // A revert rewinds the clock *and* stops anvil tracking wall-clock: it resumes at +1 s per
      // block, so every suite after this one runs on a chain drifting further behind real time with
      // each pass. That is not hypothetical — the gateway's EIP-3009 authorisations are
      // timestamp-bounded, and a second `pnpm test:anvil` failed with `AuthorizationExpired` until
      // this was put back. Measured: naming the next block's timestamp restores tracking exactly.
      await devRpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
      await devRpc("evm_mine");
    });

    it("verifies against the rule the chain enforces, not one the client configured", async () => {
      const policy = await reader.policy();
      expect(policy.anchors).toContain(E.anchorCommitment);
      expect(policy.minimumSecurityLevel).toBeGreaterThanOrEqual(SecurityLevel.TRUSTED_ENVIRONMENT);
      expect(locker.principalId).toBe(E.principalId);
    });

    it("refuses a nonce the certificate did not commit to — in the client, and on the chain", async () => {
      const wrong = `0x${"99".repeat(32)}` as Bytes32;
      // The client will not even build it. Verifying before spending gas is what the local pass in
      // `planRegisterDevice` is for, and it runs the identical policy the contract runs.
      expect(() =>
        planRegisterDevice(locker, registryAddress, {
          chain: certChain,
          nonce: wrong,
          anchors: [E.anchorCommitment as Bytes32],
        }),
      ).toThrow(/challenge/);

      // And the chain says the same to anyone who skips the client, so the gate is not advisory.
      // `_useNonce` runs first, but this is a simulation; the challenge check sits before the
      // signature check, so a placeholder signature still reaches the error that matters.
      await expect(
        clients.publicClient.call({ to: registryAddress, data: register(wrong) }),
      ).rejects.toSatisfy(isRegistryError("DeviceRejected", 4));
    });

    it("refuses a principal the registry has never enrolled", async () => {
      const data = encodeFunctionData({
        abi: HardwareDeviceRegistryAbi,
        functionName: "registerDevice",
        args: [`0x${"ab".repeat(32)}`, E.chain as Hex[], nonce, `0x${"00".repeat(64)}`],
      });
      await expect(clients.publicClient.call({ to: registryAddress, data })).rejects.toSatisfy(
        isRegistryError("UnknownPrincipal"),
      );
    });

    it("registers: the precompile verifies the certificate chain on chain", async () => {
      const existing = await reader.device(keyCommitment);
      if (existing === null) {
        const plan = planRegisterDevice(locker, registryAddress, {
          chain: certChain,
          nonce,
          anchors: [E.anchorCommitment as Bytes32],
        });
        expect(plan.keyCommitment).toBe(keyCommitment);
        const sent = await sendRegisterDevice(locker, transport, plan);
        const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
        expect(receipt.status).toBe("success");
      }

      const device = await reader.device(keyCommitment);
      expect(device).not.toBeNull();
      // The level the certificate carried, read back off the chain — never one anybody chose.
      expect(device?.securityLevel).toBe(SecurityLevel.STRONG_BOX);
      expect(device?.principalId).toBe(locker.principalId);
      expect(device?.hasRootOfTrust).toBe(true);
      expect(device?.verifiedBootState).toBe(VerifiedBootState.VERIFIED);
      expect(device?.publicKey.x).toBe(E.deviceX);
      expect(device?.revokedAt).toBe(0n);
    });

    it("the chain verifies a genuine capture witness", async () => {
      const digest = capture(
        locker.depositKey(0, locker.currentEpoch()).address,
        `0x${"11".repeat(32)}`,
      );
      const signature = signAuthorityDigest(deviceScalar(), digest);
      expect(await verifyOnChain(digest, signature)).toBe(true);
    });

    it("and refuses the same witness transplanted onto another locker — the whole claim", async () => {
      const mine = capture(
        locker.depositKey(0, locker.currentEpoch()).address,
        `0x${"11".repeat(32)}`,
      );
      const signature = signAuthorityDigest(deviceScalar(), mine);
      // A second locker deposits the same bytes: different deposit key, different deterministic
      // nonce, so `hwDigest` differs and the signature no longer covers it.
      const theirs = capture(`0x${"be".repeat(20)}`, `0x${"22".repeat(32)}`);
      expect(theirs).not.toBe(mine);
      expect(await verifyOnChain(theirs, signature)).toBe(false);
    });

    it("refuses a replay: the nonce is spent, and the device is already known", async () => {
      // Replaying the whole registration verbatim dies on the nonce, before anything is parsed.
      await expect(
        clients.publicClient.call({ to: registryAddress, data: register(nonce) }),
      ).rejects.toSatisfy(isRegistryError("NonceAlreadyUsed"));

      // With a *fresh* nonce the spend succeeds and the duplicate-device check fires instead:
      // `AlreadyRegistered` sits before the challenge check, so that is the error, not
      // `DeviceRejected`. Two different ways to say "this device is already here", and which one
      // you get depends on where in the function you are stopped.
      await expect(
        clients.publicClient.call({ to: registryAddress, data: register(`0x${"7e".repeat(32)}`) }),
      ).rejects.toSatisfy(isRegistryError("AlreadyRegistered"));
    });

    it("revokes, and revocation is enforced rather than merely recorded", async () => {
      const digest = capture(
        locker.depositKey(0, locker.currentEpoch()).address,
        `0x${"11".repeat(32)}`,
      );
      const signature = signAuthorityDigest(deviceScalar(), digest);
      expect(await verifyOnChain(digest, signature)).toBe(true);

      const plan = planRevokeDevice(locker, registryAddress, keyCommitment);
      const sent = await sendRevokeDevice(locker, transport, plan);
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
      expect(receipt.status).toBe("success");

      // The signature is unchanged and still cryptographically valid. The chain refuses it anyway,
      // which is what makes revocation worth having after a phone is stolen.
      expect(await verifyOnChain(digest, signature)).toBe(false);

      const device = await reader.device(keyCommitment);
      // The record stays: a buyer auditing an older manifest still needs to see the device existed.
      expect(device).not.toBeNull();
      expect(device?.revokedAt).toBeGreaterThan(0n);
      expect(device?.principalId).toBe(locker.principalId);
    });
  },
);

/**
 * A development-node cheat call (`evm_snapshot` / `evm_revert`). Returns null when the node has
 * no such method — a real chain — and the caller then simply does not rewind.
 */
async function devRpc(method: string, params: unknown[] = []): Promise<`0x${string}` | null> {
  try {
    const res = await fetch(RPC as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: string; error?: unknown };
    return body.error || typeof body.result !== "string" ? null : (body.result as `0x${string}`);
  } catch {
    return null;
  }
}

function deviceScalar(): SecretBytes {
  return new SecretBytes(hexToBytes(E.deviceScalar as Hex), "k_device");
}

/** Matches a revert by error name, and optionally by its `uint8` discriminator. */
function isRegistryError(name: string, code?: number) {
  return (error: unknown): boolean => {
    const data = extractRevertData(error);
    if (!data) return false;
    try {
      const decoded = decodeErrorResult({ abi: HardwareDeviceRegistryAbi, data });
      if (decoded.errorName !== name) return false;
      return code === undefined || Number((decoded.args as readonly unknown[])[0]) === code;
    } catch {
      return false;
    }
  };
}

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
