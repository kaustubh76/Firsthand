import {
  decodePaymentHeader,
  encodePaymentHeader,
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters";
import { GrantManagerAbi, PrincipalRegistryAbi } from "@firsthand/contracts/abi";
import {
  type Address,
  type Attestation,
  AttestationClass,
  attestStructHash,
  authorityDigest,
  type Bytes32,
  bytesToHex,
  contentHash,
  depositKeysRoot,
  enrollStructHash,
  GrantStatus,
  grantIdOf,
  hashTerms,
  LICENSE_FH_1_0,
  MONAD_TESTNET_CHAIN_ID,
  NotImplementedError,
  passportDigest,
  passportId,
  RefusalError,
  rescindStructHash,
  rescissionCommitment,
  Scope,
  type SignedPassport,
  sidecarToWire,
  type Terms,
  ValidationError,
  verifyP256,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import {
  generateGranteeKeypair,
  KeyTree,
  openBlob,
  SecretBytes,
  StaticPrfSource,
  signPassportDigest,
  unwrapDek,
  unwrapVaultKey,
} from "@firsthand/crypto";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { type AnchoredBatch, Batcher } from "./batch/Batcher.js";
import { BuyerSession, createBuyerKeys } from "./client/BuyerSession.js";
import { FirsthandClient } from "./client/FirsthandClient.js";
import { Locker } from "./locker/Locker.js";
import { exportManifest, serialiseManifest } from "./manifest/export.js";
import { verifyManifest } from "./manifest/verify.js";
import { planAttest } from "./verbs/attest.js";
import { acceptSigned, deposit, mintPassport, refuseUnlessProvable } from "./verbs/deposit.js";
import { planEnroll, sendEnroll } from "./verbs/enroll.js";
import { planGrant } from "./verbs/grant.js";
import { publishDeposit, sidecarFor } from "./verbs/publish.js";
import { checkServed, openQueried, query } from "./verbs/query.js";
import { planCommit, planDirectRescind, planRevealRescind, sendRescind } from "./verbs/rescind.js";
import { verify } from "./verify/verify.js";

const domain = {
  chainId: MONAD_TESTNET_CHAIN_ID,
  verifyingContract: `0x${"a1".repeat(20)}` as Address,
};
const epochs = { genesis: 1_000_000n, length: 604_800n };
const clock = () => 1_000_000n + 5n * 604_800n + 17n; // epoch 5
const prf = (fill: number) => new Uint8Array(32).fill(fill);

function makeLocker(fill = 1, anchors = new MemoryAnchorWriter(), blobs = new MemoryBlobStore()) {
  StaticPrfSource.resetWarning();
  const keys = KeyTree.fromPrf(prf(fill));
  return new Locker({
    keys,
    domain,
    epochs,
    anchors,
    blobs,
    clock,
    namespaces: [
      { ns: 0, label: "chat" },
      { ns: 2, label: "sensor" },
    ],
  });
}

const terms = (ns: number, payee: Address): Terms => ({
  price: 1_000n,
  licenseId: LICENSE_FH_1_0,
  scope: Scope.TRAIN | Scope.EVAL,
  ns,
  rateLimit: 100,
  payees: [payee],
  weights: [WAD],
});
const attestation: Attestation = {
  class: AttestationClass.IMPORT,
  capturedAt: 1_700_000_000n,
  sourceTag: `0x${"01".repeat(32)}`,
  deviceClass: ZERO_HASH,
  metaHash: ZERO_HASH,
};

describe("Locker", () => {
  it("derives a stable principal id, memoises deposit keys, and never serialises secrets", () => {
    const a = makeLocker(1);
    const b = makeLocker(1);
    expect(a.principalId).toBe(b.principalId);
    expect(a.currentEpoch()).toBe(5n);
    expect(a.depositKey(0)).toBe(a.depositKey(0, 5n));
    expect(a.depositAddresses()).toHaveLength(16);
    expect(a.isOwnOrigin(a.depositKey(2).address, 2, 5n)).toBe(true);
    expect(a.isOwnOrigin(a.depositKey(2).address, 0, 5n)).toBe(false);
    expect(a.namespaces().map((n) => n.ns)).toEqual([0, 2]);
    expect(() => a.addNamespace({ ns: 16, label: "x" })).toThrow(ValidationError);
    const json = JSON.stringify(a);
    expect(json).toContain(a.principalId);
    expect(json).not.toContain(SecretBytes.REDACTED.slice(1, 4)); // handles are not even reachable
    a.dispose();
    expect(() => a.depositKey(0, 6n)).toThrow();
  });

  it("opens from a PrfSource", async () => {
    StaticPrfSource.resetWarning();
    const source = new StaticPrfSource(prf(3), { unsafeAcknowledged: true, warn: () => {} });
    const locker = await Locker.open(source, {
      domain,
      epochs,
      anchors: new MemoryAnchorWriter(),
      blobs: new MemoryBlobStore(),
      clock,
    });
    expect(locker.principalId).toBe(makeLocker(3).principalId);
    expect(locker.namespaces()).toEqual([{ ns: 0, label: "default" }]);
  });
});

describe("deposit — the locker that turns data away (S4 in miniature)", () => {
  it("accepts own data end to end: mint → seal → wrap → batch → anchor, then the grantee can open it", async () => {
    const anchors = new MemoryAnchorWriter();
    const blobs = new MemoryBlobStore();
    const locker = makeLocker(1, anchors, blobs);
    const batcher = new Batcher(locker, anchors, 2);
    const plaintext = new TextEncoder().encode("first conversation");
    const t = terms(0, locker.depositKey(0).address);

    const r1 = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: plaintext },
      terms: t,
      attestation,
    });
    expect(r1.anchored).toBeNull();
    expect(r1.signed.passport.origin).toBe(locker.depositKey(0).address);
    expect(r1.signed.passport.nonce).toBe(
      locker.keys.passportNonce(0, 5n, contentHash({ kind: "bytes", bytes: plaintext })),
    );
    expect(batcher.pendingCount()).toBe(1);

    const r2 = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "json", value: { role: "user", text: "hi" } },
      terms: t,
      attestation,
    });
    expect(r2.anchored).not.toBeNull();
    expect(r2.anchored?.passports).toHaveLength(2);
    expect(await anchors.isAnchored(r2.anchored?.root as Bytes32)).toBe(true);
    expect(anchors.anchored()[0]?.request.depositKeys[0]).toBe(locker.depositKey(0).address);
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.proofFor(r1.passportId)?.proof.siblings).toHaveLength(8);

    // What a grantee holding k_ns,e does with the ciphertext.
    const vault = locker.keys.vaultKey(0, 5n);
    const wrapped = await blobs.get(r1.wrappedDek);
    const blob = await blobs.get(r1.blob);
    const dek = unwrapDek(vault, wrapped as Uint8Array, r1.passportId, 0, 5n);
    expect(openBlob(dek, blob as Uint8Array, r1.passportId)).toEqual(plaintext);
  });

  it("refuses a passport signed by a key outside the enrolled lineage", async () => {
    const locker = makeLocker(1);
    const batcher = new Batcher(locker);
    const intruder = makeLocker(2); // a different passkey → different lineage
    const t = terms(0, intruder.depositKey(0).address);
    const scraped = mintPassport(intruder, {
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([1]) },
      terms: t,
      attestation,
    });
    await expect(
      acceptSigned(locker, batcher, scraped, 0, new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "FH_REFUSED_ORIGIN",
    });
    expect(batcher.pendingCount()).toBe(0);
  });

  it("refuses a passport whose signature does not verify, and a right key under the wrong namespace", async () => {
    const locker = makeLocker(1);
    const batcher = new Batcher(locker);
    const t = terms(0, locker.depositKey(0).address);
    const good = mintPassport(locker, {
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([2]) },
      terms: t,
      attestation,
    });
    const forged: SignedPassport = {
      passport: { ...good.passport, h: `0x${"ee".repeat(32)}` },
      signature: good.signature,
    };
    expect(() => refuseUnlessProvable(locker, forged, 0)).toThrow(RefusalError);
    expect(() => refuseUnlessProvable(locker, good, 2)).toThrow(/not an enrolled deposit key/);
    // Signed with an unrelated secp key over the right digest: verifies, but origin mismatches.
    const stray = new SecretBytes(new Uint8Array(32).fill(9), "stray");
    const straySig = signPassportDigest(stray, passportDigest(good.passport, domain));
    await expect(
      acceptSigned(
        locker,
        batcher,
        { passport: good.passport, signature: straySig },
        0,
        new Uint8Array([2]),
      ),
    ).rejects.toThrow(RefusalError);
  });

  it("refuses duplicates structurally (same content, same ns/epoch ⇒ same passport id)", async () => {
    const locker = makeLocker(1);
    const batcher = new Batcher(locker);
    const t = terms(0, locker.depositKey(0).address);
    const input = {
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([3]) } as const,
      terms: t,
      attestation,
    };
    const first = await deposit(locker, batcher, input);
    await expect(deposit(locker, batcher, input)).rejects.toMatchObject({
      code: "FH_REFUSED_DUPLICATE",
    });
    expect(passportId(mintPassport(locker, input).passport)).toBe(first.passportId);
    // Different epoch → different nonce → distinct passport.
    const later = await deposit(locker, batcher, { ...input, epoch: 6n });
    expect(later.passportId).not.toBe(first.passportId);
  });

  it("validates namespace and terms binding", () => {
    const locker = makeLocker(1);
    const t = terms(0, locker.depositKey(0).address);
    expect(() =>
      mintPassport(locker, {
        ns: 1,
        datum: { kind: "bytes", bytes: new Uint8Array() },
        terms: { ...t, ns: 1 },
        attestation,
      }),
    ).toThrow(/unknown namespace/);
    expect(() =>
      mintPassport(locker, {
        ns: 2,
        datum: { kind: "bytes", bytes: new Uint8Array() },
        terms: t,
        attestation,
      }),
    ).toThrow(/terms.ns/);
    expect(() => new Batcher(locker, locker.anchors, 0)).toThrow(ValidationError);
  });
});

describe("verify() and the Lineage Manifest", () => {
  it("verifies live passports and reports reasons; manifests round-trip and verify offline", async () => {
    const anchors = new MemoryAnchorWriter();
    const locker = makeLocker(1, anchors);
    const batcher = new Batcher(locker, anchors, 3);
    const payee = locker.depositKey(0).address;
    const t = terms(0, payee);
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await deposit(locker, batcher, {
          ns: 0,
          datum: { kind: "bytes", bytes: new Uint8Array([i]) },
          terms: t,
          attestation,
        }),
      );
    }
    await batcher.flush();
    expect(batcher.flushed()).toHaveLength(2);

    const grant = { status: GrantStatus.ACTIVE, epochStart: 4n, term: 8n, termsHash: hashTerms(t) };
    const principal = { lastAttestedEpoch: 5n };
    const first = batcher.proofFor(results[0]?.passportId as Bytes32);
    if (!first) throw new Error("missing proof");
    const ok = await verify(
      results[0]?.signed as SignedPassport,
      first.batch.root,
      first.proof,
      grant,
      principal,
      { domain, anchors, epochNow: 5n },
    );
    expect(ok).toEqual({ ok: true, passportId: results[0]?.passportId });
    const stale = await verify(
      results[0]?.signed as SignedPassport,
      first.batch.root,
      first.proof,
      grant,
      { lastAttestedEpoch: 1n },
      { domain, anchors, epochNow: 5n, liveness: { grace: 2n } },
    );
    expect(stale).toMatchObject({ ok: false, reason: "GRANT_FROZEN" });
    const unknownRoot = await verify(
      results[0]?.signed as SignedPassport,
      `0x${"77".repeat(32)}`,
      first.proof,
      grant,
      principal,
      { domain, anchors, epochNow: 5n },
    );
    expect(unknownRoot).toMatchObject({ ok: false, reason: "ROOT_UNKNOWN" });

    const receipts = new Map([
      [
        results[0]?.passportId as Bytes32,
        {
          receiptId: `0x${"01".repeat(32)}` as Bytes32,
          grantId: `0x${"02".repeat(32)}` as Bytes32,
          payer: payee,
          ns: 0,
          termsHash: hashTerms(t),
          epoch: 5n,
          blockNumber: 9n,
          txHash: `0x${"03".repeat(32)}` as Bytes32,
        },
      ],
    ]);
    const manifest = exportManifest({
      domain,
      principalId: locker.principalId,
      ns: 0,
      batches: batcher.flushed(),
      receipts,
      finalityDepth: 2,
      now: () => 123n,
    });
    expect(manifest.assets).toHaveLength(5);
    expect(manifest.assets[0]?.receipt?.receiptId).toBe(`0x${"01".repeat(32)}`);
    const text = serialiseManifest(manifest);
    const parsed = JSON.parse(text);

    anchors.mineBlocks(1);
    const verdict = await verifyManifest(parsed, { anchors, headBlock: anchors.head });
    expect(verdict.hashesPerAsset).toBe(8);
    expect(verdict.assets.filter((a) => a.ok)).toHaveLength(3); // second batch anchored at head-? → not final yet
    expect(verdict.assets.filter((a) => a.reason === "NOT_FINAL")).toHaveLength(2);
    anchors.mineBlocks(5);
    const final = await verifyManifest(parsed, { anchors, headBlock: anchors.head });
    expect(final.ok).toBe(true);
    expect(final.ms).toBeGreaterThanOrEqual(0);

    // Tampering is caught per asset.
    parsed.assets[1].signed.passport.h = `0x${"ff".repeat(32)}`;
    parsed.assets[2].proof.index = 7;
    parsed.assets[3].batchRoot = `0x${"ab".repeat(32)}`;
    const tampered = await verifyManifest(parsed, { anchors, headBlock: anchors.head });
    expect(tampered.assets.map((a) => a.reason ?? "ok")).toEqual([
      "ok",
      "SIG_INVALID",
      "MERKLE_INVALID",
      "ROOT_UNKNOWN",
      "ok",
    ]);
    expect(tampered.signatures).toBe("all");
    expect(tampered.signatureMs + tampered.merkleMs).toBeCloseTo(tampered.ms, 5);
    // Signature modes: "none" skips the forged-content asset's SIG check (Merkle still catches the others).
    const none = await verifyManifest(
      parsed,
      { anchors, headBlock: anchors.head },
      { signatures: "none" },
    );
    expect(none.assets.map((a) => a.reason ?? "ok")).toEqual([
      "ok",
      "MERKLE_INVALID",
      "MERKLE_INVALID",
      "ROOT_UNKNOWN",
      "ok",
    ]);
    expect(none.signatureMs).toBe(0);
    const sampled = await verifyManifest(
      parsed,
      { anchors, headBlock: anchors.head },
      { signatures: 2 },
    );
    expect(sampled.signatures).toBe(2);
    expect(sampled.assets.filter((a) => a.reason === "SIG_INVALID").length).toBeLessThanOrEqual(1);
    expect(() =>
      exportManifest({
        domain,
        principalId: locker.principalId,
        ns: 0,
        batches: [{ ...(batcher.flushed()[0] as AnchoredBatch), proofs: new Map() }],
      }),
    ).toThrow(/no proof/);
  });
});

describe("rescind plans and client wiring", () => {
  const addresses = {
    grantManager: `0x${"b1".repeat(20)}` as Address,
    rescissions: `0x${"b2".repeat(20)}` as Address,
    principalRegistry: `0x${"b3".repeat(20)}` as Address,
  };
  it("builds direct and commit-reveal calldata and records broadcast time", async () => {
    const locker = makeLocker(1);
    const direct = planDirectRescind(
      locker,
      "btx",
      addresses,
      `0x${"c1".repeat(32)}`,
      5n,
      `0x${"c2".repeat(32)}`,
    );
    expect(direct.to).toBe(addresses.grantManager);
    const decodedRescind = decodeFunctionData({ abi: GrantManagerAbi, data: direct.data });
    expect(decodedRescind.functionName).toBe("rescind");
    const [gid, epoch, nonce, sig] = decodedRescind.args as readonly [
      Bytes32,
      bigint,
      Bytes32,
      `0x${string}`,
    ];
    expect([gid, epoch, nonce]).toEqual([`0x${"c1".repeat(32)}`, 5n, `0x${"c2".repeat(32)}`]);
    // The signature verifies under GrantManager's domain (ADR-0009) with the locker's authority key.
    expect(
      verifyP256(
        authorityDigest(rescindStructHash(gid, epoch, nonce), {
          chainId: domain.chainId,
          verifyingContract: addresses.grantManager,
        }),
        sig,
        locker.authorityKey().publicKey,
      ),
    ).toBe(true);
    const reveal = planRevealRescind(
      locker,
      addresses,
      `0x${"c1".repeat(32)}`,
      `0x${"c3".repeat(32)}`,
    );
    expect(decodeFunctionData({ abi: GrantManagerAbi, data: reveal.data }).functionName).toBe(
      "revealRescind",
    );
    expect(reveal.commitment).toBe(
      rescissionCommitment(`0x${"c1".repeat(32)}`, `0x${"c3".repeat(32)}`),
    );
    const commit = planCommit(addresses, `0x${"c1".repeat(32)}`);
    expect(commit.path).toBe("commit-reveal");
    expect(commit.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commit.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    const transport = new MemoryTransport({ encryptedMempool: true, now: () => 77 });
    const sent = await sendRescind(locker, transport, commit);
    expect(sent).toMatchObject({ submittedAt: 77, encryptedMempool: true });
    expect(transport.sent[0]?.tx.to).toBe(addresses.rescissions);
  });

  it("FirsthandClient assembles sessions over injected adapters", async () => {
    StaticPrfSource.resetWarning();
    const client = new FirsthandClient({
      domain,
      epochs,
      anchors: new MemoryAnchorWriter(),
      blobs: new MemoryBlobStore(),
      transport: new MemoryTransport(),
      facilitator: new MemoryFacilitator(),
      addresses,
      clock,
      namespaces: [{ ns: 0, label: "x" }],
    });
    const session = await client.open(
      new StaticPrfSource(prf(4), { unsafeAcknowledged: true, warn: () => {} }),
    );
    const t = terms(0, session.locker.depositKey(0).address);
    const r = await session.deposit({
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([1]) },
      terms: t,
      attestation,
    });
    expect(r.anchored).toBeNull();
    expect((await session.flush())[0]?.passports).toHaveLength(1);
    const again = mintPassport(session.locker, {
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([2]) },
      terms: t,
      attestation,
    });
    await expect(session.acceptSigned(again, 0, new Uint8Array([2]))).resolves.toBeDefined();
    expect(session.planRescind(ZERO_HASH).path).toBe("btx");
    expect(session.planRescind(ZERO_HASH, "public").path).toBe("public");
    expect(session.planCommit(ZERO_HASH).path).toBe("commit-reveal");
    expect(session.planReveal(ZERO_HASH, ZERO_HASH).path).toBe("commit-reveal");
    await expect(session.sendRescind(session.planCommit(ZERO_HASH))).resolves.toMatchObject({
      encryptedMempool: false,
    });
    session.close();
  });
});

describe("enroll / attest plans (Phase 1)", () => {
  const registry = `0x${"b3".repeat(20)}` as Address;

  it("planEnroll signs the Enroll digest under the registry's domain and encodes matching calldata", () => {
    const locker = makeLocker(1);
    const plan = planEnroll(locker, registry, 5n, `0x${"0f".repeat(32)}`);
    const authority = locker.authorityKey();
    expect(plan.principalId).toBe(locker.principalId);
    expect(plan.x).toBe(authority.publicKey.x);
    expect(plan.y).toBe(authority.publicKey.y);
    // Digest parity with core (what the contract recomputes) and a signature core's verifier accepts.
    const digest = authorityDigest(enrollStructHash(plan.principalId, 5n, plan.nonce), {
      chainId: domain.chainId,
      verifyingContract: registry,
    });
    expect(verifyP256(digest, plan.authoritySig, authority.publicKey)).toBe(true);
    // Under the passport domain the same signature is invalid: domains are per contract (ADR-0009).
    expect(
      verifyP256(
        authorityDigest(enrollStructHash(plan.principalId, 5n, plan.nonce), domain),
        plan.authoritySig,
        authority.publicKey,
      ),
    ).toBe(false);
    const decoded = decodeFunctionData({ abi: PrincipalRegistryAbi, data: plan.tx.data });
    expect(decoded.functionName).toBe("enroll");
    expect(decoded.args).toEqual([
      BigInt(plan.x),
      BigInt(plan.y),
      5n,
      plan.nonce,
      plan.authoritySig,
    ]);
    expect(plan.tx.to).toBe(registry);
    // Random nonce by default, current epoch by default.
    const fresh = planEnroll(locker, registry);
    expect(fresh.epoch).toBe(5n);
    expect(fresh.nonce).not.toBe(plan.nonce);
  });

  it("planAttest commits to the 16 epoch deposit addresses", () => {
    const locker = makeLocker(1);
    const plan = planAttest(locker, registry, 6n, ZERO_HASH);
    expect(plan.depositKeys).toHaveLength(16);
    expect(plan.depositKeys[2]).toBe(locker.depositKey(2, 6n).address);
    expect(plan.depositKeysRoot).toBe(depositKeysRoot(locker.depositAddresses(6n)));
    const digest = authorityDigest(
      attestStructHash(plan.principalId, 6n, plan.depositKeysRoot, ZERO_HASH),
      { chainId: domain.chainId, verifyingContract: registry },
    );
    expect(verifyP256(digest, plan.authoritySig, locker.authorityKey().publicKey)).toBe(true);
    const decoded = decodeFunctionData({ abi: PrincipalRegistryAbi, data: plan.tx.data });
    expect(decoded.functionName).toBe("attest");
    expect(decoded.args).toEqual([
      plan.principalId,
      6n,
      plan.depositKeysRoot,
      ZERO_HASH,
      plan.authoritySig,
    ]);
  });

  it("sends over a transport and disposes the authority scalar with the locker", async () => {
    const locker = makeLocker(1);
    const transport = new MemoryTransport({ now: () => 99 });
    const sent = await sendEnroll(locker, transport, planEnroll(locker, registry));
    expect(sent.submittedAt).toBe(99);
    expect(transport.sent[0]?.tx.to).toBe(registry);
    expect(locker.authorityKey()).toBe(locker.authorityKey()); // memoised
    locker.dispose();
    expect(() => planEnroll(locker, registry, 5n)).toThrow();
  });

  it("LockerSession exposes enroll/attest over the client's transport", async () => {
    StaticPrfSource.resetWarning();
    const transport = new MemoryTransport();
    const client = new FirsthandClient({
      domain,
      epochs,
      anchors: new MemoryAnchorWriter(),
      blobs: new MemoryBlobStore(),
      transport,
      facilitator: new MemoryFacilitator(),
      addresses: {
        grantManager: `0x${"b1".repeat(20)}`,
        rescissions: `0x${"b2".repeat(20)}`,
        principalRegistry: registry,
      },
      clock,
    });
    const session = await client.open(
      new StaticPrfSource(prf(6), { unsafeAcknowledged: true, warn: () => {} }),
    );
    await session.enroll();
    await session.attest();
    expect(transport.sent.map((s) => s.tx.to)).toEqual([registry, registry]);
    expect(session.planEnroll(5n).principalId).toBe(session.locker.principalId);
    expect(session.planAttest(5n).depositKeys).toHaveLength(16);
    session.close();
  });
});

describe("grant, publish and query (Phase 3)", () => {
  const grantManager = `0x${"b1".repeat(20)}` as Address;

  it("planGrant wraps the vault key to the grantee and signs the Grant struct; the grantee can unwrap", () => {
    const locker = makeLocker(1);
    const grantee = generateGranteeKeypair();
    const t = terms(0, locker.depositKey(0).address);
    const plan = planGrant(locker, grantManager, {
      granteeCard: `0x${"ca".repeat(32)}`,
      granteeEncryptionPubKey: grantee.publicKey,
      ns: 0,
      termsHash: hashTerms(t),
      term: 4n,
    });
    expect(plan.grantId).toBe(grantIdOf(locker.principalId, `0x${"ca".repeat(32)}`, 0, 5n));
    expect(plan.wrap).toHaveLength(104);
    const decoded = decodeFunctionData({ abi: GrantManagerAbi, data: plan.tx.data });
    expect(decoded.functionName).toBe("grant");
    expect(decoded.args?.[6]).toBe(plan.wrapRef);
    const vault = unwrapVaultKey(grantee.secretKey, plan.wrap, {
      grantId: plan.grantId,
      ns: 0,
      epoch: 5n,
    });
    expect(bytesToHex(vault.expose())).toBe(bytesToHex(locker.keys.vaultKey(0, 5n).expose()));
  });

  it("publishes ciphertext + sidecar and the buyer queries, pays, verifies and opens the plaintext", async () => {
    const anchors = new MemoryAnchorWriter();
    const blobs = new MemoryBlobStore();
    const locker = makeLocker(1, anchors, blobs);
    const batcher = new Batcher(locker, anchors, 1);
    const t = terms(0, locker.depositKey(0).address);
    const plaintext = new TextEncoder().encode("what the buyer paid for");
    const r = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: plaintext },
      terms: t,
      attestation,
    });
    const sidecar = sidecarFor(locker, batcher, r, t);
    expect(sidecar.batchRoot).toBe(r.anchored?.root);

    // Grant to a buyer.
    const account = privateKeyToAccount(`0x${"0b".repeat(32)}`);
    const buyer = new BuyerSession({
      keys: createBuyerKeys(new Uint8Array(32).fill(0x0b), account, new Uint8Array(32).fill(0x0c)),
      grantManager,
      chainId: domain.chainId,
      transport: new MemoryTransport(),
    });
    const accept = buyer.acceptTerms(locker.principalId, t, ZERO_HASH);
    expect(
      decodeFunctionData({ abi: GrantManagerAbi, data: accept.plan.tx.data }).functionName,
    ).toBe("acceptTerms");
    expect(accept.plan.cardId).toBe(buyer.cardId);
    await accept.send();
    await buyer.registerCard();
    const plan = planGrant(locker, grantManager, {
      granteeCard: buyer.cardId,
      granteeEncryptionPubKey: buyer.encryptionPubKey,
      ns: 0,
      termsHash: hashTerms(t),
      term: 4n,
    });

    // A minimal fake gateway: 402 with requirements, then serve on X-PAYMENT; hosts the wrap.
    const published: Record<string, unknown> = {};
    const blobStore = new Map<string, Uint8Array>();
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body;
      if (init?.method === "POST" && url.pathname === "/v1/blobs") {
        const bytes = new Uint8Array(body as ArrayBuffer);
        const { keccak256Hex } = await import("@firsthand/core");
        const id = keccak256Hex(bytes);
        blobStore.set(id, bytes);
        return new Response(JSON.stringify({ id, size: bytes.length }), { status: 201 });
      }
      if (init?.method === "POST" && url.pathname === "/v1/passports") {
        published["sidecar"] = JSON.parse(body as string);
        return new Response(JSON.stringify({ passportId: r.passportId }), { status: 201 });
      }
      if (init?.method === "POST" && url.pathname.endsWith("/wrap")) {
        published["wrap"] = new Uint8Array(body as ArrayBuffer);
        return new Response(JSON.stringify({ wrapRef: plan.wrapRef }), { status: 201 });
      }
      if (url.pathname.endsWith("/wrap"))
        return new Response((published["wrap"] as Uint8Array).slice().buffer as ArrayBuffer);
      if (url.pathname.startsWith("/v1/query/")) {
        const header = (init?.headers as Record<string, string> | undefined)?.["x-payment"];
        const requirements = {
          scheme: "exact",
          network: "monad-testnet",
          maxAmountRequired: "1000",
          resource: url.toString(),
          description: "q",
          mimeType: "application/json",
          payTo: `0x${"aa".repeat(20)}`,
          maxTimeoutSeconds: 60,
          asset: `0x${"dc".repeat(20)}`,
          extra: { chainId: "10143" },
        };
        if (!header)
          return new Response(
            JSON.stringify({ x402Version: 1, error: "payment required", accepts: [requirements] }),
            { status: 402 },
          );
        const payload = decodePaymentHeader(header);
        if (!payload || payload.payload.authorization.value !== "1000")
          return new Response(JSON.stringify({ code: "FH_PAYMENT_INVALID" }), { status: 402 });
        return new Response(
          JSON.stringify({
            passportId: r.passportId,
            sidecar: sidecarToWire(sidecar),
            blob: bytesToHex(blobStore.get(r.blob.id) as Uint8Array),
            wrappedDek: bytesToHex(blobStore.get(r.wrappedDek.id) as Uint8Array),
            receipt: { receiptId: `0x${"ee".repeat(32)}`, txHash: null, blockNumber: "7" },
          }),
        );
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const target = { gatewayUrl: "http://gw", fetch: fakeFetch };
    await publishDeposit(target, locker, batcher, r, t);
    expect(published["sidecar"]).toMatchObject({
      principalId: locker.principalId,
      batchRoot: sidecar.batchRoot,
    });
    await (await import("./verbs/publish.js")).publishWrap(target, plan.grantId, plan.wrap);

    const result = await query(
      { gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId },
      { signer: account, fetch: fakeFetch },
    );
    expect(result.receipt.blockNumber).toBe(7n);
    expect(result.paid.requirements.payTo).toBe(`0x${"aa".repeat(20)}`);
    expect(checkServed(result, domain)).toBe(true);
    const granteeKeys = createBuyerKeys(
      new Uint8Array(32).fill(0x0b),
      account,
      new Uint8Array(32).fill(0x0c),
    );
    const opened = openQueried(result, granteeKeys.grantee.secretKey, plan.wrap, plan.grantId);
    buyer.close();
    expect(new TextDecoder().decode(opened)).toBe("what the buyer paid for");

    // The convenience path does the same end to end.
    const buyer2 = new BuyerSession({
      keys: createBuyerKeys(new Uint8Array(32).fill(0x0b), account, new Uint8Array(32).fill(0x0c)),
      grantManager,
      chainId: domain.chainId,
      transport: new MemoryTransport(),
      fetch: fakeFetch,
    });
    const { plaintext: again } = await buyer2.queryAndOpen(
      { gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId },
      domain,
    );
    expect(new TextDecoder().decode(again)).toBe("what the buyer paid for");
    // Declining the 402 aborts before paying.
    await expect(
      buyer2.query(
        { gatewayUrl: "http://gw", grantId: plan.grantId, passportId: r.passportId },
        () => false,
      ),
    ).rejects.toMatchObject({ code: "FH_PAYMENT_REQUIRED" });
    buyer2.close();
    expect(encodePaymentHeader).toBeTypeOf("function");
  });

  it("sidecarFor refuses passports that are not anchored yet", async () => {
    const locker = makeLocker(1);
    const batcher = new Batcher(locker, locker.anchors, 256);
    const t = terms(0, locker.depositKey(0).address);
    const r = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: new Uint8Array([1]) },
      terms: t,
      attestation,
    });
    expect(() => sidecarFor(locker, batcher, r, t)).toThrow(/flush/);
  });
});

describe("query and publish error paths", () => {
  const account = privateKeyToAccount(`0x${"0b".repeat(32)}`);
  const req = {
    gatewayUrl: "http://gw/",
    grantId: ZERO_HASH,
    passportId: `0x${"ab".repeat(32)}` as Bytes32,
  };
  const responder = (fn: (init?: RequestInit) => Response) =>
    (async (_u: string | URL | Request, init?: RequestInit) => fn(init)) as unknown as typeof fetch;

  it("maps 404, non-402, bad offers, refusals and mismatched passports to typed errors", async () => {
    await expect(
      query(req, { signer: account, fetch: responder(() => new Response("", { status: 404 })) }),
    ).rejects.toMatchObject({ code: "FH_NOT_FOUND" });
    await expect(
      query(req, { signer: account, fetch: responder(() => new Response("", { status: 500 })) }),
    ).rejects.toMatchObject({ code: "FH_PAYMENT_INVALID" });
    await expect(
      query(req, {
        signer: account,
        fetch: responder(
          () => new Response(JSON.stringify({ accepts: [{ nope: 1 }] }), { status: 402 }),
        ),
      }),
    ).rejects.toThrow(/no usable/);
    const requirements = {
      scheme: "exact",
      network: "n",
      maxAmountRequired: "1",
      resource: "https://gw/x",
      description: "",
      mimeType: "application/json",
      payTo: `0x${"aa".repeat(20)}`,
      maxTimeoutSeconds: 1,
      asset: `0x${"dc".repeat(20)}`,
      extra: { chainId: "1" },
    };
    const refusing = responder((init) =>
      init?.headers
        ? new Response(JSON.stringify({ code: "FH_GRANT_RESCINDED", detail: "withdrawn" }), {
            status: 403,
          })
        : new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 }),
    );
    await expect(query(req, { signer: account, fetch: refusing })).rejects.toMatchObject({
      code: "FH_PAYMENT_INVALID",
      context: { code: "FH_GRANT_RESCINDED" },
    });
    const wrongPassport = responder((init) =>
      init?.headers
        ? new Response(
            JSON.stringify({
              passportId: ZERO_HASH,
              sidecar: {},
              blob: "0x",
              wrappedDek: "0x",
              receipt: { receiptId: ZERO_HASH, txHash: null, blockNumber: null },
            }),
          )
        : new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 }),
    );
    await expect(query(req, { signer: account, fetch: wrongPassport })).rejects.toThrow();
    const { fetchWrap, publishBlob } = await import("./verbs/query.js").then(async (q) => ({
      ...q,
      ...(await import("./verbs/publish.js")),
    }));
    await expect(
      fetchWrap(
        "http://gw",
        ZERO_HASH,
        responder(() => new Response("", { status: 404 })),
      ),
    ).rejects.toMatchObject({ code: "FH_NOT_FOUND" });
    await expect(
      fetchWrap(
        "http://gw",
        ZERO_HASH,
        responder(() => new Response("", { status: 500 })),
      ),
    ).rejects.toThrow(/wrap fetch failed/);
    await expect(
      publishBlob(
        { gatewayUrl: "http://gw", fetch: responder(() => new Response("bad", { status: 400 })) },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/gateway rejected/);
  });
});
