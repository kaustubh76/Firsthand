import {
  MemoryAnchorWriter,
  MemoryBlobStore,
  MemoryFacilitator,
  MemoryTransport,
} from "@firsthand/adapters";
import {
  type Address,
  type Attestation,
  AttestationClass,
  LICENSE_FH_1_0,
  Scope,
  type Terms,
  WAD,
  ZERO_HASH,
} from "@firsthand/core";
import { encodeDelegation, issueDelegation, KeyTree, StaticPrfSource } from "@firsthand/crypto";
import { describe, expect, it } from "vitest";
import { FirsthandClient } from "./client/FirsthandClient.js";
import { sidecarFor } from "./verbs/publish.js";

/**
 * The MCP↔PWA handoff: the app issues a deposit delegation for one namespace-epoch; an agent's
 * locker opens it and deposits under the *same principal* — anchored with the delegated deposit
 * key against the same attested address set — while everything that needs the passkey stays
 * refused. Tested end to end on memory doubles here; the browser tier runs it against a chain.
 */
const domain = { chainId: 10143n, verifyingContract: `0x${"a1".repeat(20)}` as Address };
const epochs = { genesis: 1_000_000n, length: 604_800n };
const EPOCH = 5n;
const clock = () => epochs.genesis + EPOCH * epochs.length + 17n;
const addresses = {
  grantManager: `0x${"b1".repeat(20)}` as Address,
  rescissions: `0x${"b2".repeat(20)}` as Address,
  principalRegistry: `0x${"b3".repeat(20)}` as Address,
};
const terms = (ns: number, payee: Address): Terms => ({
  price: 1n,
  licenseId: LICENSE_FH_1_0,
  scope: Scope.TRAIN,
  ns,
  rateLimit: 100,
  payees: [payee],
  weights: [WAD],
});
const attestation: Attestation = {
  class: AttestationClass.IMPORT,
  capturedAt: 1_700_000_000n,
  sourceTag: `0x${"02".repeat(32)}`,
  deviceClass: ZERO_HASH,
  metaHash: ZERO_HASH,
};

function client(anchors = new MemoryAnchorWriter(), transport = new MemoryTransport()) {
  return new FirsthandClient({
    domain,
    epochs,
    anchors,
    blobs: new MemoryBlobStore(),
    transport,
    facilitator: new MemoryFacilitator(),
    addresses,
    clock,
    namespaces: [
      { ns: 0, label: "captures" },
      { ns: 1, label: "imports" },
    ],
  });
}

describe("a delegated locker", () => {
  it("deposits into the delegated namespace under the passkey's principal, and nothing else", async () => {
    const anchors = new MemoryAnchorWriter();
    // The app's side: the passkey's tree issues a delegation for ns 1, this epoch.
    const owner = await client(anchors).open(
      new StaticPrfSource(new Uint8Array(32).fill(7), { unsafeAcknowledged: true, warn: () => {} }),
    );
    const code = encodeDelegation(
      issueDelegation(KeyTree.fromPrf(new Uint8Array(32).fill(7)), {
        ns: 1,
        epoch: EPOCH,
        chainId: domain.chainId,
        expiresAt: epochs.genesis + (EPOCH + 1n) * epochs.length,
      }),
    );

    // The agent's side: same deployment, a different process, no passkey.
    const agent = client(anchors).openDelegated(code, { now: clock });
    expect(agent.locker.principalId).toBe(owner.locker.principalId);
    expect(agent.locker.delegated?.describe()).toMatch(/namespace 1, epoch 5/);
    expect(agent.locker.depositAddresses(EPOCH)).toEqual(owner.locker.depositAddresses(EPOCH));
    expect(agent.locker.namespaces()).toEqual([{ ns: 1, label: "delegated ns 1" }]);

    const payee = agent.locker.depositKey(1).address;
    expect(payee).toBe(owner.locker.depositKey(1).address);
    const t = terms(1, payee);
    const r = await agent.deposit({
      ns: 1,
      datum: { kind: "bytes", bytes: new TextEncoder().encode("from the laptop") },
      terms: t,
      attestation,
    });
    await agent.flush();
    const sidecar = sidecarFor(agent.locker, agent.batcher, r, t);
    expect(sidecar.principalId).toBe(owner.locker.principalId);
    expect(sidecar.signed.passport.origin).toBe(payee);
    expect(await anchors.anchorOf(sidecar.batchRoot)).toMatchObject({
      principalId: owner.locker.principalId,
      ns: 1,
      epoch: EPOCH,
    });
    // The owner's own locker recognises the agent's passport as its lineage.
    expect(owner.locker.isOwnOrigin(sidecar.signed.passport.origin, 1, EPOCH)).toBe(true);

    // Out of scope: another namespace, and anything that needs the authority key.
    const scoped = expect.objectContaining({ code: "FH_DELEGATION_SCOPE" });
    await expect(
      agent.deposit({
        ns: 0,
        datum: { kind: "bytes", bytes: new Uint8Array([1]) },
        terms: terms(0, payee),
        attestation,
      }),
    ).rejects.toThrow(/namespace/);
    expect(() => agent.planEnroll()).toThrow(scoped);
    expect(() => agent.planAttest()).toThrow(scoped);
    expect(() =>
      agent.planGrant({
        granteeCard: ZERO_HASH,
        granteeEncryptionPubKey: ZERO_HASH,
        ns: 1,
        termsHash: ZERO_HASH,
        term: 1n,
      }),
    ).toThrow(scoped);
    expect(() => agent.planRescind(ZERO_HASH)).toThrow(scoped);
    agent.close();
    owner.close();
  });

  it("is refused past its epoch and on another chain", () => {
    const tree = KeyTree.fromPrf(new Uint8Array(32).fill(9));
    const code = encodeDelegation(
      issueDelegation(tree, {
        ns: 0,
        epoch: EPOCH,
        chainId: domain.chainId,
        expiresAt: epochs.genesis + (EPOCH + 1n) * epochs.length,
      }),
    );
    expect(() =>
      client().openDelegated(code, { now: () => epochs.genesis + (EPOCH + 1n) * epochs.length }),
    ).toThrow(expect.objectContaining({ code: "FH_DELEGATION_SCOPE" }));
    const elsewhere = encodeDelegation(
      issueDelegation(tree, { ns: 0, epoch: EPOCH, chainId: 1n, expiresAt: 9_999_999_999n }),
    );
    expect(() => client().openDelegated(elsewhere, { now: clock })).toThrow(/chain 1/);
  });
});
