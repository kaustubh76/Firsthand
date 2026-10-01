import {
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryConsentLedger,
  MemoryDeviceRegistry,
  MemoryGrantReader,
  MemoryPassportCatalog,
  MemorySettlement,
} from "@firsthand/adapters";
import {
  type Attestation,
  AttestationClass,
  type Bytes32,
  LICENSE_FH_1_0,
  type PassportSidecar,
  Scope,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { noopLogger } from "@firsthand/runtime";
import {
  Batcher,
  deposit,
  deviceClassFor,
  Locker,
  mintPassport,
  sidecarFor,
  signCaptureWitness,
} from "@firsthand/sdk";
import { describe, expect, it } from "vitest";
import { Serving } from "./services/Serving.js";

/**
 * The class-3 ingest gate (ADR-0015).
 *
 * This is the enforcement point that matters. A locker checks its own deposits, but a buyer
 * trusts the gateway, and the sidecar is the first place the attestation preimage and the witness
 * are both in hand. Everything here runs against memory doubles — the same code path the anvil
 * tier runs for real.
 */

const domain = { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` } as const;
const epochs = { genesis: 1_000_000n, length: 604_800n };
const clock = () => 1_000_000n + 5n * 604_800n + 17n; // epoch 5
const prfSource = (fill: number) => ({
  kind: "test",
  evaluate: async () => new Uint8Array(32).fill(fill),
});

async function harness(options: { devices?: MemoryDeviceRegistry } = {}) {
  const anchors = new MemoryAnchorWriter();
  const grants = new MemoryGrantReader();
  const serving = new Serving({
    anchors,
    blobs: new MemoryBlobStore(),
    catalog: new MemoryPassportCatalog(),
    grants,
    settlement: new MemorySettlement(grants, new MemoryConsentLedger()),
    domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    logger: noopLogger,
    ...(options.devices ? { devices: options.devices } : {}),
  });

  const locker = await Locker.open(prfSource(1), {
    domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    epochs,
    anchors,
    blobs: new MemoryBlobStore(),
    clock,
    namespaces: [{ ns: 0, label: "captures" }],
  });
  grants.setEpoch(5n);
  grants.enroll(locker.principalId, 5n);

  const terms: Terms = {
    price: 1_000n,
    licenseId: LICENSE_FH_1_0,
    scope: Scope.TRAIN,
    ns: 0,
    rateLimit: 2,
    payees: [locker.depositKey(0).address],
    weights: [WAD],
  };
  // A software stand-in for the phone's secure element. It is a real P-256 key, so the witness is
  // well formed; what it is not is *registered*, which is the whole point of the registry checks.
  const device = (
    await Locker.open(prfSource(9), {
      domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      epochs,
      anchors,
      blobs: new MemoryBlobStore(),
      clock,
    })
  ).authorityKey();

  const attestation: Attestation = {
    class: AttestationClass.HARDWARE,
    capturedAt: 1_700_000_000n,
    sourceTag: ZERO_HASH,
    deviceClass: deviceClassFor(device.publicKey),
    metaHash: ZERO_HASH,
  };

  /** A published-shaped sidecar for a class-3 deposit, with whatever witness the caller wants. */
  async function sidecarOf(
    mutate: (witness: PassportSidecar["hardware"]) => PassportSidecar["hardware"] = (w) => w,
    att: Attestation = attestation,
  ): Promise<PassportSidecar> {
    const batcher = new Batcher(locker, anchors, 1);
    const bytes = new TextEncoder().encode(`capture ${att.capturedAt}-${Math.random()}`);
    const signed = mintPassport(locker, {
      ns: 0,
      datum: { kind: "bytes", bytes },
      terms,
      attestation: att,
    });
    const hardware = signCaptureWitness(device, {
      chainId: domain.chainId,
      passport: signed.passport,
      attestation: att,
    });
    const result = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes },
      terms,
      attestation: att,
      hardware,
    });
    const sidecar = sidecarFor(locker, batcher, result, terms);
    const mutated = mutate(sidecar.hardware);
    const { hardware: _drop, ...rest } = sidecar;
    return mutated ? { ...rest, hardware: mutated } : rest;
  }

  return { serving, locker, terms, attestation, device, sidecarOf, anchors };
}

describe("gateway ingest — a class-3 passport is checked, not believed", () => {
  it("accepts a witnessed capture from a registered device", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });

    const sidecar = await h.sidecarOf();
    await expect(h.serving.ingestPassport(sidecar)).resolves.toBeDefined();
  });

  it("refuses when this gateway cannot reach a device registry at all", async () => {
    // Absence is a refusal, not a pass: a gateway that cannot ask whether a key is hardware-backed
    // has no business hosting a passport that says it is.
    const h = await harness();
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/cannot reach a device registry/),
    });
  });

  it("refuses a device that was never registered", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/not registered to this principal, or has been revoked/),
    });
  });

  it("refuses a revoked device, so a stolen phone stops depositing", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    const id = devices.register({
      principalId: h.locker.principalId,
      publicKey: h.device.publicKey,
    });
    devices.revoke(id, 1_700_000_500n);
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
    });
  });

  it("refuses a device registered to somebody else", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({
      principalId: `0x${"ee".repeat(32)}` as Bytes32,
      publicKey: h.device.publicKey,
    });
    await expect(h.serving.ingestPassport(await h.sidecarOf())).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
    });
  });

  it("refuses a class-3 sidecar carrying no witness", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    await expect(
      h.serving.ingestPassport(await h.sidecarOf(() => undefined)),
    ).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/no secure-element witness/),
    });
  });

  it("refuses a witness whose signature does not verify", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    const tampered = await h.sidecarOf((w) =>
      w ? { ...w, signature: `0x${"22".repeat(64)}` } : w,
    );
    await expect(h.serving.ingestPassport(tampered)).rejects.toMatchObject({
      code: "FH_REFUSED_HARDWARE",
      message: expect.stringMatching(/does not verify over this passport/),
    });
  });

  it("rejects a witness attached to a passport that never claimed class 3", async () => {
    const devices = new MemoryDeviceRegistry();
    const h = await harness({ devices });
    devices.register({ principalId: h.locker.principalId, publicKey: h.device.publicKey });
    const classTwo: Attestation = { ...h.attestation, class: AttestationClass.DEVICE_CAPTURE };
    // Well-formed, verifiable, and meaningless — storing it where a reader might mistake it for a
    // checked claim is worse than refusing it.
    await expect(h.serving.ingestPassport(await h.sidecarOf((w) => w, classTwo))).rejects.toThrow(
      /does not claim class 3/,
    );
  });
});
