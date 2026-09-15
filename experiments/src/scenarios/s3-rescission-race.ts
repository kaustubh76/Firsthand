import { createChainClients, OnchainGrantReader } from "@firsthand/adapters";
import { GrantManagerAbi } from "@firsthand/contracts/abi";
import type { Address, Bytes32, Terms } from "@firsthand/core";
import {
  deposit,
  planCommit,
  planDirectRescind,
  planRevealRescind,
  type RescindPlan,
  sendRescind,
} from "@firsthand/sdk";
import { decodeEventLog } from "viem";
import { type ArmAdapters, Arms, BTX_STATUS, resolveArm } from "../arms/index.js";
import { Extractor } from "../bots/Extractor.js";
import { BlindFeed, TxpoolPollingFeed } from "../bots/MempoolFeed.js";
import { commitTrigger, ObserverBot, rescindTrigger } from "../bots/ObserverBot.js";
import { SimObserverBot } from "../bots/SimObserverBot.js";
import { AnvilMiner } from "../chain/anvilMiner.js";
import { isAnvil } from "../chain/rpc.js";
import { waitForReceipt } from "../chain/waitReceipt.js";
import {
  buyerAccount,
  grantTo,
  mintUsdc,
  newBuyer,
  registerAndAccept,
  requirementsFor,
} from "../demand/setup.js";
import type { RunContext, Scenario } from "../harness/Runner.js";
import { type RaceSample, summarise } from "../metrics/raceWindow.js";
import { ATTESTATION, datumBytes, seededLocker, termsFor } from "./common.js";

/**
 * S3 — adversarial rescission (README §15 H2). An observer bot with mempool visibility races a bulk
 * extraction against the rescind broadcast; 50 trials per arm. On chain the outcome is chain truth:
 * consent ends at the rescission's inclusion (the commit block for commit-reveal) and an extraction
 * counts only if it was ordered before that point — `(block, index)`, not wall clock. Blocks are
 * mined every 400 ms (Monad's cadence) by the harness, automine restored afterwards.
 *
 * Arms: B2-public-mempool (bot sees the rescind), commit-reveal (bot sees an unattributable commit
 * and reacts to every one), btx-blind (NOT BTX — the bot has no signal and extracts continuously:
 * the bound an encrypted mempool leaves), btx (real BtxTransport; skipped until BTX exists), memory (sim).
 */
const BLOCK_MS = 400;
const BURST = 4; // settle txs the signalled bot fires
const BLIND_EVERY_MS = 60; // cadence of the no-signal extractor
const PRICE = 1_000n;

export const s3: Scenario = {
  id: "s3",
  hypothesis: "H2",
  arms: [Arms.MEMORY, Arms.B2_PUBLIC_MEMPOOL, Arms.COMMIT_REVEAL, Arms.BTX_BLIND, Arms.BTX],
  async run(arm: string, ctx: RunContext) {
    const trials = ctx.dryRun ? Math.min(ctx.n, 3) : ctx.n;
    if (arm === Arms.MEMORY) return simulated(trials, ctx);
    const adapters = await resolveArm(arm);
    if (!adapters.chain?.clients.walletClient) throw new Error("S3: chain arm without a wallet");
    return onChain(arm as Exclude<typeof arm, typeof Arms.MEMORY>, adapters, trials, ctx);
  },
};

/** The timing-only model, kept for the unit tests and as the arm's baseline expectation. */
async function simulated(trials: number, ctx: RunContext) {
  const bot = new SimObserverBot({ seesMempool: true, extractionMs: 300 });
  const samples: RaceSample[] = [];
  for (let i = 0; i < trials; i++) {
    samples.push(
      await bot.race({
        rescindBroadcastMs: ctx.clock.nowMs(),
        inclusionDelayMs: BLOCK_MS,
        clock: ctx.clock,
      }),
    );
  }
  return {
    ...metricsOf(samples, Arms.MEMORY),
    onChain: false,
    notes: [
      "SIMULATED public mempool — the timing model only; H2 evidence is the on-chain arms below.",
    ],
  };
}

async function onChain(arm: string, adapters: ArmAdapters, trials: number, ctx: RunContext) {
  const chain = adapters.chain;
  if (!chain?.clients.walletClient) throw new Error("wallet");
  const { clients, deployment, env } = chain;
  const relayer = clients.walletClient;
  if (!relayer) throw new Error("wallet");
  const publicClient = clients.publicClient;
  const grantManager = deployment.GrantManager.toLowerCase() as Address;
  const rescissions = deployment.Rescissions.toLowerCase() as Address;
  const router = deployment.RoyaltyRouter.toLowerCase() as Address;
  const usdc = deployment.USDC.toLowerCase() as Address;
  const addresses = {
    grantManager,
    rescissions,
    principalRegistry: deployment.PrincipalRegistry.toLowerCase() as Address,
  };
  const wait = (hash: Bytes32) => waitForReceipt(publicClient, hash);
  const miner = (await isAnvil(env.rpcUrl))
    ? new AnvilMiner(env.rpcUrl, () => ctx.clock.nowMs())
    : null;

  // Supply side once per arm: an enrolled, attested principal with one anchored passport.
  const { locker, batcher } = seededLocker(3, adapters, ctx.clock, 1);
  await adapters.prepare(locker);
  const terms: Terms = { ...termsFor(locker), price: PRICE, rateLimit: 0 };
  await deposit(locker, batcher, {
    ns: 0,
    datum: { kind: "bytes", bytes: datumBytes(3) },
    terms,
    attestation: ATTESTATION,
  });
  const reader = new OnchainGrantReader({
    publicClient,
    grantManager,
    principalRegistry: addresses.principalRegistry,
    receiptLedger: deployment.ReceiptLedger.toLowerCase() as Address,
  });

  // The bot: the grantee's own funded key, its own fast-polling clients.
  const botClients = createChainClients({
    rpcUrl: env.rpcUrl,
    chain: clients.chain,
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    pollingInterval: 25,
  });
  if (!botClients.walletClient) throw new Error("bot wallet");
  const bot = buyerAccount();
  const perTrialQueries = arm === Arms.BTX_BLIND ? Math.ceil(10_000 / BLIND_EVERY_MS) : BURST;
  await mintUsdc(
    relayer,
    publicClient,
    usdc,
    bot.address,
    PRICE * BigInt(perTrialQueries * trials + 10),
  );

  const samples: RaceSample[] = [];
  for (let i = 0; i < trials; i++) {
    // A fresh card → a fresh grant id in the same epoch. Setup runs under automine.
    const buyer = newBuyer({
      grantManager,
      chainId: BigInt(deployment.chainId),
      transport: adapters.transport,
    });
    const termsHash = await registerAndAccept(buyer, locker.principalId, terms, wait);
    const grantId = await grantTo({
      locker,
      grantManager,
      transport: adapters.transport,
      buyer,
      termsHash,
      ns: 0,
      term: 4n,
      wait,
    });
    const requirements = requirementsFor({
      payTo: router,
      asset: usdc,
      chainId: BigInt(deployment.chainId),
      price: PRICE,
      chainTime: await reader.chainTime(),
      resource: `firsthand://s3/${i}`,
    });
    const extractor = new Extractor({
      wallet: botClients.walletClient,
      publicClient: botClients.publicClient,
      router,
      grantId,
      terms,
      requirements,
      clock: ctx.clock,
    });
    await extractor.prepare(BURST);

    const feed =
      arm === Arms.BTX_BLIND || arm === Arms.BTX
        ? new BlindFeed()
        : new TxpoolPollingFeed({ rpcUrl: env.rpcUrl, intervalMs: 20 });
    const observer = new ObserverBot({
      feed,
      trigger:
        arm === Arms.COMMIT_REVEAL
          ? commitTrigger(rescissions)
          : rescindTrigger(grantManager, grantId),
      onTrigger: () => extractor.burst(BURST),
      clock: ctx.clock,
    });

    const race = async () => {
      observer.arm();
      if (arm === Arms.BTX_BLIND) {
        extractor.continuous(BLIND_EVERY_MS);
        await new Promise((r) => setTimeout(r, BLOCK_MS)); // the blind bot is already extracting when consent ends
      }
      const plan: RescindPlan =
        arm === Arms.COMMIT_REVEAL
          ? planCommit(addresses, grantId)
          : planDirectRescind(locker, arm === Arms.BTX ? "btx" : "public", addresses, grantId);
      const sent = await sendRescind(locker, adapters.transport, plan);
      // One time base for the whole race: the harness clock (the transport's submittedAt is epoch ms).
      const broadcastMs = ctx.clock.nowMs();
      const receipt = await wait(sent.txHash);
      const effective = { block: receipt.blockNumber, index: receipt.transactionIndex };
      if (arm === Arms.COMMIT_REVEAL) {
        if (!plan.salt) throw new Error("commit plan without salt");
        const reveal = planRevealRescind(locker, addresses, grantId, plan.salt);
        const revealed = await wait((await sendRescind(locker, adapters.transport, reveal)).txHash);
        const ev = revealed.logs
          .map((log) => {
            try {
              return decodeEventLog({ abi: GrantManagerAbi, data: log.data, topics: log.topics });
            } catch {
              return null;
            }
          })
          .find((e) => e?.eventName === "GrantRescinded");
        const effectiveBlock = (ev?.args as { effectiveBlock?: bigint } | undefined)
          ?.effectiveBlock;
        if (effectiveBlock !== receipt.blockNumber)
          throw new Error("S3: commit block is not the effective block");
      }
      extractor.stopContinuous();
      await observer.disarm();
      await new Promise((r) => setTimeout(r, BLOCK_MS * 2)); // let the trailing sends land
      await extractor.collect();
      return { broadcastMs, effective };
    };
    const { broadcastMs, effective } = miner
      ? await miner.withIntervalMining(BLOCK_MS, race)
      : await race();

    // Outcome from chain order. Time base: the harness's own block clock (wall clock when it sealed
    // the block); off anvil, the receipt-observation time.
    const timeOf = (block: bigint, observedMs: number | null) =>
      miner?.blockMinedAt.get(block) ?? observedMs ?? ctx.clock.nowMs();
    const before = extractor.attempts.filter(
      (a) =>
        a.status === "success" &&
        a.blockNumber !== null &&
        a.transactionIndex !== null &&
        (arm !== Arms.BTX_BLIND || a.sentAt >= broadcastMs) &&
        (a.blockNumber < effective.block ||
          (a.blockNumber === effective.block && a.transactionIndex < effective.index)),
    );
    const first = before
      .map((a) => timeOf(a.blockNumber as bigint, a.minedAtMs))
      .sort((x, y) => x - y)[0];
    const after = extractor.attempts.filter(
      (a) =>
        a.status === "success" &&
        a.blockNumber !== null &&
        (a.blockNumber > effective.block ||
          (a.blockNumber === effective.block && (a.transactionIndex ?? 0) > effective.index)),
    ).length;
    samples.push({
      rescindBroadcastMs: broadcastMs,
      rescindEffectiveMs: timeOf(effective.block, null),
      extractionCompleteMs: first ?? null,
      detectionMs: observer.detectedAtMs,
      extractions: before.length,
      queriesPaid: extractor.attempts.filter((a) => a.status === "success").length,
      settlementsAfterConsentEnd: after,
    });
    ctx.logger.debug("s3 trial", {
      arm,
      trial: i,
      extractions: before.length,
      after,
      attempts: extractor.attempts.length,
      detected: observer.detectedAtMs === null ? null : observer.detectedAtMs - broadcastMs,
    });
  }
  if (miner && !(await miner.automine())) throw new Error("S3: automine not restored");

  return {
    ...metricsOf(samples, arm),
    onChain: true,
    notes: notesFor(arm),
  };
}

function metricsOf(samples: RaceSample[], arm: string) {
  const s = summarise(samples);
  const opt = (v: number | null) => (v === null ? {} : { value: v });
  return {
    metrics: {
      trials: { value: s.n, unit: "count" },
      extractionSuccessRate: { value: s.successRate, unit: "ratio" },
      ...(s.p50 === null ? {} : { deltaRaceP50Ms: { ...opt(s.p50), value: s.p50, unit: "ms" } }),
      ...(s.p95 === null ? {} : { deltaRaceP95Ms: { value: s.p95, unit: "ms" } }),
      ...(s.min === null ? {} : { deltaRaceMinMs: { value: s.min, unit: "ms" } }),
      ...(s.max === null ? {} : { deltaRaceMaxMs: { value: s.max, unit: "ms" } }),
      ...(s.detectionLatencyP50 === null
        ? {}
        : { detectionLatencyP50Ms: { value: s.detectionLatencyP50, unit: "ms" } }),
      inclusionDelayP50Ms: { value: s.inclusionDelayP50, unit: "ms" },
      extractionsBeforeEndP50: { value: s.extractionsP50, unit: "count" },
      queriesPaidP50: { value: s.queriesPaidP50, unit: "count" },
      ...(arm === Arms.COMMIT_REVEAL
        ? { settlementsAfterCommit: { value: s.settlementsAfterConsentEnd, unit: "count" } }
        : {}),
    },
    samples: { deltaRaceMs: [...s.deltas] },
  };
}

function notesFor(arm: string): string[] {
  const common =
    "Success = an extraction ordered before the effective point on chain ((block, index), not wall clock); blocks every 400 ms; Δ_race = block time of the first such extraction − broadcast.";
  switch (arm) {
    case Arms.B2_PUBLIC_MEMPOOL:
      return [
        common,
        "B2: the bot decodes the pending rescind for this grant and fires a burst that outbids it.",
      ];
    case Arms.COMMIT_REVEAL:
      return [
        common,
        "commit-reveal: consent ends at the commit block; the bot cannot attribute the commitment, so it reacts to every commit it sees (paranoid). settlementsAfterCommit are post-consent receipts — accountability, not prevention.",
      ];
    case Arms.BTX_BLIND:
      return [
        common,
        "btx-blind is NOT BTX: the rescind travels the public mempool but the bot gets no signal and extracts continuously, paying for every query. Only extractions *sent after* the broadcast count. This is the bound an encrypted mempool leaves: it removes the signal, not same-block fee competition.",
      ];
    case Arms.BTX:
      return [common, `btx: real BtxTransport. ${BTX_STATUS}.`];
    default:
      return [common];
  }
}
