import {
  buildPaymentPayload,
  type GrantReader,
  MemoryConsentLedger,
  MemoryGrantReader,
  MemorySettlement,
  OnchainGrantReader,
  OnchainSettlement,
  type Settlement,
} from "@firsthand/adapters";
import {
  type Address,
  type Bytes32,
  ChainError,
  GrantError,
  hashTerms,
  type Terms,
  verifyPredicate,
} from "@firsthand/core";
import {
  deposit,
  exportManifest,
  planDirectRescind,
  sendRescind,
  sidecarFor,
  verifyManifest,
} from "@firsthand/sdk";
import { Arms, resolveArm } from "../arms/index.js";
import {
  buyerAccount,
  grantTo,
  mintUsdc,
  newBuyer,
  registerAndAccept,
  requirementsFor,
} from "../demand/setup.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { percentile } from "../metrics/stats.js";
import { ATTESTATION, datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S2 — buyer loop (README §15): grant → N paid queries → manifest with receipts. Each query runs the
 * serving path's core (verify() → x402 payment → settle → receipt) without HTTP, so the numbers are
 * settlement gas and predicate latency; the HTTP surface is covered by the gateway's live-chain gate.
 * Memory arm uses the accounting double; `anchors-baseline` runs RoyaltyRouter.settle for real.
 */

export const s2: Scenario = {
  id: "s2",
  hypothesis: "H1",
  arms: [Arms.MEMORY, Arms.ANCHORS_BASELINE],
  async run(arm: string, ctx: RunContext) {
    const adapters = await resolveArm(arm);
    const { locker, batcher } = seededLocker(1, adapters, ctx.clock, 1);
    await adapters.prepare(locker);
    const baseTerms = termsFor(locker);
    const terms: Terms = { ...baseTerms, price: 1_000n, rateLimit: 0 };
    const n = ctx.dryRun ? Math.min(ctx.n, 5) : ctx.n;

    // One passport, N queries against it (the market prices continuing access, README §14).
    const r = await deposit(locker, batcher, {
      ns: 0,
      datum: { kind: "bytes", bytes: datumBytes(0) },
      terms,
      attestation: ATTESTATION,
    });
    const sidecar = sidecarFor(locker, batcher, r, terms);

    // Buyer, grant reader and settlement per arm.
    const buyer = buyerAccount();
    let grants: GrantReader;
    let settlement: Settlement;
    let grantId: Bytes32;
    let payTo: Address;
    let asset: Address;
    const chainId = adapters.domain?.chainId ?? 10143n;

    if (adapters.chain) {
      const { clients, deployment } = adapters.chain;
      if (!clients.walletClient) throw new Error("relayer wallet");
      const grantManager = deployment.GrantManager.toLowerCase() as Address;
      const session = newBuyer({
        grantManager,
        chainId,
        transport: adapters.transport,
        granteeSeed: new Uint8Array(32).fill(7),
      });
      const wait = (hash: Bytes32) => clients.publicClient.waitForTransactionReceipt({ hash });
      await mintUsdc(
        clients.walletClient,
        clients.publicClient,
        deployment.USDC.toLowerCase() as Address,
        buyer.address,
        BigInt(n) * 1_000n + 1_000n,
      );
      // The relayer submits the buyer-signed acceptance (relayable) so one account drives all txs.
      const termsHash = await registerAndAccept(session, locker.principalId, terms, wait);
      grantId = await grantTo({
        locker,
        grantManager,
        transport: adapters.transport,
        buyer: session,
        termsHash,
        ns: 0,
        term: 4n,
        wait,
      });
      grants = new OnchainGrantReader({
        publicClient: clients.publicClient,
        grantManager,
        principalRegistry: deployment.PrincipalRegistry.toLowerCase() as Address,
        receiptLedger: deployment.ReceiptLedger.toLowerCase() as Address,
      });
      settlement = new OnchainSettlement({
        router: deployment.RoyaltyRouter.toLowerCase() as Address,
        receiptLedger: deployment.ReceiptLedger.toLowerCase() as Address,
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
      });
      payTo = deployment.RoyaltyRouter.toLowerCase() as Address;
      asset = deployment.USDC.toLowerCase() as Address;
    } else {
      const mg = new MemoryGrantReader({ epoch: locker.currentEpoch() });
      const ledger = new MemoryConsentLedger();
      mg.enroll(locker.principalId);
      const cardId = mg.registerCard(
        buyer.address.toLowerCase() as Address,
        newBuyer({
          grantManager: `0x${"b1".repeat(20)}`,
          chainId,
          transport: adapters.transport,
          granteeSeed: new Uint8Array(32).fill(7),
        }).encryptionPubKey,
      );
      const th = mg.acceptTerms(cardId, locker.principalId, terms);
      grantId = mg.grant({
        principalId: locker.principalId,
        granteeCard: cardId,
        ns: 0,
        termsHash: th,
        wrapRef: `0x${"00".repeat(32)}`,
      });
      grants = mg;
      settlement = new MemorySettlement(mg, ledger);
      payTo = `0x${"aa".repeat(20)}`;
      asset = `0x${"dc".repeat(20)}`;
    }

    const requirements = requirementsFor({
      payTo,
      asset,
      chainId,
      price: terms.price,
      chainTime: await grants.chainTime(),
      resource: "firsthand://s2",
    });

    // The loop: verify → pay → settle, timed.
    const latencies: number[] = [];
    const gas: bigint[] = [];
    const receiptIds = new Set<Bytes32>();
    let last: Awaited<ReturnType<Settlement["settle"]>> | null = null;
    for (let i = 0; i < n; i++) {
      const t0 = ctx.clock.nowMs();
      const g = await grants.grantState(grantId);
      if (!g) throw new Error("S2: grant vanished");
      const [rootAnchored, owner, liveness, epochNow] = await Promise.all([
        adapters.anchors.isAnchored(sidecar.batchRoot),
        adapters.anchors.anchorOf(sidecar.batchRoot),
        grants.principalLiveness(g.principalId),
        grants.currentEpoch(),
      ]);
      const verdict = verifyPredicate({
        passport: sidecar.signed.passport,
        signature: sidecar.signed.signature,
        domain: locker.domain,
        proof: sidecar.proof,
        batchRoot: sidecar.batchRoot,
        rootAnchored,
        ...(owner ? { anchorOwner: { principalId: owner.principalId, ns: owner.ns } } : {}),
        grant: {
          status: g.status,
          epochStart: g.epochStart,
          term: g.term,
          termsHash: g.termsHash,
          principalId: g.principalId,
          ns: g.ns,
        },
        principal: liveness ?? { lastAttestedEpoch: -1n },
        epochNow,
      });
      if (!verdict.ok) throw new Error(`S2: verify failed: ${verdict.reason}`);
      const payment = await buildPaymentPayload(buyer, requirements);
      const settled = await settlement.settle({ grantId, terms, payment });
      latencies.push(ctx.clock.nowMs() - t0);
      if (settled.gasUsed !== null) gas.push(settled.gasUsed);
      receiptIds.add(settled.receiptId);
      last = settled;
    }

    // Manifest with the last receipt attached, verified against the arm's anchors.
    const manifest = exportManifest({
      domain: locker.domain,
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
                  receiptId: last.receiptId,
                  grantId,
                  payer: last.payer,
                  ns: 0,
                  termsHash: hashTerms(terms),
                  epoch: await grants.currentEpoch(),
                  blockNumber: last.blockNumber ?? 0n,
                  txHash: last.txHash ?? (`0x${"00".repeat(32)}` as Bytes32),
                },
              ],
            ]),
          }
        : {}),
    });
    const verdict = await verifyManifest(
      manifest,
      { anchors: adapters.anchors, headBlock: await adapters.headBlock() },
      { signatures: "all" },
    );

    // Rescind (direct path over the arm's transport) and confirm the next settlement is refused.
    let refusedAfterRescind = false;
    if (adapters.chain) {
      const { clients, deployment } = adapters.chain;
      const sent = await sendRescind(
        locker,
        adapters.transport,
        planDirectRescind(
          locker,
          "public",
          {
            grantManager: deployment.GrantManager.toLowerCase() as Address,
            rescissions: deployment.Rescissions.toLowerCase() as Address,
          },
          grantId,
        ),
      );
      await clients.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
    } else {
      (grants as MemoryGrantReader).rescind(grantId);
    }
    try {
      await settlement.settle({
        grantId,
        terms,
        payment: await buildPaymentPayload(buyer, requirements),
      });
    } catch (error) {
      refusedAfterRescind = error instanceof GrantError || error instanceof ChainError;
    }

    const totalGas = gas.reduce((a, b) => a + b, 0n);
    return {
      metrics: {
        queries: { value: n, unit: "count" },
        receiptsRecorded: { value: receiptIds.size, unit: "count" },
        queryLatencyP50Ms: { value: percentile(latencies, 50), unit: "ms" },
        queryLatencyP95Ms: { value: percentile(latencies, 95), unit: "ms" },
        manifestWithReceiptsVerified: { value: verdict.ok ? 1 : 0, unit: "bool" },
        refusedAfterRescind: { value: refusedAfterRescind ? 1 : 0, unit: "bool" },
        ...(gas.length > 0
          ? { settleGasPerQuery: { value: Number(totalGas / BigInt(gas.length)), unit: "gas" } }
          : {}),
      },
      onChain: adapters.onChain,
      notes: [
        adapters.onChain
          ? "settleGasPerQuery = RoyaltyRouter.settle (EIP-3009 pull + split + receipt) on a vanilla EVM; Monad pricing applies on testnet."
          : "Memory arm: accounting double, no token movement; latency is predicate + payment signing.",
        "Each query is one receipt; the last receipt rides in the exported manifest (H3 audit file).",
      ],
    };
  },
};
